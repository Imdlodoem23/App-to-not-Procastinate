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
 * qualified `server_redirect`. An `onBeforeNavigate` of blocked.html within
 * `BLOCKED_PAGE_FOLLOW_MS` of a pending http(s) navigation keeps it, marked `superseded`:
 * only a redirect commit (`server_redirect`) matches it then, never blocked.html opened by
 * hand or by `tabs.update`. Firefox (128 ESR and 156 checked) delivers a navigation's
 * webRequest events on another channel than its webNavigation ones, often after the commit
 * (tens to hundreds of ms): `onBeforeRequest` (who started it), every server redirect
 * (t.co → instagram.com) and, last, DNR's own redirect, which Firefox does report
 * (`statusCode` 200, `redirectUrl` blocked.html). So the commit of such a redirect waits
 * for that report (`REDIRECT_REPORT_MS` at most, then it goes on with what it has): its
 * `url` is the site DNR blocked, and the request's origin has arrived by then. Chromium
 * fires no `onBeforeNavigate` for DNR's redirect (e2e/redirect.e2e.ts), so none of this
 * applies there. e2e/firefox/ checks it in a real Firefox.
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
 * **Started by a page, not by the user** (blocked, never counted: status `not_counted`,
 * nothing sent). Web pages must not be able to cost points (cheat matrix #28):
 * - commits qualified `client_redirect` (meta refresh, and script navigations the browser
 *   marks as such);
 * - navigations started by another document than the one the tab shows: the top-level
 *   request's `initiator` (Chromium) or `originUrl` (Firefox), read at
 *   `webRequest.onBeforeRequest`, is not the origin of the tab's committed document (an
 *   opener driving its popup, a frame navigating the top). Chromium reports it for
 *   requests DNR redirects too (e2e/attempts-forgery.e2e.ts);
 * - in a tab a page opened (`webNavigation.onCreatedNavigationTarget`) that has shown no
 *   web page yet, a navigation started by a page more than `OPENED_TAB_GRACE_MS` after it
 *   opened (a popup opened on `about:blank` and driven later).
 * Chromium gives a page's own script navigation (`location = …` after load) the same
 * `link` transition and initiator as a click, so that one still counts (DECISIONS.md).
 * The tab's document origin lives in the worker's memory: after a worker restart it is
 * unknown until the tab commits again, and the navigation counts as before.
 *
 * **Open tabs.** After every change of the browser's rules (dnr.ts), in the incognito
 * instance of Chromium's split mode whenever the rules it follows change (`followRules`),
 * and on every 30 s tick (a move the user cancelled at «¿Salir del sitio?», or that the
 * browser refused during a tab drag, is retried) the open http(s) tabs are checked and
 * those on a now-blocked host are moved to blocked.html (`tab=1`, status `enforced`): a
 * block that starts while YouTube is open takes effect at once and costs nothing. A tab
 * moved less than `MOVE_GRACE_MS` ago is left to finish loading blocked.html.
 *
 * **Whitelist mode escapes.** The whitelist redirect only sees http(s) top-level
 * requests; a `data:` or `file:` document (typed in the address bar) or a `blob:` of a
 * non-allowed origin could frame any site, and the whitelist never blocks sub-frames. While
 * a whitelist is in force such a top-level commit is moved to blocked.html (`whitelist`,
 * `enforced`, never counted, its URL not stored).
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
  storedUrl,
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
/**
 * Firefox: longest wait, at the commit of DNR's redirect to blocked.html, for webRequest's
 * report of that redirect (usually tens to hundreds of ms after the commit, see the module
 * comment). It only bounds a report that never comes: the report itself ends the wait.
 */
export const REDIRECT_REPORT_MS = 5_000;
/**
 * A tab a page opened counts its first navigation (a link with `target=_blank`, a popup
 * opened on a click) only this soon after it opened: Chromium's user activation lasts 5 s.
 */
