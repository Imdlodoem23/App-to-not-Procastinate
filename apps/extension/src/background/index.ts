/**
 * Background of the Céntrate extension: the service worker in Chromium and the event page
 * in Firefox (the same file through `background.scripts`).
 *
 * - Re-applies the last verified rules as soon as it starts (storage.ts), then keeps them
 *   in sync with a long poll on `/v1/ext/rules` (client.ts). MV3 suspends idle workers: a
 *   30 s `chrome.alarms` tick restarts the loop and sends the heartbeat (heartbeat.ts).
 * - Without the guardian the cached rules stay in force until each block's `endsAt`
 *   (state.ts); a one-shot alarm re-evaluates them when something ends.
 * - Pages (popup, blocked.html, the guide) talk to it through the typed messages in
 *   state.ts; pairing lives in pairing.ts.
 * - Enforcement modules (declarativeNetRequest rules, attempt reporting) are plugins
 *   (`registerBackgroundPlugin` in state.ts): import them below so they register before
 *   the worker starts.
 * - A stored rules record that no longer parses (an update that tightened validation,
 *   corruption) never clears the browser's rules: they stay until the latest block end
 *   still readable in it, or until a verified response replaces them (storage.ts).
 *
 * Incognito. Chromium only loads an extension's own pages in incognito tabs in `split`
 * mode (with `spanning` the redirect to blocked.html ends on an error page and no attempt
 * commits), so the Chromium manifest uses `split` (build.mjs; Firefox has no split mode and
 * keeps `spanning`). Chromium then runs this file a second time, for incognito windows
 * (`chrome.extension.inIncognitoContext`). That instance shares `chrome.storage`, its
 * change events and the dynamic rules with the main one, but only sees incognito tabs. It
 * is a `follower`: it runs the plugins' listeners (attempts, blocked.html) and answers its
 * pages from the shared storage, with the link the main instance recorded, but never
 * syncs, sends heartbeats or touches the dynamic rules (two appliers would race). It asks
 * the main instance to sync through `STORAGE_KEYS.syncRequest`; a pairing claimed there
 * reaches the main instance as a storage change.
 */

import { normalizeDomain } from '@centrate/shared/catalog';
import type { AttemptResponse, ExtRulesResponse } from '@centrate/shared/guardian-api';
import type { BackgroundContext, RulesLoop, RulesLoopOptions } from './client';
import {
  createExtensionClient,
  createRulesLoop,
  describeError,
  linkForError,
  linkFromStatus,
  markUnauthorized,
} from './client';
import type { HeartbeatOutcome } from './heartbeat';
import { detectBrowser, extensionVersion, readCapabilities, sendHeartbeat } from './heartbeat';
import { pairWithCode } from './pairing';
import type {
  BackgroundApi,
  BackgroundPlugin,
  BackgroundRequest,
  BackgroundResponses,
  BackgroundFailure,
  BrowserInfo,
  Capabilities,
  ExtensionStateSnapshot,
  GuardianLink,
  GuideSection,
  StateChangedMessage,
} from './state';
import {
  GUIDE_PAGE,
  HEARTBEAT_MIN_INTERVAL_MS,
  MESSAGE_TYPES,
  TICK_PERIOD_MINUTES,
  backgroundPlugins,
  buildSnapshot,
  computeEffectiveRules,
  linkTrustsRules,
  matchHost,
  nextRulesChangeAt,
  parseBackgroundRequest,
} from './state';
import type { BackgroundStore } from './storage';
import { STORAGE_KEYS, chromeLocalArea, createBackgroundStore } from './storage';

// Enforcement plugins register themselves on import (`registerBackgroundPlugin`), in this
// order: the declarativeNetRequest rules, then attempt reporting (which follows DNR changes).
import './dnr';
import './attempts';

export const ALARMS = Object.freeze({
  tick: 'centrate.tick',
  rulesChange: 'centrate.rules-change',
});

