/**
 * Daily-limit usage (docs/ARCHITECTURE.md §5.10, §10.13): the extension counts the time the
 * user spends on limited sites and reports it with `POST /v1/usage`; the guardian decides
 * when an allowance runs out and blocks the site with an ordinary block (limit blocks reach
 * the extension as `kind: "manual"` with `limitId`, §8.4). Nothing here blocks anything.
 *
 * **What counts.** Only while the rules in force carry a non-empty `limits` (guardians
 * without `daily_limits` send none, and then nothing is counted or reported). A second
 * counts for the **active tab of the focused window** when that window has the focus, the
 * tab is an http(s) page whose host equals or is under one of some limit's `domains` and
 * not under that limit's `excludedDomains`, and either `chrome.idle` says `active`
 * (threshold `usageIdleSeconds`, 60 s) or the tab is `audible` (a video playing while the
 * user just watches). `locked` never counts. Only the tab's canonical host
 * (`www.youtube.com`) is ever reported, never a URL or another host.
 *
 * **How it is counted.** Event driven, so an MV3 worker that sleeps loses nothing: the
 * current «segment» (`{host, since}`) lives in `chrome.storage.session`, and every event
 * that can change the answer (tab activated or updated, window focus, idle state) closes it
 * (its time is credited to its host) and opens the next one. While a segment is open a
 * `FLUSH_MS` timer (and the core's 30 s alarm) closes and reopens it, so a long video
 * without any event keeps being counted and reported. One closing never credits more than
 * `MAX_SEGMENT_MS` (one flush plus one alarm period): a computer that slept with a tab open
 * (no event, no alarm) is not charged for the night, and the guardian clamps each report to
 * the time the machine was awake. A segment of Chromium's incognito instance older than
 * that (the instance was not running: closed, the browser restarted) credits nothing.
 *
 * **Reporting.** Every `usageReportIntervalMs` (30 s) while there are unreported seconds,
 * every `usageFastReportIntervalMs` (5 s) while the counted site has a limit that applies
 * today with less than 30 s left (from the last answer, minus what is still unreported) or
 * while there is no recent answer (so the badge shows up quickly). `intervalMs` is the time
 * since the last successful report (else since the first unreported second), clamped to
 * 1 s … `usageMaxIntervalMs`. **Never retried:** a report the guardian refused (an error
 * status: nothing was credited) keeps its seconds pending for the next report; a report
 * without an answer (no connection, timeout, the worker died before the answer was applied)
 * may have been credited, so its seconds are dropped and the next report starts after it
 * (a report is never counted twice). Seconds older than `usageMaxIntervalMs` are dropped
 * (oldest first), and at most `usageMaxItems` hosts are kept (most recent).
 *
 * **Chromium's incognito instance** (split mode, index.ts) only sees incognito windows and
 * the main one never sees them, so the two never count the same second. The incognito
 * instance never reports (one client per token for the guardian's clamps): it adds its
 * seconds to per-host running totals in `chrome.storage.local`
 * (`USAGE_KEYS.incognitoTotals`, which both instances share), and the main instance folds
 * what grew since it last looked (`USAGE_KEYS.incognitoSeen`) into its next report.
 * Firefox has no split mode: its private windows are seen by the one instance.
 *
 * **Badge** (optional, §10.13): on the active tab of the last focused window, when its site
 * has a limit that applies today, the minutes left («12m») from the last usage answer minus
 * what has not been reported yet, orange for the last 5 minutes; the tooltip says it in
 * words («Te quedan 12 min de YouTube hoy»). Other tabs keep no badge.
 *
 * Under-reporting (extension disabled, not paired, another browser) is a known limit: the
 * guardian only knows what its clients report (§10.13 «Honest limits»).
 */

import { isSameOrSubdomain, normalizeDomain } from '@centrate/shared/catalog';
import { colors } from '@centrate/shared/design/tokens';
import type {
  ExtRuleLimit,
  LimitUsageStatus,
  UsageItem,
  UsageReportRequest,
} from '@centrate/shared/guardian-api';
import { GUARDIAN_LIMITS, isUsageReportResponse } from '@centrate/shared/guardian-api';
import { PAGES } from '../pages/i18n';
import { SWEEP_ALARM, TICK_ALARM } from './attempts';
import { hostFromUrl } from './rules';
import type { BackgroundApi, BackgroundPlugin, UsageReportOutcome } from './state';
import { registerBackgroundPlugin } from './state';
import type { StorageAreaLike } from './storage';
import { STORAGE_KEYS } from './storage';

