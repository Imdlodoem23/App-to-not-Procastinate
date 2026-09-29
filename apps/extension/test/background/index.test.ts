import { describe, expect, it, vi } from 'vitest';
import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import type { DnrApi, DnrUpdate } from '../../src/background/dnr';
import { createDnrApplier } from '../../src/background/dnr';
import type { BackgroundPlatform } from '../../src/background/index';
import { createBackground } from '../../src/background/index';
import type { DnrRule } from '../../src/background/rules';
import { buildDnrRules } from '../../src/background/rules';
import type {
  BackgroundPlugin,
  ExtensionStateSnapshot,
  GuideSection,
  StateChangedMessage,
} from '../../src/background/state';
import type { StorageAreaLike } from '../../src/background/storage';
import { STORAGE_KEYS, createBackgroundStore } from '../../src/background/storage';
import {
  BLK_A,
  EXT_1,
  MIN,
  NOW,
  fakeGuardian,
  iso,
  memoryArea,
  pairingFixture,
  rulesFixture,
} from './fakes';

const SELF = { id: 'test-extension-id' } as chrome.runtime.MessageSender;

function fakePlatform() {
  const guides: Array<GuideSection | undefined> = [];
  const broadcasts: StateChangedMessage[] = [];
  const alarms: Array<number | null> = [];
  const platform: BackgroundPlatform = {
    extensionId: 'test-extension-id',
    extVersion: '0.1.0',
    browser: async () => ({ family: 'chrome', engine: 'chromium', version: '131.0.0.0' }),
    capabilities: async () => ({ hostPermission: true, incognitoAllowed: true }),
    ensureTick: async () => undefined,
    scheduleRulesChange: async (at) => {
      alarms.push(at);
    },
    broadcast: (message) => {
      broadcasts.push(message);
    },
    openGuide: async (section) => {
      guides.push(section);
    },
  };
  return { platform, guides, broadcasts, alarms };
}

function recordingPlugin(fail = false) {
  const applied: Array<ExtRulesResponse | null> = [];
  const plugin: BackgroundPlugin = {
    name: 'recorder',
    applyRules: async (rules) => {
      if (fail) throw new Error('rule limit');
      applied.push(rules);
    },
  };
  return { plugin, applied };
}

async function setup(options: { cached?: boolean; plugins?: BackgroundPlugin[] } = {}) {
  const guardian = await fakeGuardian();
  const area = memoryArea();
  const store = createBackgroundStore(area);
  await store.setPairing(pairingFixture(guardian.publicKey));
  if (options.cached === true) {
    await store.setRules({
      v: 1,
      rules: rulesFixture(),
      extensionId: EXT_1,
      etag: '"r-100"',
      rulesPublicKey: guardian.publicKey,
      receivedAt: NOW - MIN,
      carried: null,
    });
  }
  const clock = { now: NOW };
  const fake = fakePlatform();
  const recorder = recordingPlugin();
  const background = createBackground({
    store,
    platform: fake.platform,
    plugins: options.plugins ?? [recorder.plugin],
    fetch: guardian.fetch,
    now: () => clock.now,
    // A macrotask per pause, so a connected loop never starves the test's timers.
    loop: { sleep: () => new Promise((resolve) => setTimeout(resolve, 0)), retryDelaysMs: [] },
  });
  return { guardian, store, clock, background, recorder, ...fake };
}

