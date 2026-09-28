/**
 * Attempts from the extension (docs/ARCHITECTURE.md §9.5) and blocking of tabs that were
 * already open when a block started.
 *
 * **What counts.** Only the background reports, never blocked.html (any page can open it).
 * An attempt is a real top-level navigation: `frameId === 0`, `frameType` `outermost_frame`
 * and `documentLifecycle` `active` (omnibox prerenders and other speculative loads are
 * ignored; Firefox sends neither field and has no prerendering). The URL a tab's navigation
 * requests is remembered at `webNavigation.onBeforeNavigate` and moved along its HTTP
 * redirects by `webRequest.onBeforeRedirect` (non-blocking, `main_frame` only): a link
 * through t.co, bit.ly or google.com/url fires onBeforeNavigate once, for the redirector,
 * so the site DNR sends to blocked.html is the last server redirect's `redirectUrl`.
 * Chromium does not report DNR's own redirect to webRequest (Chromium 141, checked by
 * e2e/redirect.e2e.ts); when a browser does, its `url` is that site too. The attempt is
 * recorded when the DNR redirect commits (`onCommitted` of blocked.html in that tab,
 * within `NAV_MATCH_MS`), checked against the rules in force (`matchHost`). Chrome fires
 * both webNavigation events again, as `active`, when a prerendered or cached page is
 * activated, so a prerendered blocked page still counts once the user actually opens it.
 * Sub-frame embeds are blocked but never counted. The guardian receives the hostname only
 * (`layer: "extension"`).
 *
 * **Safety net.** A top-level commit of a blocked host that DNR did not redirect (back/
 * forward cache, a navigation racing a rules update, `youtube.com.` with a trailing dot)
 * moves the tab to blocked.html at once and counts like a redirect. A commit with no
 * navigation seen before it is not an attempt: Firefox commits a restored tab's URL
 * («reopen closed tab», session restore) before loading it, and only then loads it as a
 * history navigation. The tab is moved like an open tab (`enforced`, no points), and the
 * detection is remembered so that load (`forward_back`) is not reported either.
 *
 * **Firefox.** DNR's redirect to blocked.html is a new load there (a switch to the
 * extension process), with its own `onBeforeNavigate` for blocked.html and a commit
 * qualified `server_redirect`; webRequest may report the redirect after the commit. An
 * `onBeforeNavigate` of blocked.html within `BLOCKED_PAGE_FOLLOW_MS` of a pending http(s)
 * navigation keeps it, marked `superseded`: only a redirect commit (`server_redirect`)
 * matches it then, never blocked.html opened by hand or by `tabs.update`. Chromium fires
 * no `onBeforeNavigate` for DNR's redirect (e2e/redirect.e2e.ts), so none of this applies
 * there. e2e/firefox/ checks it in a real Firefox.
 *
 * **Client-side filtering** (the guardian stays authoritative and merges detections of
 * the same target within 30 s itself):
 * - `reload` transitions are never reported: Chromium restores tabs (session restore,
 *   «reopen closed tab», lazily loaded restored tabs) as reloads, and a real reload of a
 *   page already open is «sigues en la misma página», one attempt at most.
 * - back/forward within the dedupe window (sliding, 30 s) of a detection of the same
 *   target is not reported again;
 * - the same target reported less than `CLIENT_DUPLICATE_MS` ago (two tabs at once, a
 *   double event) is not sent twice: both tabs show the first answer.
 *
 * **Open tabs.** After every change of the browser's rules (dnr.ts) the open http(s) tabs
 * are checked and those on a now-blocked host are moved to blocked.html (`tab=1`,
 * status `enforced`): a block that starts while YouTube is open takes effect at once and
 * costs nothing.
 *
 * **blocked.html** gets everything from the background: `BlockedTabInfo` in
 * `chrome.storage.session` under `blockedTabKey(tabId)` (written before the page loads
 * when possible, updated when the guardian answers), or `BLOCKED_INFO_MESSAGE`.
 */

import { findServiceByDomain, isValidDomain } from '@centrate/shared/catalog';
import type { AttemptResponse, ExtRulesResponse } from '@centrate/shared/guardian-api';
import { domainTargetKey } from '@centrate/shared/guardian-api';
import { POINT_RULES } from '@centrate/shared/points';
import { onDnrRulesChanged } from './dnr';
import type { BlockedCause, BlockedTabBlock, BlockedTabInfo } from './rules';
import {
  BLOCKED_INFO_MESSAGE,
  BLOCKED_PAGE,
  blockedPagePath,
  blockedTabKey,
  hostFromUrl,
  isBlockedPageUrl,
  parseBlockedTabInfo,
} from './rules';
import type { BackgroundApi, BackgroundPlugin, HostMatch } from './state';
import { matchHost, registerBackgroundPlugin } from './state';