// ---------------------------------------------------------------------------------------
// Timing and storage keys
// ---------------------------------------------------------------------------------------

/** While a segment is open it is closed and reopened this often (and reported when due). */
export const FLUSH_MS = 15_000;
/** The period of the core's alarms that wake a sleeping worker (`TICK_ALARM`). */
const ALARM_PERIOD_MS = 30_000;
/**
 * Most one segment closing may credit. The segment is closed at least every `FLUSH_MS`
 * while the worker runs and on every 30 s alarm otherwise, so only a gap with no timer and
 * no alarm (the computer asleep, the worker gone) reaches it.
 */
export const MAX_SEGMENT_MS = FLUSH_MS + ALARM_PERIOD_MS;
/** A usage answer older than this is not shown on the badge (and asks for a fast report). */
export const STATUS_FRESH_MS = 5 * 60_000;
/** Below this many seconds left, reports go every `usageFastReportIntervalMs`. */
export const FAST_REMAINING_SECONDS = GUARDIAN_LIMITS.usageReportIntervalMs / 1_000;
/** The badge turns orange with this many seconds left (the guardian's warning threshold). */
export const BADGE_WARNING_SECONDS = GUARDIAN_LIMITS.limitWarningSeconds;

export const USAGE_KEYS = Object.freeze({
  /** Main instance, `chrome.storage.session`: segment, pending seconds, report times. */
  state: 'centrate.usage',
  /** `chrome.storage.local`: the last usage answer (both instances show it on the badge). */
  status: 'centrate.usage.status',
  /** `chrome.storage.local`, written by Chromium's incognito instance only. */
  incognitoTotals: 'centrate.usage.incognito',
  /** `chrome.storage.local`, written by the main instance only. */
  incognitoSeen: 'centrate.usage.incognitoSeen',
});

// ---------------------------------------------------------------------------------------
// Pure part
// ---------------------------------------------------------------------------------------

/** The limits whose usage a visit to `host` (canonical) counts toward. */
export function limitsForHost(limits: readonly ExtRuleLimit[], host: string): ExtRuleLimit[] {
  return limits.filter(
    (limit) =>
      limit.domains.some((d) => isSameOrSubdomain(host, d)) &&
      !limit.excludedDomains.some((d) => isSameOrSubdomain(host, d)),
  );
}

export type IdleState = 'active' | 'idle' | 'locked';

/** What decides whether this second counts (read from the browser at each event). */
export interface UsageEnv {
  /** A browser window of this instance has the focus. */
  focused: boolean;
  /** The active tab of the last focused window (`null`: none). */
  tab: { id: number; url: string | null; audible: boolean } | null;
  idle: IdleState;
}

/** The canonical host of a limited site the active tab shows, or `null`. */
export function limitedHost(tab: UsageEnv['tab'], limits: readonly ExtRuleLimit[]): string | null {
  if (tab === null || tab.url === null) return null;
  const raw = hostFromUrl(tab.url);
  const host = raw === null ? null : normalizeDomain(raw);
  if (host === null || limitsForHost(limits, host).length === 0) return null;
  return host;
}

/** The host whose usage runs now (§10.13 «What counts»), or `null`. */
export function countedHost(env: UsageEnv, limits: readonly ExtRuleLimit[]): string | null {
  if (!env.focused || env.tab === null || env.idle === 'locked') return null;
  if (env.idle !== 'active' && !env.tab.audible) return null;
  return limitedHost(env.tab, limits);
}

/** Unreported milliseconds per host, least recently credited first. */
export type PendingUsage = Array<[host: string, ms: number]>;

/** Adds `ms` to `host` and moves it last (most recent). Returns a new list. */
export function creditPending(pending: PendingUsage, host: string, ms: number): PendingUsage {
  if (ms <= 0) return pending;
  const previous = pending.find(([h]) => h === host)?.[1] ?? 0;
  return [...pending.filter(([h]) => h !== host), [host, previous + ms]];
}

/**
 * Keeps at most `maxMs` in total and `maxItems` hosts, dropping the least recent first
 * (a report never covers more than `usageMaxIntervalMs`).
 */