describe('createBackground', () => {
  it('re-applies the cached rules at start, even with the guardian down', async () => {
    const { guardian, background, recorder, alarms } = await setup({ cached: true });
    guardian.mode = 'down';
    await background.start();
    expect(recorder.applied[0]?.blocks.map((b) => b.id)).toEqual([BLK_A]);
    await background.loop.idle();
    expect(background.ctx.getLink()).toBe('unreachable');
    // Still enforced: the block has not ended.
    expect(recorder.applied).toHaveLength(1);
    expect(alarms.at(-1)).toBe(NOW + 30 * MIN);
  });

  it('keeps cached blocks until their end without the guardian, then lifts them', async () => {
    const { guardian, background, recorder, clock } = await setup({ cached: true });
    guardian.mode = 'down';
    await background.start();
    await background.loop.idle();
    clock.now = NOW + 29 * MIN;
    await background.tick();
    expect(recorder.applied.at(-1)?.blocks).toHaveLength(1);
    clock.now = NOW + 31 * MIN;
    await background.rulesChangeDue();
    await background.loop.idle();
    expect(recorder.applied.at(-1)?.blocks).toEqual([]);
    expect(recorder.applied.at(-1)?.blockDomains).toEqual([]);
  });

  it('starts from the last known link, so ended blocks are not re-applied offline', async () => {
    const { guardian, store, background, recorder, clock } = await setup({ cached: true });
    guardian.mode = 'down';
    await store.patchStatus({
      lastRulesAt: NOW - 5 * MIN,
      lastError: { code: 'unreachable', status: 0, at: NOW - MIN },
    });
    clock.now = NOW + 31 * MIN; // the cached block ended while the worker slept
    await background.start();
    expect(recorder.applied[0]?.blocks).toEqual([]);
    await background.loop.idle();
  });

  it('applies verified rules, skips identical ones and heartbeats the applied version', async () => {
    const { guardian, background, recorder } = await setup({
      plugins: undefined,
    });
    // One answer, then stop the loop by revoking.
    let answers = 0;
    const original = guardian.fetch;
    background.ctx.fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/v1/ext/rules' && ++answers > 1) {
        guardian.tokens.clear();
      }
      return original(input, init);
    };
    await background.start();
    await background.loop.idle();
    // Nothing cached at start (`null` clears the rules), then the verified body.
    expect(recorder.applied.map((r) => r?.extRulesVersion ?? null)).toEqual([null, 100]);
    expect(background.appliedVersion()).toBe(100);
    // The start heartbeat reports 0; the one after the rules change reports 100.
    const beats = () =>
      guardian.calls
        .filter((c) => c.url.pathname === '/v1/ext/heartbeat')
        .map((c) => (c.body as { appliedExtRulesVersion: number }).appliedExtRulesVersion);
    await vi.waitFor(() => expect(beats()).toContain(100));
    // The same rules with another nonce are not applied twice.
    await background.refreshRules();
    expect(recorder.applied).toHaveLength(2);
  });

  it('never reports a version as applied without a working applier', async () => {
    const failing = recordingPlugin(true);
    const { guardian, background } = await setup({ cached: true, plugins: [failing.plugin] });
    guardian.mode = 'down';
    await background.start();
    expect(background.appliedVersion()).toBe(0);
    const none = await setup({ cached: true, plugins: [] });
    none.guardian.mode = 'down';
    await none.background.start();
    expect(none.background.appliedVersion()).toBe(0);
  });

  it('answers page messages from this extension only', async () => {
    const { background, guides } = await setup({ cached: true });
    expect(
      background.handleMessage({ type: 'centrate/get-state' }, { id: 'other' }),
    ).toBeUndefined();

    const state = (await background.handleMessage({ type: 'centrate/get-state' }, SELF)) as {
      ok: true;
      state: ExtensionStateSnapshot;
    };
    expect(state.ok).toBe(true);
    expect(state.state.paired).toBe(true);
    expect(state.state.rules?.blocks.map((b) => b.id)).toEqual([BLK_A]);

    await background.handleMessage(
      { type: 'centrate/open-guide', section: 'host-permission' },
      SELF,
    );
    expect(guides).toEqual(['host-permission']);

    expect(await background.handleMessage({ type: 'centrate/nope' }, SELF)).toEqual({
      ok: false,
      error: 'bad_request',
    });
    expect(background.handleMessage({ hello: 'world' }, SELF)).toBeUndefined();
  });

  it('passes unknown messages to plugins', async () => {
    const plugin: BackgroundPlugin = {
      name: 'blocked-page',
      handleMessage: (message) =>
        (message as { type?: string }).type === 'centrate/blocked-info'
          ? Promise.resolve({ ok: true, info: 42 })
          : undefined,
    };
    const { background } = await setup({ plugins: [plugin] });
    expect(await background.handleMessage({ type: 'centrate/blocked-info' }, SELF)).toEqual({
      ok: true,
      info: 42,
    });
  });

  it('pairs from a page message and syncs at once', async () => {
    const { guardian, store, background, recorder, broadcasts } = await setup();
    await store.clearPairing();
    guardian.tokens.clear();
    // Revoke after the first rules answer so the loop ends.
    const original = guardian.fetch;
    background.ctx.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname === '/v1/ext/rules') guardian.tokens.clear();
      return response;
    };
    const reply = (await background.handleMessage(
      { type: 'centrate/pair', code: '048-392' },
      SELF,
    )) as { ok: boolean; state?: ExtensionStateSnapshot };
    expect(reply.ok).toBe(true);
    expect(reply.state?.paired).toBe(true);
    await background.loop.idle();
    expect(recorder.applied.at(-1)?.extRulesVersion).toBe(100);
    expect((await store.getRules())?.extensionId).toBe(EXT_1);
    await vi.waitFor(() => expect(broadcasts.length).toBeGreaterThan(0));
    expect(broadcasts.at(-1)?.type).toBe('centrate/state-changed');

    const wrong = await background.handleMessage({ type: 'centrate/pair', code: '000000' }, SELF);
    expect(wrong).toMatchObject({ ok: false, error: 'no_code' });
  });

  it('reports attempts with the hostname only', async () => {
    const { guardian, store, background } = await setup({ cached: true });
    const response = await background.api.reportAttempt({
      host: 'WWW.YouTube.com',
      incognito: true,
    });
    expect(response?.episodePointsDelta).toBe(-10);
    const call = guardian.calls.find((c) => c.url.pathname === '/v1/attempts')!;
    expect(call.body).toEqual({
      layer: 'extension',
      target: { type: 'domain', value: 'www.youtube.com' },
      browser: 'chrome',
      incognito: true,
    });
    expect(await background.api.matchHost('M.YOUTUBE.COM')).toMatchObject({ blocked: true });

    expect(await background.api.reportAttempt({ host: 'not a host', incognito: false })).toBeNull();
    guardian.tokens.clear();
    expect(
      await background.api.reportAttempt({ host: 'youtube.com', incognito: false }),
    ).toBeNull();
    expect((await store.getPairing())?.unauthorizedAt).toBe(NOW);
  });
});