/** Longest time between `onBeforeNavigate` of a blocked URL and the commit of blocked.html. */
export const NAV_MATCH_MS = 30_000;
/** The same target reported again within this window is not sent twice. */
export const CLIENT_DUPLICATE_MS = 2_000;
/**
 * Firefox: longest time between a tab's http(s) `onBeforeNavigate` and the
 * `onBeforeNavigate` of blocked.html that DNR's redirect of it fires (tens of ms).
 */
export const BLOCKED_PAGE_FOLLOW_MS = 2_000;

// ---------------------------------------------------------------------------------------
// Pure filters
// ---------------------------------------------------------------------------------------

/** The fields of `webNavigation` event details this module reads. */
export interface NavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  /** Chrome 106+; absent in Firefox. */
  frameType?: string;
  /** Chrome 106+; absent in Firefox. */
  documentLifecycle?: string;
}

export interface CommitDetails extends NavigationDetails {
  transitionType?: string;
  transitionQualifiers?: readonly string[];
}

/** The fields of `webRequest.onBeforeRedirect` details this module reads. */
export interface RedirectDetails extends NavigationDetails {
  /** The next URL: another hop of the navigation, or blocked.html when DNR redirected `url`. */
  redirectUrl: string;
  /** `main_frame` for the document of a tab (the listener's filter). */
  type?: string;
}

/** A real top-level navigation in a tab: not a sub-frame, fenced frame or prerender. */
export function isTopLevelActive(details: NavigationDetails): boolean {
  return (
    details.tabId >= 0 &&
    details.frameId === 0 &&
    (details.frameType === undefined || details.frameType === 'outermost_frame') &&
    (details.documentLifecycle === undefined || details.documentLifecycle === 'active')
  );
}

export type ReportDecision = 'report' | 'duplicate' | 'ignore';

export interface ReportDecisionInput {
  transitionType?: string;
  transitionQualifiers?: readonly string[];
  now: number;
  /** Last detection of the same target key (reported or not). */
  lastDetectionAt?: number;
  /** Last time the same target key was sent to the guardian. */
  lastReportAt?: number;
  dedupeWindowMs?: number;
  duplicateMs?: number;
}

/** Whether a detection is sent to the guardian (see the module comment). */
export function decideReport(input: ReportDecisionInput): ReportDecision {
  const window = input.dedupeWindowMs ?? POINT_RULES.attemptDedupeWindowMs;
  const duplicate = input.duplicateMs ?? CLIENT_DUPLICATE_MS;
  const since = (at: number | undefined): number =>
    at === undefined ? Infinity : Math.max(0, input.now - at);
  if (input.transitionType === 'reload') return 'ignore';
  if (
    input.transitionQualifiers?.includes('forward_back') &&
    since(input.lastDetectionAt) < window
  ) {
    return 'ignore';
  }
  if (since(input.lastReportAt) < duplicate) return 'duplicate';
  return 'report';
}

// ---------------------------------------------------------------------------------------
// Storage and browser APIs
// ---------------------------------------------------------------------------------------

/** Where `BlockedTabInfo` lives (session storage in the worker, a map in tests). */
export interface BlockedTabStore {
  get(tabId: number): Promise<BlockedTabInfo | null>;
  set(info: BlockedTabInfo): Promise<void>;
  remove(tabId: number): Promise<void>;
}

export function memoryTabStore(): BlockedTabStore & { entries(): Map<number, BlockedTabInfo> } {
  const map = new Map<number, BlockedTabInfo>();
  return {
    get: async (tabId) => map.get(tabId) ?? null,
    set: async (info) => {
      map.set(info.tabId, info);
    },
    remove: async (tabId) => {
      map.delete(tabId);
    },
    entries: () => map,
  };
}

/** `chrome.storage.session` (memory only; readable by extension pages, not by websites). */
export function sessionTabStore(): BlockedTabStore {
  const area = chrome.storage.session;
  return {
    async get(tabId) {
      const key = blockedTabKey(tabId);
      const items = await area.get(key);
      return parseBlockedTabInfo(items[key]);
    },
    set: (info) => area.set({ [blockedTabKey(info.tabId)]: info }),
    remove: (tabId) => area.remove(blockedTabKey(tabId)),
  };
}