export function trimPending(
  pending: PendingUsage,
  maxMs: number = GUARDIAN_LIMITS.usageMaxIntervalMs,
  maxItems: number = GUARDIAN_LIMITS.usageMaxItems,
): PendingUsage {
  const out: PendingUsage = [];
  let budget = Math.max(0, maxMs);
  for (let i = pending.length - 1; i >= 0 && out.length < maxItems && budget > 0; i -= 1) {
    const [host, ms] = pending[i] as [string, number];
    const kept = Math.min(ms, budget);
    if (kept <= 0) continue;
    out.unshift([host, kept]);
    budget -= kept;
  }
  return out;
}

/** True when some host has a whole second to report (items carry whole seconds). */
export function hasWholeSecond(pending: PendingUsage): boolean {
  return pending.some(([, ms]) => ms >= 1_000);
}

export interface PlannedReport {
  body: UsageReportRequest;
  /** Milliseconds each item accounts for (subtracted from `pending` on success). */
  sent: PendingUsage;
  /** `pending` after dropping what no longer fits a report (applied whatever the answer). */
  pending: PendingUsage;
}

/**
 * The report to send at `nowMs` for `pending` and the span that started at `windowStart`,
 * or `null` when there is not a whole second to report or the span is under 1 s.
 */
export function planReport(
  pending: PendingUsage,
  windowStart: number | null,
  nowMs: number,
): PlannedReport | null {
  if (windowStart === null) return null;
  const span = nowMs - windowStart;
  if (!(span >= 1_000)) return null;
  const intervalMs = Math.min(Math.round(span), GUARDIAN_LIMITS.usageMaxIntervalMs);
  const maxSeconds = Math.ceil(intervalMs / 1_000);
  const kept = trimPending(pending, maxSeconds * 1_000);
  const items: UsageItem[] = [];
  const sent: PendingUsage = [];
  for (const [host, ms] of kept) {
    const seconds = Math.min(Math.floor(ms / 1_000), maxSeconds);
    if (seconds < 1) continue;
    items.push({ type: 'domain', value: host, seconds });
    sent.push([host, seconds * 1_000]);
  }
  if (items.length === 0) return null;
  return { body: { intervalMs, items }, sent, pending: kept };
}

/** `pending` minus what a successful report accounted for (hosts at 0 disappear). */
export function subtractSent(pending: PendingUsage, sent: PendingUsage): PendingUsage {
  const out: PendingUsage = [];
  for (const [host, ms] of pending) {
    const left = ms - (sent.find(([h]) => h === host)?.[1] ?? 0);
    if (left > 0) out.push([host, left]);
  }
  return out;
}

/** The last usage answer, as stored for the badge. */
export interface UsageStatusRecord {
  v: 1;
  /** `Date.now()` when it arrived. */
  at: number;
  day: string;
  limits: LimitUsageStatus[];
}

export function freshStatus(
  record: UsageStatusRecord | null,
  nowMs: number,
): UsageStatusRecord | null {
  if (record === null) return null;
  const age = nowMs - record.at;
  return age >= 0 && age <= STATUS_FRESH_MS ? record : null;
}

/** What is left today of one limit the site counts toward (the smallest if several). */
export interface LimitLeft {
  limit: ExtRuleLimit;
  /** Seconds left: the last answer minus what was counted and not reported since. */
  seconds: number;
}

/**
 * The limit of `host` that applies today with the least time left, from the last answer
 * `status` minus `unreportedMs(host)` of the hosts that count toward it; `null` without a
 * fresh answer, when no limit applies today, or once a limit block runs (the tab is about
 * to be redirected).
 */
export function limitLeftFor(
  host: string,
  limits: readonly ExtRuleLimit[],
  status: UsageStatusRecord | null,
  unreported: PendingUsage,
): LimitLeft | null {
  if (status === null) return null;
  let best: LimitLeft | null = null;
  for (const limit of limitsForHost(limits, host)) {
    const entry = status.limits.find((l) => l.limitId === limit.id);
    if (entry === undefined || !entry.appliesToday || !limit.appliesToday) continue;
    if (entry.blockedUntil !== null) continue;
    const extraMs = unreported
      .filter(([h]) => limitsForHost([limit], h).length > 0)
      .reduce((sum, [, ms]) => sum + ms, 0);
    const seconds = Math.max(0, entry.remainingTodaySeconds - Math.floor(extraMs / 1_000));
    if (best === null || seconds < best.seconds) best = { limit, seconds };
  }
  return best;
}

/** Whole minutes shown for `seconds` left (rounded up: «1m» until the very end). */
export function minutesLeft(seconds: number): number {
  return Math.ceil(Math.max(0, seconds) / 60);
}