/** Browser-specific effects, so the background logic runs in tests with fakes. */
export interface BackgroundPlatform {
  /** `chrome.runtime.id`: only messages from this extension are answered. */
  extensionId: string;
  extVersion: string;
  browser(): Promise<BrowserInfo>;
  capabilities(): Promise<Capabilities>;
  /** Creates the periodic tick alarm unless it exists. */
  ensureTick(): Promise<void>;
  /** One-shot alarm at `at` (epoch ms), or none with `null`. */
  scheduleRulesChange(at: number | null): Promise<void>;
  /** Sends the snapshot to open pages (errors ignored: often nobody listens). */
  broadcast(message: StateChangedMessage): void;
  openGuide(section: GuideSection | undefined): Promise<void>;
}

/**
 * `main`: syncs, heartbeats and applies the rules (every browser). `follower`: Chromium's
 * incognito instance in split mode (see the module comment).
 */
export type BackgroundRole = 'main' | 'follower';

export interface BackgroundOptions {
  store: BackgroundStore;
  platform: BackgroundPlatform;
  plugins?: readonly BackgroundPlugin[];
  fetch?: typeof fetch;
  now?: () => number;
  loop?: RulesLoopOptions;
  /** Default `main`. */
  role?: BackgroundRole;
}

type AnyResponse = BackgroundResponses[keyof BackgroundResponses] | BackgroundFailure;

export interface Background {
  readonly ctx: BackgroundContext;
  readonly api: BackgroundApi;
  readonly loop: RulesLoop;
  /** Calls each plugin's `start` (synchronously, so their listeners are top-level). */
  startPlugins(): void;
  /** Re-applies the cached rules, then starts the sync loop and a heartbeat. */
  start(): Promise<void>;
  /** The 30 s alarm. */
  tick(): Promise<void>;
  /** The one-shot alarm: a cached block, allowance or punishment ends. */
  rulesChangeDue(): Promise<void>;
  /** Host permission or incognito access may have changed. */
  capabilitiesChanged(): Promise<void>;
  /** A runtime message; `undefined` when it is not for the background. */
  handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> | undefined;
  handleRequest(request: BackgroundRequest): Promise<AnyResponse>;
  /**
   * Applies the rules in force to every plugin (serialized, skipped when unchanged); a
   * follower hands them to `followRules` instead.
   */
  refreshRules(): Promise<void>;
  /** `chrome.storage.onChanged` in the `local` area (either instance may have written). */
  storageChanged(keys: readonly string[]): Promise<void>;
  heartbeat(force: boolean): Promise<HeartbeatOutcome>;
  /** `extRulesVersion` of the rules the appliers accepted last (0: none). */
  appliedVersion(): number;
}

/** Stable fingerprint of rules (the nonce and `serverNow` change on every response). */
function fingerprint(rules: ExtRulesResponse | null): string {
  return rules === null ? 'null' : JSON.stringify({ ...rules, nonce: '', serverNow: '' });
}

/** Within this delay a timer backs the one-shot alarm (Chrome delays alarms to ≥ 30 s). */
const SHORT_TIMER_MS = 60_000;