export interface TabLike {
  id?: number;
  url?: string;
  incognito?: boolean;
}

/** The subset of `chrome.tabs` this module uses. */
export interface TabsApi {
  get(tabId: number): Promise<TabLike>;
  update(tabId: number, properties: { url: string }): Promise<unknown>;
  query(info: { url: string[] }): Promise<TabLike[]>;
}

export function chromeTabsApi(): TabsApi {
  return {
    get: (tabId) => chrome.tabs.get(tabId),
    update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    query: (info) => chrome.tabs.query(info),
  };
}

// ---------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------

export interface AttemptTrackerDeps {
  /** The rules in force now (state.ts `computeEffectiveRules`). */
  getEffectiveRules: BackgroundApi['getEffectiveRules'];
  /** `POST /v1/attempts` (hostname only); `null` when it could not be reported. */
  reportAttempt: BackgroundApi['reportAttempt'];
  /** The extension's root URL, `chrome.runtime.getURL('')`. */
  extensionBase: string;
  tabs: TabsApi;
  store: BlockedTabStore;
  /** Default `Date.now`. */
  now?: () => number;
  warn?: (message: string, error?: unknown) => void;
}

export interface AttemptTracker {
  onBeforeNavigate(details: NavigationDetails): void;
  /**
   * A top-level request of a tab was redirected (by the server or by DNR): the navigation
   * now stands for the URL that will reach blocked.html, not the one it started with.
   */
  onBeforeRedirect(details: RedirectDetails): void;
  /** Resolves when the commit is fully handled (including the guardian's answer). */
  onCommitted(details: CommitDetails): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  /** Moves open tabs on a host `rules` block to blocked.html; returns their ids. */
  enforceOpenTabs(rules: ExtRulesResponse | null): Promise<number[]>;
  /** Answers `BLOCKED_INFO_MESSAGE` for the sender's tab (main-frame blocked.html only). */
  handleMessage(sender: chrome.runtime.MessageSender): Promise<BlockedTabInfo | null>;
}

interface PendingNav {
  url: string;
  host: string;
  at: number;
  /**
   * A navigation to blocked.html started right after it (Firefox's DNR redirect, or the
   * page opened by hand): only a `server_redirect` commit matches it.
   */
  superseded?: boolean;
}

interface ReportRecord {
  at: number;
  result: Promise<AttemptResponse | null>;
}

function pickBlock(block: HostMatch['block'] | AttemptResponse['block']): BlockedTabBlock | null {
  if (block === null) return null;
  return {
    id: block.id,
    kind: block.kind,
    mode: block.mode,
    endsAt: block.endsAt,
    reason: block.reason,
  };
}

/** The page's view of a guardian answer (`duplicate`: another tab's report). */
function applyResponse(
  base: BlockedTabInfo,
  response: AttemptResponse | null,
  duplicate: boolean,
): BlockedTabInfo {
  if (response === null) return { ...base, status: 'unreported' };
  const common = {
    ...base,
    nextPenalty: response.nextPenalty,
    block: pickBlock(response.block) ?? base.block,
    guardianReason: response.reason,
  };
  if (!response.blocked) {
    return { ...common, status: 'not_counted', pointsDelta: 0, episodePointsDelta: 0 };
  }
  if (response.counted && !duplicate) {
    return {
      ...common,
      status: 'counted',
      pointsDelta: response.pointsDelta,
      episodePointsDelta: response.episodePointsDelta,
    };
  }
  if (response.counted || response.merged) {
    return {
      ...common,
      status: 'merged',
      pointsDelta: 0,
      episodePointsDelta: response.episodePointsDelta,
    };
  }
  return { ...common, status: 'not_counted', pointsDelta: 0, episodePointsDelta: null };
}