/** Ends a connected loop: the guardian forgets the token once it answered one rules request. */
function revokeAfterFirstRulesAnswer(
  guardian: Awaited<ReturnType<typeof fakeGuardian>>,
  background: ReturnType<typeof createBackground>,
): void {
  const original = guardian.fetch;
  background.ctx.fetch = async (input, init) => {
    const response = await original(input, init);
    if (new URL(String(input)).pathname === '/v1/ext/rules') guardian.tokens.clear();
    return response;
  };
}

/** declarativeNetRequest dynamic rules in memory (what the browser kept across the update). */
function fakeDnr(initial: DnrRule[]) {
  let rules = structuredClone(initial);
  const updates: DnrUpdate[] = [];
  const api: DnrApi = {
    getDynamicRules: async () => structuredClone(rules),
    async updateDynamicRules(update) {
      updates.push(structuredClone(update));
      rules = [
        ...rules.filter((r) => !update.removeRuleIds.includes(r.id)),
        ...structuredClone(update.addRules),
      ];
    },
    limits: () => ({}),
  };
  return { api, updates, rules: () => rules };
}

function dnrPlugin(api: DnrApi): BackgroundPlugin {
  const applier = createDnrApplier({ api, warn: () => undefined });
  return {
    name: 'dnr',
    applyRules: async (rules) => {
      await applier.apply(rules);
    },
  };
}

describe('a stored rules record that cannot be read', () => {
  /** An older extension's record that today's validation refuses (a block until +30 min). */
  function unreadableRecord(): Record<string, unknown> {
    const rules = rulesFixture();
    return {
      v: 1,
      rules: { ...rules, blockDomains: [...rules.blockDomains, 'not a host'] },
      extensionId: EXT_1,
      etag: '"r-100"',
      rulesPublicKey: 'K',
      receivedAt: NOW - MIN,
      carried: null,
    };
  }

  async function setupHeld() {
    const guardian = await fakeGuardian();
    guardian.mode = 'down';
    const area = memoryArea({ [STORAGE_KEYS.rules]: unreadableRecord() });
    const store = createBackgroundStore(area);
    await store.setPairing(pairingFixture(guardian.publicKey));
    const installed = buildDnrRules(rulesFixture()).rules.map((r, i) => ({ ...r, id: i + 1 }));
    const dnr = fakeDnr(installed);
    const clock = { now: NOW };
    const fake = fakePlatform();
    const background = createBackground({
      store,
      platform: fake.platform,
      plugins: [dnrPlugin(dnr.api)],
      fetch: guardian.fetch,
      now: () => clock.now,
      loop: { sleep: () => new Promise((resolve) => setTimeout(resolve, 0)), retryDelaysMs: [] },
    });
    return { guardian, store, dnr, installed, clock, background, ...fake };
  }

  it('keeps the browser rules at start while the guardian is unreachable', async () => {
    const { dnr, installed, background, alarms } = await setupHeld();
    await background.start();
    await background.loop.idle();
    expect(background.ctx.getLink()).toBe('unreachable');
    await background.refreshRules();
    expect(dnr.updates).toEqual([]);
    expect(dnr.rules()).toEqual(installed);
    // Nothing reported as applied, so the guardian asks for a sync.
    expect(background.appliedVersion()).toBe(0);
    expect(alarms.at(-1)).toBe(NOW + 30 * MIN);
  });

  it('lifts them at the latest readable end, not before', async () => {
    const { dnr, clock, background } = await setupHeld();
    await background.start();
    await background.loop.idle();
    clock.now = NOW + 29 * MIN;
    await background.rulesChangeDue();
    expect(dnr.updates).toEqual([]);
    clock.now = NOW + 31 * MIN;
    await background.rulesChangeDue();
    await background.loop.idle();
    expect(dnr.rules()).toEqual([]);
  });

  it('replaces them with the first verified body', async () => {
    const { guardian, store, dnr, background } = await setupHeld();
    await background.start();
    await background.loop.idle();
    guardian.mode = 'ok';
    guardian.rules = rulesFixture({ extRulesVersion: 200, blockDomains: [], blocks: [] });
    revokeAfterFirstRulesAnswer(guardian, background);
    await background.tick();
    await background.loop.idle();
    expect(background.appliedVersion()).toBe(200);
    expect(await store.getUnreadableRules()).toBeNull();
    expect(dnr.rules()).toEqual([]);
  });
});