export const OPENED_TAB_GRACE_MS = 5_000;
/** A tab moved to blocked.html less than this ago is not moved again (it is loading). */
export const MOVE_GRACE_MS = 10_000;
/** The core's periodic alarm (index.ts `ALARMS.tick`), also the open-tab sweep. */
export const TICK_ALARM = 'centrate.tick';
/** The sweep's own alarm in Chromium's incognito instance (the core ticks in the main one). */
export const SWEEP_ALARM = 'centrate.sweep';
const SWEEP_PERIOD_MINUTES = 0.5;

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

/** The fields of `webRequest.onBeforeRequest` details this module reads. */
export interface RequestDetails extends NavigationDetails {
  /** `main_frame` for the document of a tab (the listener's filter). */
  type?: string;
  /** Chromium: origin of the document that started the request; absent for browser UI. */
  initiator?: string;
  /** Firefox: URL of the document that started the request; absent for browser UI. */
  originUrl?: string;
}

/** The fields of `webNavigation.onCreatedNavigationTarget` details this module reads. */
export interface CreatedTargetDetails {
  tabId: number;
  sourceTabId: number;
  url: string;
}

/**
 * `scheme://host[:port]` of an http(s) or extension URL (or of an origin, as Chromium's
 * `initiator` gives it); `null` for opaque origins (`null`, `about:`, `data:`…) and
 * invalid input.
 */
export function originOf(url: string | undefined): string | null {
  if (url === undefined || url === 'null') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = parsed.protocol;
  const web = scheme === 'http:' || scheme === 'https:';
  if (!web && scheme !== 'chrome-extension:' && scheme !== 'moz-extension:') return null;
  if (parsed.host.length === 0) return null;
  return `${scheme}//${parsed.host}`.toLowerCase();
}

export interface PageDrivenInput {
  transitionQualifiers?: readonly string[];
  /**
   * Origin that started the navigation (`originOf` the request's initiator); `null` for
   * the browser itself or an opaque origin, `undefined` when no request was seen.
   */
  initiator?: string | null;
  /** Origin of the document the tab showed when the navigation started, if known. */
  documentOrigin?: string;
  /** When a page opened the tab, while it has shown no web page yet. */
  openedByPageAt?: number;
  now: number;
}

/**
 * Whether a top-level navigation was started by a web page rather than by the user (see
 * the module comment): it is still blocked, but never counted.
 */
export function startedByPage(input: PageDrivenInput): boolean {
  if (input.transitionQualifiers?.includes('client_redirect') === true) return true;
  const initiator = input.initiator;
  if (initiator === undefined || initiator === null) return false;
  if (input.documentOrigin !== undefined) return initiator !== input.documentOrigin;
  if (input.openedByPageAt !== undefined) {
    return input.now - input.openedByPageAt > OPENED_TAB_GRACE_MS;
  }
  return false;
}

const OPAQUE_SCHEMES = ['data:', 'file:', 'blob:'];