export function createAttemptTracker(deps: AttemptTrackerDeps): AttemptTracker {
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message, error) => console.warn(message, error));
  const base = deps.extensionBase.endsWith('/') ? deps.extensionBase : `${deps.extensionBase}/`;
  const pending = new Map<number, PendingNav>();
  const lastDetection = new Map<string, number>();
  const lastReport = new Map<string, ReportRecord>();
  const withInfo = new Set<number>();
  const tabQueues = new Map<number, Promise<void>>();

  const pageUrl = (cause: BlockedCause, serviceId: string | null, enforced: boolean): string =>
    base +
    blockedPagePath({ cause, serviceId: cause === 'domain' ? serviceId : null, enforced }).slice(1);

  function inTab(tabId: number, task: () => Promise<void>): Promise<void> {
    const previous = tabQueues.get(tabId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch((error: unknown) => warn('Céntrate: attempt handling failed', error));
    tabQueues.set(tabId, tail);
    void tail.then(() => {
      if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
    });
    return tail;
  }

  function prune(at: number): void {
    const window = POINT_RULES.attemptDedupeWindowMs;
    for (const [key, t] of lastDetection) if (at - t >= window) lastDetection.delete(key);
    for (const [key, r] of lastReport) if (at - r.at >= window) lastReport.delete(key);
  }

  async function save(info: BlockedTabInfo): Promise<void> {
    withInfo.add(info.tabId);
    await deps.store.set(info);
  }

  async function forget(tabId: number): Promise<void> {
    if (!withInfo.delete(tabId)) return;
    await deps.store.remove(tabId);
  }

  async function isIncognito(tabId: number): Promise<boolean> {
    try {
      return (await deps.tabs.get(tabId)).incognito === true;
    } catch {
      return false;
    }
  }

  async function settled(record: ReportRecord | undefined): Promise<AttemptResponse | null> {
    return record === undefined ? null : record.result.catch(() => null);
  }

  /**
   * One detection in `tabId`: `redirected` (DNR already showed blocked.html) or
   * `committed` (the blocked host itself loaded; the tab is moved first).
   */
  async function detect(
    details: CommitDetails,
    nav: PendingNav,
    via: 'redirected' | 'committed',
    rules: ExtRulesResponse | null,
    match: HostMatch,
  ): Promise<void> {
    const tabId = details.tabId;
    const at = now();
    const serviceId = findServiceByDomain(nav.host)?.id ?? null;
    let info: BlockedTabInfo = {
      v: 1,
      tabId,
      host: nav.host,
      url: nav.url,
      serviceId,
      cause: match.via ?? 'domain',
      status: 'reporting',
      at,
      pointsDelta: null,
      episodePointsDelta: null,
      nextPenalty: null,
      penaltiesEnabled: rules?.penaltiesEnabled ?? null,
      guardianReason: null,
      block: pickBlock(match.block),
    };

    if (!match.blocked) {
      // DNR redirected but the rules in force no longer block it (they changed meanwhile).
      await save({ ...info, status: 'not_counted', pointsDelta: 0 });
      return;
    }
    if (via === 'committed') {
      await save(info);
      try {
        await deps.tabs.update(tabId, { url: pageUrl(info.cause, serviceId, false) });
      } catch (error) {
        warn('Céntrate: could not move a tab to the blocked page', error);
      }
    }

    prune(at);
    const key = domainTargetKey(nav.host);
    const previous = lastReport.get(key);
    const decision = decideReport({
      transitionType: details.transitionType,
      transitionQualifiers: details.transitionQualifiers,
      now: at,
      lastDetectionAt: lastDetection.get(key),
      lastReportAt: previous?.at,
    });
    lastDetection.set(key, at);

    if (decision === 'ignore') {
      const earlier = await settled(previous);
      await save({
        ...info,
        status: 'ignored',
        pointsDelta: 0,
        episodePointsDelta: earlier?.episodePointsDelta ?? null,
        nextPenalty: earlier?.nextPenalty ?? null,
        block: pickBlock(earlier?.block ?? null) ?? info.block,
      });
      return;
    }

    const duplicate = decision === 'duplicate' && previous !== undefined;
    // The API takes canonical domains only (no IP literals): nothing to report.
    if (!duplicate && !isValidDomain(nav.host)) {
      await save({ ...info, status: 'unreported' });
      return;
    }
    let record: ReportRecord;
    if (duplicate) {
      record = previous;
    } else {
      // Recorded before any await, so another tab detecting the same target reuses it.
      const host = nav.host;
      record = {
        at,
        result: isIncognito(tabId).then((incognito) => deps.reportAttempt({ host, incognito })),
      };
      lastReport.set(key, record);
    }
    await save(info);
    info = applyResponse(info, await settled(record), duplicate);
    await save(info);
  }

  /** Moves `tabId`, on `url` that `match` blocks, to blocked.html without points. */
  async function enforceTab(
    tabId: number,
    url: string,
    host: string,
    rules: ExtRulesResponse | null,
    match: HostMatch,
  ): Promise<boolean> {
    const serviceId = findServiceByDomain(host)?.id ?? null;
    const cause = match.via ?? 'domain';
    await save({
      v: 1,
      tabId,
      host,
      url,
      serviceId,
      cause,
      status: 'enforced',
      at: now(),
      pointsDelta: 0,
      episodePointsDelta: null,
      nextPenalty: null,
      penaltiesEnabled: rules?.penaltiesEnabled ?? null,
      guardianReason: null,
      block: pickBlock(match.block),
    });
    try {
      await deps.tabs.update(tabId, { url: pageUrl(cause, serviceId, true) });
      return true;
    } catch {
      // The tab was closed meanwhile.
      return false;
    }
  }

  async function handleCommit(details: CommitDetails): Promise<void> {
    const tabId = details.tabId;
    const nav = pending.get(tabId);
    pending.delete(tabId);
    const started = nav !== undefined && now() - nav.at <= NAV_MATCH_MS ? nav : undefined;

    if (isBlockedPageUrl(details.url, base)) {
      // Opened by the extension (its info is already written), by hand or by another page:
      // only a redirect of a navigation seen at onBeforeNavigate is an attempt, for the URL
      // DNR redirected (onBeforeRedirect), not the redirector the navigation started at.
      if (started === undefined) return;
      if (
        started.superseded &&
        details.transitionQualifiers?.includes('server_redirect') !== true
      ) {
        return;
      }
      const rules = await deps.getEffectiveRules();
      await detect(details, started, 'redirected', rules, matchHost(rules, started.host));
      return;
    }

    const host = hostFromUrl(details.url);
    if (host === null) {
      await forget(tabId);
      return;
    }
    const rules = await deps.getEffectiveRules();
    const match = matchHost(rules, host);
    if (!match.blocked) {
      await forget(tabId);
      return;
    }
    if (started === undefined) {
      // No navigation led here: a restored tab (see the module comment). Its own load,
      // which follows as `forward_back`, falls in the dedupe window of this detection.
      const at = now();
      prune(at);
      lastDetection.set(domainTargetKey(host), at);
      await enforceTab(tabId, details.url, host, rules, match);
      return;
    }
    await detect(details, { url: details.url, host, at: now() }, 'committed', rules, match);
  }

  return {
    onBeforeNavigate(details) {
      if (!isTopLevelActive(details)) return;
      if (isBlockedPageUrl(details.url, base)) {
        // Firefox fires this for DNR's own redirect: keep what it redirected (see the
        // module comment). Later, or without one, blocked.html was opened some other way.
        const nav = pending.get(details.tabId);
        if (nav !== undefined && now() - nav.at <= BLOCKED_PAGE_FOLLOW_MS) {
          pending.set(details.tabId, { ...nav, superseded: true });
        } else {
          pending.delete(details.tabId);
        }
        return;
      }
      const host = hostFromUrl(details.url);
      if (host === null) pending.delete(details.tabId);
      else pending.set(details.tabId, { url: details.url, host, at: now() });
    },

    onBeforeRedirect(details) {
      if (!isTopLevelActive(details)) return;
      if (details.type !== undefined && details.type !== 'main_frame') return;
      // A server redirect (t.co → youtube.com) moves the navigation on to `redirectUrl`,
      // which is what DNR sees next. A redirect to blocked.html (DNR's own, where the
      // browser reports it, or a server's) keeps `url`: the site DNR blocked, or a
      // redirector no rule blocks, which is then never an attempt.
      const url = isBlockedPageUrl(details.redirectUrl, base) ? details.url : details.redirectUrl;
      const host = hostFromUrl(url);
      if (host === null) pending.delete(details.tabId);
      else pending.set(details.tabId, { url, host, at: now() });
    },

    onCommitted(details) {
      // Prerender commits are skipped: activation fires onBeforeNavigate/onCommitted again
      // as `active`.
      if (!isTopLevelActive(details)) return Promise.resolve();
      return inTab(details.tabId, () => handleCommit(details));
    },

    async onTabRemoved(tabId) {
      pending.delete(tabId);
      withInfo.delete(tabId);
      await deps.store.remove(tabId);
    },

    async enforceOpenTabs(rules) {
      if (rules === null) return [];
      let tabs: TabLike[];
      try {
        tabs = await deps.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      } catch (error) {
        warn('Céntrate: could not list tabs', error);
        return [];
      }
      const moved: number[] = [];
      for (const tab of tabs) {
        if (tab.id === undefined || tab.id < 0 || tab.url === undefined) continue;
        const host = hostFromUrl(tab.url);
        if (host === null) continue;
        const match = matchHost(rules, host);
        if (!match.blocked) continue;
        pending.delete(tab.id);
        if (await enforceTab(tab.id, tab.url, host, rules, match)) moved.push(tab.id);
      }
      return moved;
    },

    async handleMessage(sender) {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0) return null;
      if (sender.url === undefined || !isBlockedPageUrl(sender.url, base)) return null;
      return deps.store.get(tabId);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Background plugin
// ---------------------------------------------------------------------------------------

/** True for `{ type: BLOCKED_INFO_MESSAGE }` (and nothing else). */
export function isBlockedInfoRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const keys = Object.keys(message);
  return keys.length === 1 && (message as { type?: unknown }).type === BLOCKED_INFO_MESSAGE;
}

/**
 * Registers the `webNavigation`, `webRequest` and `tabs` listeners. `start` runs during the
 * worker's first turn (index.ts), which MV3 needs to wake the worker for these events.
 * `webRequest` is the non-blocking permission (MV3 in Chrome and Firefox): the listener
 * only reads where a tab's top-level request was redirected.
 */
export function installAttemptListeners(
  tracker: AttemptTracker,
  extensionBase: string,
): () => void {
  const warn = (error: unknown): void => console.warn('Céntrate: attempt listener failed', error);
  const nav = chrome.webNavigation as typeof chrome.webNavigation | undefined;
  const request = chrome.webRequest as typeof chrome.webRequest | undefined;
  const web = [{ urlPrefix: 'http://' }, { urlPrefix: 'https://' }];
  const page = { urlPrefix: extensionBase.replace(/\/*$/, '/') + BLOCKED_PAGE };

  const before = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails): void => {
    tracker.onBeforeNavigate(details);
  };
  const redirected = (details: chrome.webRequest.OnBeforeRedirectDetails): void => {
    tracker.onBeforeRedirect(details);
  };
  const committed = (
    details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
  ): void => {
    tracker.onCommitted(details).catch(warn);
  };
  const removed = (tabId: number): void => {
    tracker.onTabRemoved(tabId).catch(warn);
  };

  if (nav === undefined) {
    console.warn('Céntrate: webNavigation is unavailable; attempts are not reported');
  } else {
    nav.onBeforeNavigate.addListener(before, { url: [...web, page] });
    nav.onCommitted.addListener(committed, { url: [...web, page] });
  }
  if (request === undefined) {
    console.warn('Céntrate: webRequest is unavailable; redirected attempts keep the first URL');
  } else {
    request.onBeforeRedirect.addListener(redirected, {
      urls: ['http://*/*', 'https://*/*'],
      types: ['main_frame'],
    });
  }
  chrome.tabs.onRemoved.addListener(removed);
  return () => {
    nav?.onBeforeNavigate.removeListener(before);
    nav?.onCommitted.removeListener(committed);
    request?.onBeforeRedirect.removeListener(redirected);
    chrome.tabs.onRemoved.removeListener(removed);
  };
}