describe('the incognito instance (split mode follower)', () => {
  function followerPlugin() {
    const followed: Array<ExtRulesResponse | null> = [];
    const applied: Array<ExtRulesResponse | null> = [];
    const plugin: BackgroundPlugin = {
      name: 'follower-recorder',
      applyRules: async (rules) => {
        applied.push(rules);
      },
      followRules: async (rules) => {
        followed.push(rules);
      },
    };
    return { plugin, followed, applied };
  }

  async function twoInstances(options: { paired?: boolean } = {}) {
    const guardian = await fakeGuardian();
    const area: StorageAreaLike & ReturnType<typeof memoryArea> = memoryArea();
    const clock = { now: NOW };
    const make = (role: 'main' | 'follower') => {
      const fake = fakePlatform();
      const recorder = followerPlugin();
      const background = createBackground({
        store: createBackgroundStore(area),
        platform: fake.platform,
        plugins: [recorder.plugin],
        fetch: guardian.fetch,
        now: () => clock.now,
        role,
        loop: { sleep: () => new Promise((resolve) => setTimeout(resolve, 0)), retryDelaysMs: [] },
      });
      return { background, recorder, ...fake };
    };
    if (options.paired !== false) {
      await createBackgroundStore(area).setPairing(pairingFixture(guardian.publicKey));
    }
    return { guardian, area, clock, main: make('main'), follower: make('follower') };
  }

  it('never syncs, heartbeats or applies; it follows what the main instance stored', async () => {
    const { guardian, area, clock, follower } = await twoInstances();
    const store = createBackgroundStore(area);
    await store.setRules({
      v: 1,
      rules: rulesFixture(),
      extensionId: EXT_1,
      etag: '"r-100"',
      rulesPublicKey: guardian.publicKey,
      receivedAt: NOW - MIN,
      carried: null,
    });
    await follower.background.start();
    await follower.background.tick();
    await follower.background.capabilitiesChanged();
    expect(guardian.calls).toEqual([]);
    expect(follower.alarms).toEqual([]);
    expect(follower.recorder.applied).toEqual([]);
    expect(follower.recorder.followed.map((r) => r?.extRulesVersion)).toEqual([100]);
    expect(await follower.background.api.matchHost('www.youtube.com')).toMatchObject({
      blocked: true,
    });

    // The main instance recorded that the guardian stopped answering: cached rules, pruned.
    await store.patchStatus({
      lastRulesAt: NOW - MIN,
      lastError: { code: 'unreachable', status: 0, at: NOW },
    });
    clock.now = NOW + 31 * MIN;
    await follower.background.storageChanged([STORAGE_KEYS.status]);
    expect(follower.recorder.followed.at(-1)?.blocks).toEqual([]);
    expect(await follower.background.api.matchHost('www.youtube.com')).toMatchObject({
      blocked: false,
    });
    const state = (await follower.background.handleRequest({ type: 'centrate/get-state' })) as {
      state: ExtensionStateSnapshot;
    };
    expect(state.state.link).toBe('unreachable');
    expect(state.state.problems).toContain('guardian_unreachable');
    expect(guardian.calls).toEqual([]);
  });

  it('reports attempts itself', async () => {
    const { guardian, follower } = await twoInstances();
    await follower.background.start();
    const response = await follower.background.api.reportAttempt({
      host: 'www.youtube.com',
      incognito: true,
    });
    expect(response?.pointsDelta).toBe(-10);
    const call = guardian.calls.find((c) => c.url.pathname === '/v1/attempts');
    expect(call?.body).toMatchObject({ incognito: true, layer: 'extension' });
  });

  it('asks the main instance to sync through storage', async () => {
    const { guardian, area, main, follower } = await twoInstances();
    guardian.mode = 'down'; // the main loop gives up at once (no retry delays)
    await main.background.start();
    await main.background.loop.idle();
    const before = guardian.rulesCalls().length;
    await follower.background.start();
    await follower.background.handleRequest({ type: 'centrate/refresh' });
    expect(guardian.rulesCalls()).toHaveLength(before);
    expect(area.data.get(STORAGE_KEYS.syncRequest)).toBe(NOW);

    guardian.mode = 'ok';
    revokeAfterFirstRulesAnswer(guardian, main.background);
    await main.background.storageChanged([STORAGE_KEYS.syncRequest]);
    await main.background.loop.idle();
    expect(guardian.rulesCalls().length).toBeGreaterThan(before);
    expect(main.recorder.applied.at(-1)?.extRulesVersion).toBe(100);
  });

  it('a claim made in the incognito popup reaches the main instance', async () => {
    const { guardian, main, follower } = await twoInstances({ paired: false });
    await main.background.start();
    await main.background.loop.idle();
    await follower.background.start();
    expect(guardian.rulesCalls()).toEqual([]);

    const reply = (await follower.background.handleRequest({
      type: 'centrate/pair',
      code: '048392',
    })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    // Only the main instance syncs, once it sees the new pairing.
    expect(guardian.rulesCalls()).toEqual([]);
    revokeAfterFirstRulesAnswer(guardian, main.background);
    await main.background.storageChanged([STORAGE_KEYS.pairing]);
    await main.background.loop.idle();
    expect(guardian.rulesCalls().length).toBeGreaterThan(0);
    expect(main.recorder.applied.at(-1)?.extRulesVersion).toBe(100);

    await follower.background.storageChanged([STORAGE_KEYS.rules]);
    expect(follower.recorder.followed.at(-1)?.extRulesVersion).toBe(100);
    expect(follower.recorder.applied).toEqual([]);
  });

  it('the main instance ignores writes that keep the same pairing', async () => {
    const { guardian, area, main } = await twoInstances();
    guardian.rules = rulesFixture({ nextChangeAt: iso(NOW + 30 * MIN) });
    revokeAfterFirstRulesAnswer(guardian, main.background);
    await main.background.start();
    await main.background.loop.idle();
    const calls = guardian.rulesCalls().length;
    // The token was marked unauthorized (by this instance or the other): same claim.
    expect((await createBackgroundStore(area).getPairing())?.unauthorizedAt).toBe(NOW);
    await main.background.storageChanged([STORAGE_KEYS.pairing]);
    await main.background.loop.idle();
    expect(guardian.rulesCalls()).toHaveLength(calls);
  });
});

describe('reportUsage', () => {
  const body = {
    intervalMs: 30_000,
    items: [{ type: 'domain' as const, value: 'www.youtube.com', seconds: 30 }],
  };

  it('sends the report with the extension token and returns the answer', async () => {
    const { guardian, background } = await setup();
    const answer = await background.api.reportUsage(body);
    if (answer === 'refused' || answer === 'lost') throw new Error(`no answer: ${answer}`);
    expect(answer.limits[0]?.remainingTodaySeconds).toBe(1_200);
    const call = guardian.calls.find((c) => c.url.pathname === '/v1/usage');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('Authorization')).toBe(`Bearer ${pairingFixture('').token}`);
    expect(call?.body).toEqual(body);
  });

  it('is lost (maybe credited) without an answer, refused on an error status, never retried', async () => {
    const { guardian, background, store } = await setup();
    guardian.mode = 'down';
    expect(await background.api.reportUsage(body)).toBe('lost');
    expect(guardian.calls.filter((c) => c.url.pathname === '/v1/usage')).toHaveLength(1);
    guardian.mode = 'ok';
    guardian.tokens.clear();
    expect(await background.api.reportUsage(body)).toBe('refused');
    expect((await store.getPairing())?.unauthorizedAt).toBe(NOW);
    expect(await background.api.reportUsage(body)).toBe('refused');
  });

  it('is never sent by the incognito instance (one client per token)', async () => {
    const guardian = await fakeGuardian();
    const store = createBackgroundStore(memoryArea());
    await store.setPairing(pairingFixture(guardian.publicKey));
    const background = createBackground({
      store,
      platform: fakePlatform().platform,
      plugins: [],
      fetch: guardian.fetch,
      now: () => NOW,
      role: 'follower',
    });
    expect(await background.api.reportUsage(body)).toBe('refused');
    expect(guardian.calls).toEqual([]);
  });
});