export interface BadgeSpec {
  text: string;
  title: string;
  color: string;
}

/** The toolbar badge for a site with `left` (light tokens: the badge has no dark variant). */
export function badgeFor(left: LimitLeft | null): BadgeSpec | null {
  if (left === null) return null;
  const minutes = minutesLeft(left.seconds);
  const u = PAGES.usage;
  return {
    text: u.badgeText(minutes),
    title: u.badgeTitle(minutes, left.limit.name),
    color: left.seconds <= BADGE_WARNING_SECONDS ? colors.light.orange : colors.light.blue,
  };
}

/**
 * When the next report is due (epoch ms), `null` with nothing to report. After any attempt
 * (answered or not) the next one waits a full interval: failed reports are never retried,
 * their seconds go with the next one.
 */
export function nextReportAt(input: {
  pending: PendingUsage;
  windowStart: number | null;
  lastAttemptAt: number | null;
  fast: boolean;
}): number | null {
  if (input.windowStart === null || !hasWholeSecond(input.pending)) return null;
  const period = input.fast
    ? GUARDIAN_LIMITS.usageFastReportIntervalMs
    : GUARDIAN_LIMITS.usageReportIntervalMs;
  const earliest = input.windowStart + 1_000;
  return input.lastAttemptAt === null ? earliest : Math.max(earliest, input.lastAttemptAt + period);
}

// ---------------------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------------------

export interface Segment {
  host: string;
  /** `Date.now()` when it opened. */
  since: number;
}

/** The main instance's record (`chrome.storage.session`: memory only, per browser run). */
export interface UsageStateRecord {
  v: 1;
  segment: Segment | null;
  pending: PendingUsage;
  /** Start of the span the next report covers (last successful report, else first second). */
  windowStart: number | null;
  lastAttemptAt: number | null;
  /** The tab that shows a badge now (cleared when another one gets it). */
  badgeTabId: number | null;
}

/** Chromium's incognito instance's record (`chrome.storage.local`, shared with the main one). */
export interface IncognitoTotalsRecord {
  v: 1;
  segment: Segment | null;
  /** Milliseconds counted per host since the record was created (only grows). */
  totals: Record<string, number>;
  badgeTabId: number | null;
}

export const EMPTY_STATE: Readonly<UsageStateRecord> = Object.freeze({
  v: 1,
  segment: null,
  pending: [],
  windowStart: null,
  lastAttemptAt: null,
  badgeTabId: null,
});

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const isMsOrNull = (v: unknown): v is number | null => v === null || isMs(v);
const isHost = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 253 && normalizeDomain(v) === v;
const isTabIdOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v));

function parseSegment(v: unknown): Segment | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || !isHost(v['host']) || !isMs(v['since'])) return undefined;
  return { host: v['host'], since: v['since'] };
}

export function parseUsageState(v: unknown): UsageStateRecord {
  if (!isObject(v) || v['v'] !== 1) return { ...EMPTY_STATE };
  const segment = parseSegment(v['segment']);
  const pending = v['pending'];
  const ok =
    segment !== undefined &&
    Array.isArray(pending) &&
    pending.length <= GUARDIAN_LIMITS.usageMaxItems &&
    pending.every((e) => Array.isArray(e) && e.length === 2 && isHost(e[0]) && isMs(e[1])) &&
    isMsOrNull(v['windowStart']) &&
    isMsOrNull(v['lastAttemptAt']) &&
    isTabIdOrNull(v['badgeTabId'] ?? null);
  if (!ok) return { ...EMPTY_STATE };
  return {
    v: 1,
    segment: segment ?? null,
    pending: (pending as Array<[string, number]>).map(([h, ms]) => [h, ms]),
    windowStart: v['windowStart'] as number | null,
    lastAttemptAt: v['lastAttemptAt'] as number | null,
    badgeTabId: (v['badgeTabId'] ?? null) as number | null,
  };
}

function parseTotals(v: unknown): Record<string, number> | null {
  if (!isObject(v)) return null;
  const out: Record<string, number> = {};
  const entries = Object.entries(v);
  if (entries.length > 1_000) return null;
  for (const [host, ms] of entries) {
    if (!isHost(host) || !isMs(ms)) return null;
    out[host] = ms;
  }
  return out;
}