let backgroundApi: BackgroundApi | null = null;
const apiWaiters: Array<(api: BackgroundApi) => void> = [];
let workerTracker: AttemptTracker | null = null;

function whenApi(): Promise<BackgroundApi> {
  if (backgroundApi !== null) return Promise.resolve(backgroundApi);
  return new Promise((resolve) => apiWaiters.push(resolve));
}

/** The worker's tracker (created on first use: it needs `chrome`). */
function trackerForWorker(): AttemptTracker {
  workerTracker ??= createAttemptTracker({
    getEffectiveRules: async () => (await whenApi()).getEffectiveRules(),
    reportAttempt: async (input) => (await whenApi()).reportAttempt(input),
    extensionBase: chrome.runtime.getURL(''),
    tabs: chromeTabsApi(),
    store: chrome.storage.session !== undefined ? sessionTabStore() : memoryTabStore(),
  });
  return workerTracker;
}

export const attemptsPlugin: BackgroundPlugin = {
  name: 'attempts',
  start(api) {
    backgroundApi = api;
    for (const resolve of apiWaiters.splice(0)) resolve(api);
    installAttemptListeners(trackerForWorker(), chrome.runtime.getURL(''));
  },
  handleMessage(message, sender) {
    if (!isBlockedInfoRequest(message)) return undefined;
    return trackerForWorker().handleMessage(sender);
  },
};

registerBackgroundPlugin(attemptsPlugin);

onDnrRulesChanged(async (rules) => {
  await trackerForWorker().enforceOpenTabs(rules);
});