/** True for the top-level documents the whitelist redirect never sees (`data:`, `file:`, `blob:`). */
export function isOpaqueDocumentUrl(url: string): boolean {
  const lower = url.slice(0, 5).toLowerCase();
  return OPAQUE_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Whether the rules in force block a top-level `data:`, `file:` or `blob:` document: only
 * while a whitelist is in force, and a `blob:` of a web origin follows that origin.
 */
export function matchOpaqueDocument(rules: ExtRulesResponse | null, url: string): HostMatch {
  const none: HostMatch = { blocked: false, via: null, block: null };
  if (rules === null || rules.whitelist === null || !isOpaqueDocumentUrl(url)) return none;
  if (url.slice(0, 5).toLowerCase() === 'blob:') {
    const host = hostFromUrl(url.slice(5));
    if (host !== null) return matchHost(rules, host);
  }
  let block: HostMatch['block'] = null;
  for (const candidate of rules.blocks) {
    if (!candidate.whitelistOnly) continue;
    if (block === null || Date.parse(candidate.endsAt) >= Date.parse(block.endsAt)) {
      block = candidate;
    }
  }
  return { blocked: true, via: 'whitelist', block };
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
  /** A top-level request of a tab started: remembers who started it (see `startedByPage`). */
  onBeforeRequest(details: RequestDetails): void;
  /** A page opened a tab (a link with a target, `window.open`). */
  onCreatedNavigationTarget(details: CreatedTargetDetails): void;
  /** Resolves when the commit is fully handled (including the guardian's answer). */
  onCommitted(details: CommitDetails): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  /**
   * Moves open tabs on a host `rules` block to blocked.html (except those moved less than
   * `MOVE_GRACE_MS` ago); returns the ids it asked the browser to move. Idempotent: run
   * after rule changes and on every tick.
   */
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
  /** webRequest already reported the redirect to blocked.html (`url` is the blocked site). */
  reported?: boolean;
}

/**
 * Firefox: a commit of DNR's redirect waiting for webRequest's late report of it (see the
 * module comment), with what the tab showed before that commit.
 */
interface RedirectWait {
  /** Ends the wait with the blocked site's URL, or `null` without a report. */
  finish(url: string | null): void;
  from: string | undefined;
  openedAt: number | undefined;
}

/** Who started a tab's latest top-level request (`webRequest.onBeforeRequest`). */
interface RequestOrigin {
  initiator: string | null;
  /** The tab's document origin when it started (`undefined`: unknown). */
  from: string | undefined;
  openedAt: number | undefined;
  at: number;
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
    // A daily limit's block (reported as `manual`, §8.4): blocked.html words it differently.
    ...(typeof block.limitId === 'string' ? { limitId: block.limitId } : {}),
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
  /** Origin of the document each tab committed last (http(s) or this extension). */
  const documentOrigins = new Map<number, string>();
  const requestOrigins = new Map<number, RequestOrigin>();
  /** Tabs a page opened that have committed nothing since, with when. */
  const openedByPage = new Map<number, number>();
  /** Tabs this module asked the browser to move to blocked.html, with when. */
  const moves = new Map<number, number>();
  const redirectWaits = new Map<number, RedirectWait>();
  const extensionOrigin = originOf(base);

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
    byPage: boolean,
  ): Promise<void> {
    const tabId = details.tabId;
    const at = now();
    const serviceId = findServiceByDomain(nav.host)?.id ?? null;
    let info: BlockedTabInfo = {
      v: 1,
      tabId,
      host: nav.host,
      url: storedUrl(nav.url),
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
      await save(byPage ? { ...info, status: 'not_counted', pointsDelta: 0 } : info);
      await move(tabId, pageUrl(info.cause, serviceId, false));
    }
    if (byPage) {
      // Blocked all the same, but a page cannot cost the user points (cheat matrix #28).
      await save({ ...info, status: 'not_counted', pointsDelta: 0 });
      return;
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

  /**
   * Asks the browser to show `url` in `tabId`. A resolved update is not proof: a
   * «¿Salir del sitio?» the user cancels keeps the page, so the sweep checks again once
   * `MOVE_GRACE_MS` has passed.
   */
  async function move(tabId: number, url: string): Promise<boolean> {
    moves.set(tabId, now());
    try {
      await deps.tabs.update(tabId, { url });
      return true;
    } catch (error) {
      // Closed meanwhile, or «Tabs cannot be edited right now» during a tab drag: the next
      // sweep retries.
      moves.delete(tabId);
      warn('Céntrate: could not move a tab to the blocked page', error);
      return false;
    }
  }

  /**
   * Moves `tabId`, on `url` that `match` blocks, to blocked.html without points. `url` and
   * `host` are `null` for a whitelist escape (a `data:` URL can be megabytes long).
   */
  async function enforceTab(
    tabId: number,
    url: string | null,
    host: string | null,
    rules: ExtRulesResponse | null,
    match: HostMatch,
  ): Promise<boolean> {
    const serviceId = host === null ? null : (findServiceByDomain(host)?.id ?? null);
    const cause = match.via ?? 'domain';
    await save({
      v: 1,
      tabId,
      host,
      url: storedUrl(url),
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
    return move(tabId, pageUrl(cause, serviceId, true));
  }

  /**
   * Firefox: waits for webRequest's report of DNR's redirect in `tabId` (the blocked site's
   * URL); `null` after `REDIRECT_REPORT_MS` or when the tab moves on without one.
   */
  function redirectReport(
    tabId: number,
    before: Pick<RedirectWait, 'from' | 'openedAt'>,
  ): Promise<string | null> {
    redirectWaits.get(tabId)?.finish(null);
    return new Promise((resolve) => {
      const wait: RedirectWait = {
        ...before,
        finish: (url) => {
          clearTimeout(timer);
          if (redirectWaits.get(tabId) === wait) redirectWaits.delete(tabId);
          resolve(url);
        },
      };
      const timer = setTimeout(() => wait.finish(null), REDIRECT_REPORT_MS);
      redirectWaits.set(tabId, wait);
    });
  }

  /** Who started the navigation that commits now (consumed: one per commit). */
  function takeRequestOrigin(tabId: number): RequestOrigin | undefined {
    const entry = requestOrigins.get(tabId);
    requestOrigins.delete(tabId);
    return entry !== undefined && now() - entry.at <= NAV_MATCH_MS ? entry : undefined;
  }

  /** After a top-level commit: the tab now shows a document of `origin` (or unknown). */
  function committedIn(tabId: number, origin: string | null): void {
    moves.delete(tabId);
    openedByPage.delete(tabId);
    if (origin === null) documentOrigins.delete(tabId);
    else documentOrigins.set(tabId, origin);
  }

  async function handleCommit(details: CommitDetails): Promise<void> {
    const tabId = details.tabId;
    const nav = pending.get(tabId);
    pending.delete(tabId);
    let started = nav !== undefined && now() - nav.at <= NAV_MATCH_MS ? nav : undefined;
    const blockedPage = isBlockedPageUrl(details.url, base);
    const serverRedirect = details.transitionQualifiers?.includes('server_redirect') === true;
    const before = { from: documentOrigins.get(tabId), openedAt: openedByPage.get(tabId) };
    committedIn(tabId, blockedPage ? extensionOrigin : originOf(details.url));

    if (blockedPage && started?.superseded === true && serverRedirect && !started.reported) {
      // Firefox, DNR's redirect committed before webRequest reported it: the report says
      // which site was blocked (not the redirector the navigation started at), and comes
      // after the request's onBeforeRequest (who started it).
      const url = await redirectReport(tabId, before);
      const host = url === null ? null : hostFromUrl(url);
      if (url !== null && host !== null) started = { ...started, url, host };
    }
    const request = takeRequestOrigin(tabId);
    const byPage = startedByPage({
      transitionQualifiers: details.transitionQualifiers,
      initiator: request?.initiator,
      documentOrigin: request?.from,
      openedByPageAt: request?.openedAt,
      now: now(),
    });

    if (blockedPage) {
      // Opened by the extension (its info is already written), by hand or by another page:
      // only a redirect of a navigation seen at onBeforeNavigate is an attempt, for the URL
      // DNR redirected (onBeforeRedirect), not the redirector the navigation started at.
      if (started === undefined) return;
      if (started.superseded && !serverRedirect) return;
      const rules = await deps.getEffectiveRules();
      await detect(details, started, 'redirected', rules, matchHost(rules, started.host), byPage);
      return;
    }

    const host = hostFromUrl(details.url);
    if (host === null) {
      if (isOpaqueDocumentUrl(details.url)) {
        const rules = await deps.getEffectiveRules();
        const match = matchOpaqueDocument(rules, details.url);
        if (match.blocked) {
          await enforceTab(tabId, null, null, rules, match);
          return;
        }
      }
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
    await detect(details, { url: details.url, host, at: now() }, 'committed', rules, match, byPage);
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
      // A new navigation: a commit still waiting for the previous one's report goes on.
      redirectWaits.get(details.tabId)?.finish(null);
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
      const toBlockedPage = isBlockedPageUrl(details.redirectUrl, base);
      const url = toBlockedPage ? details.url : details.redirectUrl;
      const wait = redirectWaits.get(details.tabId);
      if (wait !== undefined) {
        // Late (Firefox): the commit already took the navigation and waits for DNR's hop.
        if (toBlockedPage) wait.finish(url);
        return;
      }
      const host = hostFromUrl(url);
      if (host === null) {
        pending.delete(details.tabId);
        return;
      }
      // Firefox may report a hop after blocked.html's onBeforeNavigate: still superseded.
      const superseded = pending.get(details.tabId)?.superseded === true;
      pending.set(details.tabId, {
        url,
        host,
        at: now(),
        ...(superseded ? { superseded } : {}),
        ...(toBlockedPage ? { reported: true } : {}),
      });
    },

    onBeforeRequest(details) {
      if (!isTopLevelActive(details)) return;
      if (details.type !== undefined && details.type !== 'main_frame') return;
      // Chromium: `initiator` is an origin; Firefox: `originUrl` is the document's URL.
      const source = details.initiator ?? details.originUrl;
      // Late (Firefox): the tab already committed blocked.html; what it showed before counts.
      const wait = redirectWaits.get(details.tabId);
      requestOrigins.set(details.tabId, {
        initiator: originOf(source),
        from: wait !== undefined ? wait.from : documentOrigins.get(details.tabId),
        openedAt: wait !== undefined ? wait.openedAt : openedByPage.get(details.tabId),
        at: now(),
      });
    },

    onCreatedNavigationTarget(details) {
      if (details.tabId < 0) return;
      documentOrigins.delete(details.tabId);
      openedByPage.set(details.tabId, now());
    },

    onCommitted(details) {
      // Prerender commits are skipped: activation fires onBeforeNavigate/onCommitted again
      // as `active`.
      if (!isTopLevelActive(details)) return Promise.resolve();
      return inTab(details.tabId, () => handleCommit(details));
    },

    async onTabRemoved(tabId) {
      redirectWaits.get(tabId)?.finish(null);
      pending.delete(tabId);
      documentOrigins.delete(tabId);
      requestOrigins.delete(tabId);
      openedByPage.delete(tabId);
      moves.delete(tabId);
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
        const { id, url } = tab;
        if (id === undefined || id < 0 || url === undefined) continue;
        const host = hostFromUrl(url);
        if (host === null) continue;
        const match = matchHost(rules, host);
        if (!match.blocked) continue;
        // In the tab's queue, so a commit being handled (the safety net moving it) goes first.
        await inTab(id, async () => {
          const movedAt = moves.get(id);
          if (movedAt !== undefined && now() - movedAt < MOVE_GRACE_MS) return;
          pending.delete(id);
          if (await enforceTab(id, url, host, rules, match)) moved.push(id);
        });
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
 * `webRequest` is the non-blocking permission (MV3 in Chrome and Firefox): the listeners
 * only read who started a tab's top-level request and where it was redirected.
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
  // Whitelist escapes (data:, file:, blob: documents): commits only.
  const opaque = { schemes: ['data', 'file', 'blob'] };
  const requestFilter: chrome.webRequest.RequestFilter = {
    urls: ['http://*/*', 'https://*/*'],
    types: ['main_frame'],
  };

  const before = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails): void => {
    tracker.onBeforeNavigate(details);
  };
  const created = (details: chrome.webNavigation.WebNavigationSourceCallbackDetails): void => {
    tracker.onCreatedNavigationTarget(details);
  };
  const requested = (details: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    tracker.onBeforeRequest(details as RequestDetails);
    return undefined;
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
    nav.onCommitted.addListener(committed, { url: [...web, page, opaque] });
    nav.onCreatedNavigationTarget.addListener(created);
  }
  if (request === undefined) {
    console.warn('Céntrate: webRequest is unavailable; redirected attempts keep the first URL');
  } else {
    request.onBeforeRequest.addListener(requested, requestFilter);
    request.onBeforeRedirect.addListener(redirected, requestFilter);
  }
  chrome.tabs.onRemoved.addListener(removed);
  return () => {
    nav?.onBeforeNavigate.removeListener(before);
    nav?.onCommitted.removeListener(committed);
    nav?.onCreatedNavigationTarget.removeListener(created);
    request?.onBeforeRequest.removeListener(requested);
    request?.onBeforeRedirect.removeListener(redirected);
    chrome.tabs.onRemoved.removeListener(removed);
  };
}

/**
 * Sweeps the open tabs on every tick (`TICK_ALARM`, the core's 30 s alarm in the main
 * instance), so a move that failed or was cancelled is retried while the block lasts. The
 * incognito instance of Chromium's split mode has no core tick: `follower` creates
 * `SWEEP_ALARM` there.
 */
export function installOpenTabSweep(sweep: () => Promise<unknown>, follower: boolean): () => void {
  const warn = (error: unknown): void => console.warn('Céntrate: open-tab sweep failed', error);
  const alarms = chrome.alarms as typeof chrome.alarms | undefined;
  if (alarms === undefined) return () => undefined;
  const onAlarm = (alarm: chrome.alarms.Alarm): void => {
    if (alarm.name === TICK_ALARM || alarm.name === SWEEP_ALARM) sweep().catch(warn);
  };
  alarms.onAlarm.addListener(onAlarm);
  if (follower) {
    alarms
      .get(SWEEP_ALARM)
      .then(async (existing) => {
        if (existing?.periodInMinutes === SWEEP_PERIOD_MINUTES) return;
        await alarms.create(SWEEP_ALARM, {
          delayInMinutes: SWEEP_PERIOD_MINUTES,
          periodInMinutes: SWEEP_PERIOD_MINUTES,
        });
      })
      .catch(warn);
  }
  return () => alarms.onAlarm.removeListener(onAlarm);
}

export interface AttemptsPluginOptions {
  /** The tracker (created on first use in the worker: it needs `chrome`). */
  tracker: () => AttemptTracker;
  /** Called once per worker start with the core's API (the worker installs listeners). */
  install?: (api: BackgroundApi) => void;
}

/** The attempts plugin around a tracker (`attemptsPlugin` is the worker's). */
export function createAttemptsPlugin(options: AttemptsPluginOptions): BackgroundPlugin {
  return {
    name: 'attempts',
    start(api) {
      options.install?.(api);
    },
    // Chromium's incognito instance: the main instance cannot see its tabs (split mode).
    async followRules(rules) {
      await options.tracker().enforceOpenTabs(rules);
    },
    handleMessage(message, sender) {
      if (!isBlockedInfoRequest(message)) return undefined;
      return options.tracker().handleMessage(sender);
    },
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

export const attemptsPlugin: BackgroundPlugin = createAttemptsPlugin({
  tracker: trackerForWorker,
  install(api) {
    backgroundApi = api;
    for (const resolve of apiWaiters.splice(0)) resolve(api);
    const tracker = trackerForWorker();
    installAttemptListeners(tracker, chrome.runtime.getURL(''));
    installOpenTabSweep(
      async () => tracker.enforceOpenTabs(await api.getEffectiveRules()),
      chrome.extension?.inIncognitoContext === true,
    );
  },
});

registerBackgroundPlugin(attemptsPlugin);

onDnrRulesChanged(async (rules) => {
  await trackerForWorker().enforceOpenTabs(rules);
});