export function createBackground(options: BackgroundOptions): Background {
  const { store, platform } = options;
  const plugins = options.plugins ?? backgroundPlugins();
  const now = options.now ?? (() => Date.now());
  const follower = options.role === 'follower';
  let link: GuardianLink = 'unknown';
  /** The claim this instance last saw (another instance may pair). */
  let knownPairing: string | null | undefined;
  let applied = { fingerprint: null as string | null, version: 0 };
  let applying: Promise<void> = Promise.resolve();
  let beating: Promise<HeartbeatOutcome> | null = null;
  let beatAgain = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  const ctx: BackgroundContext = {
    store,
    now,
    fetch: options.fetch,
    getLink: () => link,
    setLink: (next) => {
      link = next;
    },
    async changed(what) {
      if (what !== 'status') await refreshRules();
      if (what === 'rules' && !follower) void heartbeat(true);
      scheduleBroadcast();
    },
  };

  const loop = createRulesLoop(ctx, options.loop);

  function scheduleChangeTimer(at: number | null): void {
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = null;
    if (at === null) return;
    const delay = at - now();
    if (delay > SHORT_TIMER_MS) return;
    changeTimer = setTimeout(
      () => {
        changeTimer = null;
        void rulesChangeDue();
      },
      Math.max(0, delay) + 250,
    );
  }

  async function scheduleChange(at: number | null): Promise<void> {
    scheduleChangeTimer(at);
    if (!follower) await platform.scheduleRulesChange(at).catch(() => undefined);
  }

  /** A follower hands the rules in force to `followRules` (never to `applyRules`). */
  async function followRules(effective: ExtRulesResponse | null): Promise<void> {
    const print = fingerprint(effective);
    if (print === applied.fingerprint) return;
    applied = { fingerprint: print, version: effective?.extRulesVersion ?? 0 };
    for (const plugin of plugins) {
      try {
        await plugin.followRules?.(effective);
      } catch (error) {
        console.error(`Céntrate: ${plugin.name} could not follow the rules`, error);
      }
    }
  }

  function refreshRules(): Promise<void> {
    const run = applying.then(async () => {
      if (follower) link = linkFromStatus(await store.getStatus());
      const record = await store.getRules();
      const nowMs = now();
      if (record === null && !follower) {
        // A stored record that no longer parses is not «no rules»: keep what the browser
        // enforces until its latest readable end (or a verified body), and report nothing
        // as applied so the guardian asks for a sync.
        const unreadable = await store.getUnreadableRules();
        const until = unreadable?.holdUntil;
        if (unreadable !== null && (until === null || (until !== undefined && until > nowMs))) {
          await scheduleChange(until ?? null);
          applied = { fingerprint: null, version: 0 };
          return;
        }
      }
      const effective = computeEffectiveRules(record, nowMs, linkTrustsRules(link));
      await scheduleChange(nextRulesChangeAt(record, nowMs));
      if (follower) {
        await followRules(effective);
        return;
      }
      const print = fingerprint(effective);
      if (print === applied.fingerprint) return;
      const appliers = plugins.filter((p) => p.applyRules !== undefined);
      let ok = appliers.length > 0;
      for (const plugin of appliers) {
        try {
          await plugin.applyRules?.(effective);
        } catch (error) {
          ok = false;
          console.error(`Céntrate: ${plugin.name} could not apply the rules`, error);
        }
      }
      applied = ok
        ? { fingerprint: print, version: effective?.extRulesVersion ?? 0 }
        : { fingerprint: null, version: applied.version };
    });
    applying = run.catch(() => undefined);
    return run;
  }

  /**
   * One heartbeat at a time. A forced one requested meanwhile (a rules change) runs right
   * after, so the guardian always hears the version applied last.
   */
  function heartbeat(force: boolean): Promise<HeartbeatOutcome> {
    if (beating !== null) {
      if (force) beatAgain = true;
      return beating;
    }
    beating = (async (): Promise<HeartbeatOutcome> => {
      if (!force) {
        const { lastHeartbeatAt } = await store.getStatus();
        if (lastHeartbeatAt !== null && now() - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
          return 'sent';
        }
      }
      return sendHeartbeat(ctx, {
        browser: () => platform.browser(),
        capabilities: () => platform.capabilities(),
        extVersion: platform.extVersion,
        appliedExtRulesVersion: () => applied.version,
        rulesOutdated: () => loop.ensureRunning(),
      });
    })()
      .catch((): HeartbeatOutcome => 'error')
      .finally(() => {
        beating = null;
        if (beatAgain) {
          beatAgain = false;
          void heartbeat(true);
        }
      });
    return beating;
  }

  async function getSnapshot(): Promise<ExtensionStateSnapshot> {
    if (follower) link = linkFromStatus(await store.getStatus());
    const [pairing, record, status, capabilities, browser] = await Promise.all([
      store.getPairing(),
      store.getRules(),
      store.getStatus(),
      platform.capabilities().catch(() => null),
      platform.browser().catch(() => null),
    ]);
    return buildSnapshot({
      now: now(),
      pairing,
      record,
      status,
      link,
      browser,
      capabilities,
      extVersion: platform.extVersion,
    });
  }

  function scheduleBroadcast(): void {
    if (broadcastTimer !== null) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      getSnapshot().then(
        (state) => platform.broadcast({ type: MESSAGE_TYPES.stateChanged, state }),
        () => undefined,
      );
    }, 50);
  }

  async function getEffectiveRules(): Promise<ExtRulesResponse | null> {
    if (follower) link = linkFromStatus(await store.getStatus());
    return computeEffectiveRules(await store.getRules(), now(), linkTrustsRules(link));
  }

  async function reportAttempt(input: {
    host: string;
    incognito: boolean;
  }): Promise<AttemptResponse | null> {
    const pairing = await store.getPairing();
    const domain = normalizeDomain(input.host);
    if (pairing === null || pairing.unauthorizedAt !== null || domain === null) return null;
    const browser = await platform.browser();
    try {
      return await createExtensionClient(pairing, ctx.fetch).reportAttempt({
        layer: 'extension',
        target: { type: 'domain', value: domain },
        browser: browser.family,
        incognito: input.incognito,
      });
    } catch (error) {
      const failure = describeError(error, now());
      if (failure.status === 401) await markUnauthorized(ctx, pairing, failure.at);
      return null;
    }
  }

  const api: BackgroundApi = {
    getEffectiveRules,
    matchHost: async (host) => matchHost(await getEffectiveRules(), host.toLowerCase()),
    reportAttempt,
    getSnapshot,
    browser: () => platform.browser(),
  };

  async function rulesChangeDue(): Promise<void> {
    await refreshRules();
    if (!follower) loop.ensureRunning();
    scheduleBroadcast();
  }

  /** Sync and heartbeat now (the follower asks the main instance through storage). */
  async function syncNow(): Promise<void> {
    if (follower) {
      await store.requestSync(now()).catch(() => undefined);
      return;
    }
    loop.restart();
    void heartbeat(true);
  }

  /** The main instance notices a claim made elsewhere (the incognito instance's popup). */
  async function pairingChanged(): Promise<void> {
    const pairing = await store.getPairing();
    const id = pairing?.extensionId ?? null;
    if (knownPairing === undefined || id === knownPairing) {
      knownPairing = id;
      return;
    }
    knownPairing = id;
    link = 'unknown';
    await ctx.changed('pairing');
    if (!follower && pairing !== null) loop.restart();
  }

  async function storageChanged(keys: readonly string[]): Promise<void> {
    store.invalidate(keys);
    if (keys.includes(STORAGE_KEYS.pairing)) await pairingChanged();
    if (follower) {
      if (keys.some((k) => k === STORAGE_KEYS.rules || k === STORAGE_KEYS.status)) {
        await refreshRules();
      }
      scheduleBroadcast();
      return;
    }
    if (keys.includes(STORAGE_KEYS.syncRequest)) await syncNow();
  }

  async function handleRequest(request: BackgroundRequest): Promise<AnyResponse> {
    switch (request.type) {
      case MESSAGE_TYPES.getState:
        return { ok: true, state: await getSnapshot() };
      case MESSAGE_TYPES.refresh:
        await syncNow();
        return { ok: true, state: await getSnapshot() };
      case MESSAGE_TYPES.openGuide:
        await platform.openGuide(request.section);
        return { ok: true };
      case MESSAGE_TYPES.pair: {
        const outcome = await pairWithCode(
          ctx,
          { browser: () => platform.browser(), extVersion: platform.extVersion },
          request.port === undefined ? { code: request.code } : request,
        );
        if (!outcome.ok) {
          return { ok: false, error: outcome.error, retryAfterSeconds: outcome.retryAfterSeconds };
        }
        knownPairing = outcome.pairing.extensionId;
        // A follower's claim reaches the main instance as a storage change.
        if (!follower) loop.restart();
        return { ok: true, state: await getSnapshot() };
      }
    }
  }

  function handleMessage(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> | undefined {
    if (sender.id !== platform.extensionId) return undefined;
    const request = parseBackgroundRequest(message);
    if (request !== null) return handleRequest(request);
    for (const plugin of plugins) {
      const reply = plugin.handleMessage?.(message, sender);
      if (reply !== undefined) return reply;
    }
    const type = (message as { type?: unknown } | null)?.type;
    if (
      typeof type === 'string' &&
      type.startsWith('centrate/') &&
      type !== MESSAGE_TYPES.stateChanged
    ) {
      return Promise.resolve({ ok: false, error: 'bad_request' } satisfies BackgroundFailure);
    }
    return undefined;
  }

  return {
    ctx,
    api,
    loop,
    startPlugins() {
      for (const plugin of plugins) {
        try {
          plugin.start?.(api);
        } catch (error) {
          console.error(`Céntrate: ${plugin.name} did not start`, error);
        }
      }
    },
    async start() {
      knownPairing = (await store.getPairing().catch(() => null))?.extensionId ?? null;
      if (follower) {
        await refreshRules();
        return;
      }
      // A worker that wakes up after the guardian stopped answering starts from that state,
      // so blocks that ended meanwhile are not re-applied until the first request fails.
      const status = await store.getStatus().catch(() => null);
      const error = status?.lastError ?? null;
      if (link === 'unknown' && error !== null && error.at > (status?.lastRulesAt ?? -1)) {
        link = linkForError(error);
      }
      await refreshRules();
      await platform.ensureTick().catch(() => undefined);
      loop.ensureRunning();
      void heartbeat(false);
    },
    async tick() {
      if (follower) return;
      // Catch a claim made by the incognito instance even if its storage event was missed.
      store.invalidate([STORAGE_KEYS.pairing]);
      await pairingChanged();
      loop.ensureRunning();
      await refreshRules();
      await heartbeat(false);
    },
    rulesChangeDue,
    async capabilitiesChanged() {
      scheduleBroadcast();
      if (!follower) await heartbeat(true);
    },
    handleMessage,
    handleRequest,
    refreshRules,
    storageChanged,
    heartbeat,
    appliedVersion: () => applied.version,
  };
}