export function parseIncognitoTotals(v: unknown): IncognitoTotalsRecord {
  const empty: IncognitoTotalsRecord = { v: 1, segment: null, totals: {}, badgeTabId: null };
  if (!isObject(v) || v['v'] !== 1) return empty;
  const segment = parseSegment(v['segment']);
  const totals = parseTotals(v['totals']);
  if (segment === undefined || totals === null || !isTabIdOrNull(v['badgeTabId'] ?? null)) {
    return empty;
  }
  return { v: 1, segment, totals, badgeTabId: (v['badgeTabId'] ?? null) as number | null };
}

export function parseIncognitoSeen(v: unknown): Record<string, number> {
  return parseTotals(v) ?? {};
}

export function parseUsageStatus(v: unknown): UsageStatusRecord | null {
  if (!isObject(v) || v['v'] !== 1 || !isMs(v['at'])) return null;
  const answer = { day: v['day'], limits: v['limits'], serverNow: '1970-01-01T00:00:00.000Z' };
  if (!isUsageReportResponse(answer)) return null;
  return { v: 1, at: v['at'], day: answer.day, limits: answer.limits };
}

/** What grew in the incognito totals since `seen` (a total that shrank starts over). */
export function incognitoDelta(
  totals: Record<string, number>,
  seen: Record<string, number>,
): PendingUsage {
  const out: PendingUsage = [];
  for (const [host, total] of Object.entries(totals)) {
    const before = seen[host] ?? 0;
    const delta = total >= before ? total - before : total;
    if (delta > 0) out.push([host, delta]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------

export interface BadgeApi {
  /** Shows `badge` on `tabId`, or clears it (`null`). Errors (a closed tab) are ignored. */
  set(tabId: number, badge: BadgeSpec | null): Promise<void>;
}

export interface UsageTrackerDeps {
  /** `follower`: Chromium's incognito instance (counts, never reports). */
  role: 'main' | 'follower';
  now?: () => number;
  /** The limits of the rules in force (`[]` or absent: nothing is counted). */
  getLimits(): Promise<readonly ExtRuleLimit[]>;
  readEnv(): Promise<UsageEnv>;
  /** `POST /v1/usage` (never retried; see `UsageReportOutcome`). */
  report(body: UsageReportRequest): Promise<UsageReportOutcome>;
  /** `chrome.storage.session` (the main instance's record). */
  session: StorageAreaLike;
  /** `chrome.storage.local` (answers and the incognito totals, shared by both instances). */
  local: StorageAreaLike;
  badge?: BadgeApi;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warn?: (message: string, error?: unknown) => void;
}

export interface UsageTracker {
  /** Something that may change what counts happened: re-evaluate now. */
  update(): Promise<void>;
  /** The periodic alarm: same as `update` (closes the segment, reports when due). */
  tick(): Promise<void>;
  /** Resolves when queued work and any report in flight are done (tests). */
  idle(): Promise<void>;
}

export function createUsageTracker(deps: UsageTrackerDeps): UsageTracker {
  const now = deps.now ?? (() => Date.now());
  const warn = deps.warn ?? ((message, error) => console.warn(`Céntrate: ${message}`, error));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const follower = deps.role === 'follower';
  let queue: Promise<void> = Promise.resolve();
  let inflight: Promise<void> | null = null;
  let timer: unknown = null;
  /** What this worker last showed on the badge (`tabId|text|title|color`), to skip repeats. */
  let shownBadge: string | null = null;

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task).catch((error: unknown) => warn('usage step failed', error));
    queue = run;
    return run;
  };

  async function readLocal<T>(key: string, parse: (v: unknown) => T): Promise<T> {
    const items = await deps.local.get([key]);
    return parse(items[key]);
  }

  async function readState(): Promise<UsageStateRecord> {
    const items = await deps.session.get([USAGE_KEYS.state]);
    return parseUsageState(items[USAGE_KEYS.state]);
  }

  /** Credits `segment` up to `at`, at most `MAX_SEGMENT_MS`. */
  const segmentMs = (segment: Segment | null, at: number): number =>
    segment === null ? 0 : Math.min(Math.max(0, at - segment.since), MAX_SEGMENT_MS);
  /**
   * The follower's segment lives in `chrome.storage.local`, which outlives the instance: one
   * older than `MAX_SEGMENT_MS` was left by an instance that stopped, and credits nothing.
   */
  const followerSegmentMs = (segment: Segment | null, at: number): number => {
    if (segment === null) return 0;
    const gap = at - segment.since;
    return gap < 0 || gap > MAX_SEGMENT_MS ? 0 : gap;
  };

  function schedule(delay: number | null): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (delay === null) return;
    timer = setTimer(
      () => {
        timer = null;
        void enqueue(step);
      },
      Math.max(250, delay),
    );
  }

  async function showBadge(
    previousTabId: number | null,
    tab: UsageEnv['tab'],
    badge: BadgeSpec | null,
  ): Promise<number | null> {
    if (deps.badge === undefined) return null;
    const tabId = badge === null || tab === null ? null : tab.id;
    if (previousTabId !== null && previousTabId !== tabId) {
      await deps.badge.set(previousTabId, null).catch(() => undefined);
      shownBadge = null;
    }
    if (tabId !== null && badge !== null) {
      const key = `${tabId}|${badge.text}|${badge.title}|${badge.color}`;
      if (key !== shownBadge) {
        await deps.badge.set(tabId, badge).catch(() => undefined);
        shownBadge = key;
      }
    }
    return tabId;
  }

  /** The follower: counts into the shared totals; the main instance reports them. */
  async function followerStep(): Promise<void> {
    const at = now();
    const limits = await deps.getLimits();
    const record = await readLocal(USAGE_KEYS.incognitoTotals, parseIncognitoTotals);
    const totals = { ...record.totals };
    if (record.segment !== null) {
      const host = record.segment.host;
      totals[host] = (totals[host] ?? 0) + followerSegmentMs(record.segment, at);
    }
    let segment: Segment | null = null;
    let badgeTabId = record.badgeTabId;
    if (limits.length > 0) {
      const env = await deps.readEnv();
      const host = countedHost(env, limits);
      if (host !== null) segment = { host, since: at };
      const shown = limitedHost(env.tab, limits);
      let badge: BadgeSpec | null = null;
      if (shown !== null) {
        const status = freshStatus(await readLocal(USAGE_KEYS.status, parseUsageStatus), at);
        const seen = await readLocal(USAGE_KEYS.incognitoSeen, parseIncognitoSeen);
        const unreported = incognitoDelta(totals, seen);
        badge = badgeFor(limitLeftFor(shown, limits, status, unreported));
      }
      badgeTabId = await showBadge(record.badgeTabId, env.tab, badge);
    } else if (badgeTabId !== null) {
      badgeTabId = await showBadge(badgeTabId, null, null);
    }
    const changed = record.segment !== null || segment !== null || badgeTabId !== record.badgeTabId;
    if (changed) {
      const next: IncognitoTotalsRecord = { v: 1, segment, totals, badgeTabId };
      await deps.local.set({ [USAGE_KEYS.incognitoTotals]: next });
    }
    schedule(segment === null ? null : FLUSH_MS);
  }

  async function mainStep(): Promise<void> {
    const at = now();
    const limits = await deps.getLimits();
    const state = await readState();
    if (limits.length === 0) {
      // No limits (any more): nothing counts and nothing is reported.
      const badgeTabId = await showBadge(state.badgeTabId, null, null);
      if (state.segment !== null || state.pending.length > 0 || badgeTabId !== state.badgeTabId) {
        await deps.session.set({ [USAGE_KEYS.state]: { ...EMPTY_STATE, badgeTabId } });
      }
      schedule(null);
      return;
    }

    let pending = state.pending;
    let windowStart = state.windowStart;
    const credit = (host: string, ms: number, since: number): void => {
      if (ms <= 0) return;
      pending = creditPending(pending, host, ms);
      if (windowStart === null) windowStart = since;
    };
    if (state.segment !== null) {
      credit(state.segment.host, segmentMs(state.segment, at), state.segment.since);
    }
    // Seconds counted in Chromium's incognito instance since the last look.
    const [totals, seen] = await Promise.all([
      readLocal(USAGE_KEYS.incognitoTotals, parseIncognitoTotals),
      readLocal(USAGE_KEYS.incognitoSeen, parseIncognitoSeen),
    ]);
    const delta = incognitoDelta(totals.totals, seen);
    for (const [host, ms] of delta) credit(host, ms, at - Math.min(ms, MAX_SEGMENT_MS));
    pending = trimPending(pending);

    const env = await deps.readEnv();
    const host = countedHost(env, limits);
    const segment: Segment | null = host === null ? null : { host, since: at };

    const status = freshStatus(await readLocal(USAGE_KEYS.status, parseUsageStatus), at);
    const left = host === null ? null : limitLeftFor(host, limits, status, pending);
    // Fast near the end of an allowance, and for a first answer (the badge) unless an
    // attempt without an answer was made recently (a guardian that is down is not polled).
    const noAnswer =
      status === null &&
      (state.lastAttemptAt === null || at - state.lastAttemptAt > STATUS_FRESH_MS);
    const fast =
      host !== null && (noAnswer || (left !== null && left.seconds < FAST_REMAINING_SECONDS));

    let lastAttemptAt = state.lastAttemptAt;
    const due = nextReportAt({ pending, windowStart, lastAttemptAt, fast });
    let planned: PlannedReport | null = null;
    if (inflight === null && due !== null && due <= at) {
      planned = planReport(pending, windowStart, at);
      if (planned !== null) {
        pending = planned.pending;
        lastAttemptAt = at;
      }
    }

    const shown = limitedHost(env.tab, limits);
    const badge = shown === null ? null : badgeFor(limitLeftFor(shown, limits, status, pending));
    const badgeTabId = await showBadge(state.badgeTabId, env.tab, badge);

    const next: UsageStateRecord = {
      v: 1,
      segment,
      pending,
      windowStart,
      lastAttemptAt,
      badgeTabId,
    };
    await deps.session.set({ [USAGE_KEYS.state]: next });
    if (delta.length > 0) {
      await deps.local.set({ [USAGE_KEYS.incognitoSeen]: { ...totals.totals } });
    }

    if (planned !== null) send(planned, at);

    // With a segment open there will be a second to report within 1 s.
    const projected = segment === null ? pending : creditPending(pending, segment.host, 1_000);
    const nextDue =
      planned === null && inflight === null
        ? nextReportAt({
            pending: projected,
            windowStart: windowStart ?? (segment === null ? null : at),
            lastAttemptAt,
            fast,
          })
        : null;
    const delays = [
      segment === null ? null : FLUSH_MS,
      nextDue === null ? null : Math.max(nextDue, hasWholeSecond(pending) ? 0 : at + 1_000) - at,
    ];
    const wanted = delays.filter((d): d is number => d !== null);
    schedule(wanted.length === 0 ? null : Math.min(...wanted));
  }

  function send(planned: PlannedReport, sentAt: number): void {
    const run = deps
      .report(planned.body)
      .catch((error: unknown): UsageReportOutcome => {
        warn('usage report failed', error);
        return 'lost';
      })
      .then((answer) => enqueue(() => settle(planned, sentAt, answer)));
    const flight: Promise<void> = run.finally(() => {
      if (inflight === flight) inflight = null;
    });
    inflight = flight;
  }

  /**
   * Applies a report's outcome: answered or lost, the seconds it carried are no longer
   * pending (a lost one may have been credited) and the next report starts at `sentAt`;
   * refused, they go with the next report.
   */
  async function settle(
    planned: PlannedReport,
    sentAt: number,
    outcome: UsageReportOutcome,
  ): Promise<void> {
    if (outcome !== 'refused') {
      const state = await readState();
      const next: UsageStateRecord = {
        ...state,
        pending: subtractSent(state.pending, planned.sent),
        windowStart: sentAt,
      };
      await deps.session.set({ [USAGE_KEYS.state]: next });
    }
    if (outcome !== 'refused' && outcome !== 'lost') {
      const status: UsageStatusRecord = {
        v: 1,
        at: now(),
        day: outcome.day,
        limits: outcome.limits,
      };
      await deps.local.set({ [USAGE_KEYS.status]: status });
    }
    // Refresh the badge and the timers with the answer (the segment continues).
    inflight = null;
    await mainStep();
  }

  const step = (): Promise<void> => (follower ? followerStep() : mainStep());

  return {
    update: () => enqueue(step),
    tick: () => enqueue(step),
    async idle() {
      for (;;) {
        const pendingQueue = queue;
        const flight = inflight;
        await pendingQueue;
        if (flight !== null) await flight;
        if (pendingQueue === queue && inflight === null) return;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------------------

function areaOf(area: chrome.storage.StorageArea): StorageAreaLike {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

async function queryIdle(): Promise<IdleState> {
  const idle = chrome.idle as typeof chrome.idle | undefined;
  if (idle === undefined) return 'active';
  try {
    return (await idle.queryState(GUARDIAN_LIMITS.usageIdleSeconds)) as IdleState;
  } catch {
    return 'active';
  }
}

/** The focused window's active tab and the idle state (Chromium and Firefox alike). */
export async function readBrowserEnv(): Promise<UsageEnv> {
  const [win, idle] = await Promise.all([
    chrome.windows.getLastFocused({ populate: true }).catch(() => null),
    queryIdle(),
  ]);
  const active = win?.tabs?.find((t) => t.active) ?? null;
  return {
    focused: win?.focused === true,
    tab:
      active === null || active.id === undefined
        ? null
        : { id: active.id, url: active.url ?? null, audible: active.audible === true },
    idle,
  };
}

/** The toolbar badge through `chrome.action` (per tab). */
export function chromeBadgeApi(): BadgeApi | undefined {
  const action = chrome.action as typeof chrome.action | undefined;
  if (action === undefined) return undefined;
  return {
    async set(tabId, badge) {
      if (badge === null) {
        await action.setBadgeText({ tabId, text: '' });
        await action.setTitle({ tabId, title: PAGES.appName });
        return;
      }
      await action.setBadgeBackgroundColor({ tabId, color: badge.color });
      if (typeof action.setBadgeTextColor === 'function') {
        await action.setBadgeTextColor({ tabId, color: colors.light.onAccent });
      }
      await action.setBadgeText({ tabId, text: badge.text });
      await action.setTitle({ tabId, title: badge.title });
    },
  };
}

/**
 * Registers the listeners that can change what counts (MV3 wakes the worker for them):
 * tab activated or updated (URL, audible), tab closed, window focus, idle state, the 30 s
 * alarms, and (main instance) the incognito instance's totals.
 */
export function installUsageListeners(tracker: UsageTracker, follower: boolean): () => void {
  const idle = chrome.idle as typeof chrome.idle | undefined;
  const update = (): void => void tracker.update();
  const onUpdated = (_id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
    if (tab.active && (change.url !== undefined || change.audible !== undefined)) update();
  };
  const onAlarm = (alarm: chrome.alarms.Alarm): void => {
    if (alarm.name === TICK_ALARM || alarm.name === SWEEP_ALARM) void tracker.tick();
  };
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (!follower && changes[USAGE_KEYS.incognitoTotals] !== undefined) update();
    if (follower && changes[USAGE_KEYS.status] !== undefined) update();
  };

  try {
    idle?.setDetectionInterval(GUARDIAN_LIMITS.usageIdleSeconds);
  } catch {
    // Firefox before the setting exists: the default (60 s) is the same.
  }
  chrome.tabs.onActivated.addListener(update);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onRemoved.addListener(update);
  chrome.windows.onFocusChanged.addListener(update);
  idle?.onStateChanged.addListener(update);
  chrome.alarms?.onAlarm.addListener(onAlarm);
  chrome.storage.onChanged.addListener(onStorage);
  return () => {
    chrome.tabs.onActivated.removeListener(update);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onRemoved.removeListener(update);
    chrome.windows.onFocusChanged.removeListener(update);
    idle?.onStateChanged.removeListener(update);
    chrome.alarms?.onAlarm.removeListener(onAlarm);
    chrome.storage.onChanged.removeListener(onStorage);
  };
}

export interface UsagePluginOptions {
  /** Called once per worker start with the core's API (the worker creates the tracker). */
  install(api: BackgroundApi): UsageTracker;
}

/** The usage plugin: counts on every rules change too (limits may have appeared or gone). */
export function createUsagePlugin(options: UsagePluginOptions): BackgroundPlugin {
  let tracker: UsageTracker | null = null;
  return {
    name: 'usage',
    start(api) {
      tracker = options.install(api);
      void tracker.update();
    },
    // Chromium's incognito instance: the rules it follows changed.
    async followRules() {
      await tracker?.update();
    },
    // Not an applier (`applyRules` would count toward «rules applied» in the heartbeat):
    // the main instance hears of new rules through the stored record (see `install`).
  };
}

export const usagePlugin: BackgroundPlugin = createUsagePlugin({
  install(api) {
    const follower = chrome.extension?.inIncognitoContext === true;
    const tracker = createUsageTracker({
      role: follower ? 'follower' : 'main',
      getLimits: async () => (await api.getEffectiveRules())?.limits ?? [],
      readEnv: readBrowserEnv,
      report: (body) => api.reportUsage(body),
      session: areaOf(chrome.storage.session),
      local: areaOf(chrome.storage.local),
      badge: chromeBadgeApi(),
    });
    installUsageListeners(tracker, follower);
    // The rules record changes when limits are added, removed or a new day starts.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEYS.rules] !== undefined) {
        void tracker.update();
      }
    });
    return tracker;
  },
});

registerBackgroundPlugin(usagePlugin);