// ---------------------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------------------

function chromePlatform(): BackgroundPlatform {
  return {
    extensionId: chrome.runtime.id,
    extVersion: extensionVersion(),
    browser: detectBrowser,
    capabilities: readCapabilities,
    async ensureTick() {
      const existing = await chrome.alarms.get(ALARMS.tick);
      if (existing?.periodInMinutes === TICK_PERIOD_MINUTES) return;
      await chrome.alarms.create(ALARMS.tick, {
        delayInMinutes: TICK_PERIOD_MINUTES,
        periodInMinutes: TICK_PERIOD_MINUTES,
      });
    },
    async scheduleRulesChange(at) {
      if (at === null) {
        await chrome.alarms.clear(ALARMS.rulesChange);
        return;
      }
      const when = Math.max(at + 1_000, Date.now() + 1_000);
      const existing = await chrome.alarms.get(ALARMS.rulesChange);
      if (existing !== undefined && Math.abs(existing.scheduledTime - when) < 1_000) return;
      await chrome.alarms.create(ALARMS.rulesChange, { when });
    },
    broadcast(message) {
      chrome.runtime.sendMessage(message).catch(() => undefined);
    },
    async openGuide(section) {
      const page = section === undefined ? GUIDE_PAGE : `${GUIDE_PAGE}#${section}`;
      await chrome.tabs.create({ url: chrome.runtime.getURL(page) });
    },
  };
}

/** Registers every listener synchronously (MV3 wakes the worker only for those). */
function startInBrowser(): Background {
  // Only Chromium's split mode runs an incognito instance (Firefox's is spanning).
  const follower = chrome.extension?.inIncognitoContext === true;
  const background = createBackground({
    store: createBackgroundStore(chromeLocalArea()),
    platform: chromePlatform(),
    role: follower ? 'follower' : 'main',
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') void background.storageChanged(Object.keys(changes));
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const reply = background.handleMessage(message, sender);
    if (reply === undefined) return false;
    reply.then(sendResponse, (error: unknown) => {
      console.error('Céntrate: message failed', error);
      sendResponse({ ok: false, error: 'internal' } satisfies BackgroundFailure);
    });
    return true;
  });
  if (follower) {
    background.startPlugins();
    void background.start();
    return background;
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARMS.tick) void background.tick();
    else if (alarm.name === ALARMS.rulesChange) void background.rulesChangeDue();
  });
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void background.handleRequest({ type: MESSAGE_TYPES.openGuide, section: 'pairing' });
    }
  });
  // Registering onStartup makes the browser start the worker at launch (the module-level
  // start below does the work).
  chrome.runtime.onStartup.addListener(() => undefined);
  chrome.permissions.onAdded.addListener(() => void background.capabilitiesChanged());
  chrome.permissions.onRemoved.addListener(() => void background.capabilitiesChanged());

  background.startPlugins();
  void background.start();
  return background;
}

if (typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string') startInBrowser();
