/**
 * Background state: which rules are in force, what the popup sees, and the typed message
 * API between the extension pages (popup, blocked.html, options/guide) and the background.
 *
 * Rules in force («effective rules», docs/ARCHITECTURE.md §8.8):
 * - While the guardian answers (or before the first attempt since the worker woke up), the
 *   last verified body is used exactly as signed: the guardian may keep an ended block
 *   enforced (boot hold) and pushes a new version whenever something changes.
 * - When it does not (down, 401, forged or stale bodies), the cached rules stay in force
 *   and each block lasts until its cached `endsAt`: the extension never unblocks early
 *   because the guardian is unreachable.
 * - Either way an allowance closes at its signed `endsAt` (the guardian re-signs whenever it
 *   extends one), so an answer that proves nothing new (a bare 304) cannot keep it open.
 * - Rules verified under a previous pairing (pairing again, a reinstalled guardian with a new
 *   rules key, or something that answered a new pairing on the port) are «carried» until
 *   their blocks end: a new pairing can add rules at once but cannot shorten blocks promised
 *   under the old one, and neither side's exemptions (`excludedDomains`) can open a host the
 *   other one blocks.
 *
 * Everything here except the message helpers is pure, so it runs in tests without `chrome`.
 */

import { getService, isAlwaysAllowedHost, isSameOrSubdomain } from '@centrate/shared/catalog';
import type { BrowserFamily, ExtensionId, IsoUtc } from '@centrate/shared/domain';
import type {
  AttemptResponse,
  ExtRuleBlock,
  ExtRulesResponse,
} from '@centrate/shared/guardian-api';
import type { RulesRecord, StatusError, StatusRecord, PairingRecord } from './storage';

// ---------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------

/** Long-poll wait: under the 30 s after which Chrome kills a worker waiting on a fetch. */
export const LONG_POLL_WAIT_MS = 25_000;
/** Period of the `chrome.alarms` tick that revives the worker (30 s, the MV3 minimum). */
export const TICK_PERIOD_MINUTES = 0.5;
/** Heartbeats are sent at most this often (plus once after each rules change). */
export const HEARTBEAT_MIN_INTERVAL_MS = 25_000;

// ---------------------------------------------------------------------------------------
// Link to the guardian (in memory, per worker lifetime)
// ---------------------------------------------------------------------------------------

/**
 * Outcome of the latest rules request since the worker started:
 * - `unknown`: nothing tried yet;
 * - `connected`: a verified 200 or a 304;
 * - `unreachable`: no answer or a timeout (guardian stopped, not installed, asleep);
 * - `unauthorized`: 401, the token was revoked or the guardian forgot it;
 * - `untrusted`: an answer that failed verification (signature, nonce, version, shape);
 * - `error`: any other error status (403, 429, 5xx…).
 */
export type GuardianLink =
  'unknown' | 'connected' | 'unreachable' | 'unauthorized' | 'untrusted' | 'error';

/** The last verified rules are trusted as signed only in these states. */
export function linkTrustsRules(link: GuardianLink): boolean {
  return link === 'unknown' || link === 'connected';
}

// ---------------------------------------------------------------------------------------
// Effective rules
// ---------------------------------------------------------------------------------------

function parseTime(iso: IsoUtc): number {
  return Date.parse(iso);
}

/** A block is live until its `endsAt` (an unreadable time never ends a block). */
function blockLive(endsAt: IsoUtc, nowMs: number): boolean {
  const t = parseTime(endsAt);
  return Number.isNaN(t) || t > nowMs;
}

/** An allowance is live until its `endsAt` (an unreadable time ends it). */
function allowanceLive(endsAt: IsoUtc, nowMs: number): boolean {
  const t = parseTime(endsAt);
  return !Number.isNaN(t) && t > nowMs;
}

function serviceHosts(serviceIds: Iterable<string>): string[] {
  const hosts: string[] = [];
  for (const id of serviceIds) hosts.push(...(getService(id)?.domains ?? []));
  return hosts;
}

const underAny = (host: string, parents: readonly string[]): boolean =>
  parents.some((parent) => isSameOrSubdomain(host, parent));

function earliestFuture(times: Iterable<IsoUtc>, nowMs: number): IsoUtc | null {
  let best: IsoUtc | null = null;
  let bestMs = Infinity;
  for (const iso of times) {
    const t = parseTime(iso);
    if (!Number.isNaN(t) && t > nowMs && t < bestMs) {
      best = iso;
      bestMs = t;
    }
  }
  return best;
}

/**
 * Closes the allowances of `rules` that ended by `nowMs`: the hosts they had opened are
 * blocked again (catalog domains of their service that a non-whitelist block of `rules`
 * lists, never always-allowed hosts) and leave the whitelist allow set. Blocks are left as
 * they are. Returns `rules` itself when no allowance ended.
 */
export function closeEndedAllowances(rules: ExtRulesResponse, nowMs: number): ExtRulesResponse {
  const allowances = rules.allowances.filter((a) => allowanceLive(a.endsAt, nowMs));
  if (allowances.length === rules.allowances.length) return rules;

  const liveServices = new Set(allowances.map((a) => a.serviceId));
  const endedServices = new Set(
    rules.allowances.map((a) => a.serviceId).filter((id) => !liveServices.has(id)),
  );
  const endedHosts = serviceHosts(endedServices);
  const liveHosts = serviceHosts(liveServices);
  const reopened = (host: string): boolean =>
    underAny(host, endedHosts) && !underAny(host, liveHosts) && !isAlwaysAllowedHost(host);

  const blockDomains = new Set(rules.blockDomains);
  let whitelist = rules.whitelist;
  if (endedServices.size > 0) {
    for (const block of rules.blocks) {
      if (block.whitelistOnly) continue;
      for (const host of block.domains) if (reopened(host)) blockDomains.add(host);
    }
    if (whitelist !== null) {
      whitelist = {
        allowDomains: whitelist.allowDomains.filter((host) => !reopened(host)),
        allowHostPatterns: whitelist.allowHostPatterns,
      };
    }
  }

  const nextChanges = rules.nextChangeAt === null ? [] : [rules.nextChangeAt];
  return {
    ...rules,
    blockDomains: [...blockDomains],
    whitelist,
    allowances,
    nextChangeAt: earliestFuture(
      [...nextChanges, ...rules.blocks.map((b) => b.endsAt), ...allowances.map((a) => a.endsAt)],
      nowMs,
    ),
  };
}

/**
 * The cached rules as they stand at `nowMs` without the guardian: ended blocks, allowances
 * and punishments are dropped, `blockDomains` keeps only hosts a live block still lists,
 * and hosts an ended allowance had opened are blocked again (`closeEndedAllowances`).
 * Returns `rules` itself when nothing ended.
 */
export function pruneRules(rules: ExtRulesResponse, nowMs: number): ExtRulesResponse {
  return closeEndedAllowances(pruneBlocks(rules, nowMs), nowMs);
}

/** `pruneRules` without the allowances: drops ended blocks, their hosts and punishments. */
function pruneBlocks(rules: ExtRulesResponse, nowMs: number): ExtRulesResponse {
  const blocks = rules.blocks.filter((b) => blockLive(b.endsAt, nowMs));
  const punishment =
    rules.punishment !== null && blockLive(rules.punishment.endsAt, nowMs)
      ? rules.punishment
      : null;
  if (blocks.length === rules.blocks.length && punishment === rules.punishment) return rules;

  const covered = new Set<string>();
  for (const block of blocks) {
    if (!block.whitelistOnly) for (const host of block.domains) covered.add(host);
  }
  return {
    ...rules,
    blockDomains: rules.blockDomains.filter((host) => covered.has(host)),
    whitelist: blocks.some((b) => b.whitelistOnly) ? rules.whitelist : null,
    blocks,
    punishment,
    nextChangeAt: earliestFuture(
      [...blocks.map((b) => b.endsAt), ...rules.allowances.map((a) => a.endsAt)],
      nowMs,
    ),
  };
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

function laterPunishment(
  a: ExtRulesResponse['punishment'],
  b: ExtRulesResponse['punishment'],
): ExtRulesResponse['punishment'] {
  if (a === null) return b;
  if (b === null) return a;
  const order = ['distractions', 'whitelist', 'nuclear'];
  return {
    endsAt: parseTime(b.endsAt) > parseTime(a.endsAt) ? b.endsAt : a.endsAt,
    level: order.indexOf(b.level) > order.indexOf(a.level) ? b.level : a.level,
  };
}

/**
 * Whether exempting `host` keeps every restriction of `rules`. An exemption becomes a
 * priority-40 DNR `allow` on `requestDomains` (so it covers the subdomains of `host` too)
 * that beats every redirect, so it is kept only when `rules` already exempts all of it, or
 * when it neither covers nor sits under a host `rules` blocks and the whitelist of `rules`
 * (if any) allows all of it. Always-allowed hosts (bundled catalog) are never blocked.
 */
function exemptionKeeps(rules: ExtRulesResponse, host: string): boolean {
  if (underAny(host, rules.excludedDomains) || isAlwaysAllowedHost(host)) return true;
  const overlaps = rules.blockDomains.some(
    (blocked) => isSameOrSubdomain(host, blocked) || isSameOrSubdomain(blocked, host),
  );
  if (overlaps) return false;
  return rules.whitelist === null || underAny(host, rules.whitelist.allowDomains);
}

/**
 * Adds the restrictions of `carried` (rules verified under an older key, already pruned)
 * to `primary`: their blocks and blocked hosts, and their whitelist (both whitelists at
 * once allow only what both allow). Exemptions only survive where they loosen neither side:
 * a new pairing (possibly something squatting the port with its own key) cannot open a host
 * the old rules block, and the old rules cannot open one the new rules block
 * (`exemptionKeeps`). Allowances, versions and the nonce stay `primary`'s.
 */
export function mergeCarriedRules(
  primary: ExtRulesResponse,
  carried: ExtRulesResponse,
): ExtRulesResponse {
  if (carried.blocks.length === 0) return primary;
  const ids = new Set(primary.blocks.map((b) => b.id));
  let whitelist = primary.whitelist ?? carried.whitelist;
  if (primary.whitelist !== null && carried.whitelist !== null) {
    const allowed = new Set(carried.whitelist.allowDomains);
    const patterns = new Set(carried.whitelist.allowHostPatterns);
    whitelist = {
      allowDomains: primary.whitelist.allowDomains.filter((d) => allowed.has(d)),
      allowHostPatterns: primary.whitelist.allowHostPatterns.filter((p) => patterns.has(p)),
    };
  }
  const nextChanges = [primary.nextChangeAt, carried.nextChangeAt].filter(
    (v): v is IsoUtc => v !== null,
  );
  nextChanges.sort((x, y) => parseTime(x) - parseTime(y));
  return {
    ...primary,
    blockDomains: union(primary.blockDomains, carried.blockDomains),
    excludedDomains: union(
      primary.excludedDomains.filter((host) => exemptionKeeps(carried, host)),
      carried.excludedDomains.filter((host) => exemptionKeeps(primary, host)),
    ),
    whitelist,
    blocks: [...primary.blocks, ...carried.blocks.filter((b) => !ids.has(b.id))],
    punishment: laterPunishment(primary.punishment, carried.punishment),
    nextChangeAt: nextChanges[0] ?? null,
  };
}

/**
 * The rules to enforce now, or `null` with nothing cached. `trusted` is
 * `linkTrustsRules(link)`: while the guardian answers, its blocks are used as signed (it may
 * hold an ended block); allowances close at their `endsAt` in every case.
 */
export function computeEffectiveRules(
  record: RulesRecord | null,
  nowMs: number,
  trusted: boolean,
): ExtRulesResponse | null {
  if (record === null) return null;
  const primary = trusted
    ? closeEndedAllowances(record.rules, nowMs)
    : pruneRules(record.rules, nowMs);
  if (record.carried === null) return primary;
  return mergeCarriedRules(primary, pruneRules(record.carried.rules, nowMs));
}

/**
 * When the effective rules change next without the guardian (the earliest future end of a
 * block, allowance or punishment, or `nextChangeAt`), as epoch ms; `null` when nothing
 * will. index.ts sets a one-shot alarm there.
 */
export function nextRulesChangeAt(record: RulesRecord | null, nowMs: number): number | null {
  if (record === null) return null;
  const times: IsoUtc[] = [];
  for (const rules of [record.rules, record.carried?.rules]) {
    if (rules === undefined) continue;
    times.push(...rules.blocks.map((b) => b.endsAt), ...rules.allowances.map((a) => a.endsAt));
    if (rules.punishment !== null) times.push(rules.punishment.endsAt);
    if (rules.nextChangeAt !== null) times.push(rules.nextChangeAt);
  }
  const next = earliestFuture(times, nowMs);
  return next === null ? null : parseTime(next);
}

// ---------------------------------------------------------------------------------------
// Host matching (the DNR priorities of §8.8, for attempts and the blocked page)
// ---------------------------------------------------------------------------------------

export interface HostMatch {
  blocked: boolean;
  /** `domain`: listed in `blockDomains`; `whitelist`: not on the whitelist. */
  via: 'domain' | 'whitelist' | null;
  /** The covering block with the latest `endsAt` (when access returns). */
  block: ExtRuleBlock | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function latestBlock(blocks: readonly ExtRuleBlock[]): ExtRuleBlock | null {
  let best: ExtRuleBlock | null = null;
  for (const block of blocks) {
    if (best === null || parseTime(block.endsAt) >= parseTime(best.endsAt)) best = block;
  }
  return best;
}

function hostPatternMatches(host: string, pattern: string): boolean {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  try {
    return new RegExp(pattern, 'u').test(host);
  } catch {
    return false;
  }
}

/**
 * Whether a top-level navigation to `host` (lowercase hostname, as `new URL().hostname`)
 * is blocked by `rules`, following the DNR priorities: `excludedDomains` and loopback are
 * allowed; `blockDomains` (and subdomains) are blocked; otherwise the whitelist, when set,
 * blocks everything it does not allow.
 */
export function matchHost(rules: ExtRulesResponse | null, host: string): HostMatch {
  const none: HostMatch = { blocked: false, via: null, block: null };
  if (rules === null || host.length === 0 || LOOPBACK_HOSTS.has(host)) return none;
  if (underAny(host, rules.excludedDomains)) return none;
  if (underAny(host, rules.blockDomains)) {
    const covering = rules.blocks.filter((b) => !b.whitelistOnly && underAny(host, b.domains));
    return { blocked: true, via: 'domain', block: latestBlock(covering) };
  }
  const whitelist = rules.whitelist;
  if (whitelist === null) return none;
  if (underAny(host, whitelist.allowDomains)) return none;
  if (whitelist.allowHostPatterns.some((p) => hostPatternMatches(host, p))) return none;
  return {
    blocked: true,
    via: 'whitelist',
    block: latestBlock(rules.blocks.filter((b) => b.whitelistOnly)),
  };
}

// ---------------------------------------------------------------------------------------
// Snapshot for the pages
// ---------------------------------------------------------------------------------------

export interface BrowserInfo {
  /** The `browser` value sent to the guardian (bound to the token at pairing). */
  family: BrowserFamily;
  engine: 'chromium' | 'firefox';
  /** Matches the API's version pattern (`[0-9A-Za-z.+_-]{1,64}`). */
  version: string;
}

export interface Capabilities {
  /** `<all_urls>` granted: without it the DNR redirects silently do nothing. */
  hostPermission: boolean;
  /** «Permitir en incógnito» / «Ejecutar en ventanas privadas». */
  incognitoAllowed: boolean;
}

/** Problems the popup lists, most important first. */
export type ExtensionProblem =
  | 'not_paired'
  | 'unauthorized'
  | 'host_permission_missing'
  | 'guardian_unreachable'
  | 'untrusted_rules'
  | 'browser_mismatch'
  | 'peer_not_browser'
  | 'origin_not_allowed'
  | 'guardian_error'
  | 'incognito_not_allowed';

/**
 * What the popup, blocked.html and the guide need. Never contains the token.
 *
 * `protection`:
 * - `active`: rules from a guardian that answers are enforced (blocks or not);
 * - `cached`: the guardian does not answer; the last verified rules stay in force;
 * - `limited`: rules exist but the browser does not let the extension apply them
 *   (host permission missing);
 * - `off`: nothing to enforce and no guardian (not paired, or never synced).
 */
export interface ExtensionStateSnapshot {
  v: 1;
  /** `Date.now()` in the background when the snapshot was taken. */
  now: number;
  paired: boolean;
  pairing: {
    extensionId: ExtensionId;
    guardianVersion: string;
    browser: BrowserFamily;
    port: number;
    pairedAt: number;
  } | null;
  link: GuardianLink;
  protection: 'active' | 'cached' | 'limited' | 'off';
  problems: ExtensionProblem[];
  browser: BrowserInfo | null;
  capabilities: Capabilities | null;
  /** Firefox asks for `<all_urls>` at runtime: the guide must request it. */
  needsHostPermission: boolean;
  extVersion: string;
  rules: {
    extRulesVersion: number;
    /** Live blocks, latest end first. */
    blocks: ExtRuleBlock[];
    allowances: ExtRulesResponse['allowances'];
    punishment: ExtRulesResponse['punishment'];
    whitelistActive: boolean;
    penaltiesEnabled: boolean;
    nextChangeAt: IsoUtc | null;
    blockedHostCount: number;
    /** `Date.now()` when these rules were verified. */
    receivedAt: number;
  } | null;
  lastRulesAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: StatusError | null;
}

export interface SnapshotInput {
  now: number;
  pairing: PairingRecord | null;
  record: RulesRecord | null;
  status: StatusRecord;
  link: GuardianLink;
  browser: BrowserInfo | null;
  capabilities: Capabilities | null;
  extVersion: string;
}

const PROBLEM_FROM_ERROR: Readonly<Record<string, ExtensionProblem>> = {
  browser_mismatch: 'browser_mismatch',
  peer_not_browser: 'peer_not_browser',
  origin_not_allowed: 'origin_not_allowed',
};

/** Builds the page-facing snapshot (pure). */
export function buildSnapshot(input: SnapshotInput): ExtensionStateSnapshot {
  const { now, pairing, record, status, link, capabilities } = input;
  const trusted = linkTrustsRules(link);
  const effective = computeEffectiveRules(record, now, trusted);
  const hostPermission = capabilities?.hostPermission ?? true;

  const problems: ExtensionProblem[] = [];
  if (pairing === null) problems.push('not_paired');
  else if (pairing.unauthorizedAt !== null || link === 'unauthorized')
    problems.push('unauthorized');
  if (!hostPermission) problems.push('host_permission_missing');
  if (pairing !== null) {
    if (link === 'unreachable') problems.push('guardian_unreachable');
    if (link === 'untrusted') problems.push('untrusted_rules');
    const rulesProblem =
      link === 'error' ? PROBLEM_FROM_ERROR[status.lastError?.code ?? ''] : undefined;
    const beatProblem = PROBLEM_FROM_ERROR[status.heartbeatError?.code ?? ''];
    if (rulesProblem !== undefined) problems.push(rulesProblem);
    else if (link === 'error') problems.push('guardian_error');
    if (beatProblem !== undefined && beatProblem !== rulesProblem) problems.push(beatProblem);
  }
  if (capabilities !== null && !capabilities.incognitoAllowed)
    problems.push('incognito_not_allowed');

  let protection: ExtensionStateSnapshot['protection'];
  if (effective === null && (pairing === null || link !== 'connected')) protection = 'off';
  else if (!hostPermission) protection = 'limited';
  else if (link === 'connected' || link === 'unknown') protection = 'active';
  else protection = 'cached';

  const blocks = effective
    ? [...effective.blocks].sort((a, b) => parseTime(b.endsAt) - parseTime(a.endsAt))
    : [];

  return {
    v: 1,
    now,
    paired: pairing !== null,
    pairing:
      pairing === null
        ? null
        : {
            extensionId: pairing.extensionId,
            guardianVersion: pairing.guardianVersion,
            browser: pairing.browser,
            port: pairing.port,
            pairedAt: pairing.pairedAt,
          },
    link,
    protection,
    problems,
    browser: input.browser,
    capabilities,
    needsHostPermission: !hostPermission,
    extVersion: input.extVersion,
    rules:
      effective === null || record === null
        ? null
        : {
            extRulesVersion: effective.extRulesVersion,
            blocks,
            allowances: effective.allowances,
            punishment: effective.punishment,
            whitelistActive: effective.whitelist !== null,
            penaltiesEnabled: effective.penaltiesEnabled,
            nextChangeAt: effective.nextChangeAt,
            blockedHostCount: effective.blockDomains.length,
            receivedAt: record.receivedAt,
          },
    lastRulesAt: status.lastRulesAt,
    lastHeartbeatAt: status.lastHeartbeatAt,
    lastError: status.lastError,
  };
}

// ---------------------------------------------------------------------------------------
// Message API (pages → background)
// ---------------------------------------------------------------------------------------

/** Sections of the guide (options page), used as its URL hash. */
export const GUIDE_SECTIONS = [
  'pairing',
  'host-permission',
  'incognito',
  'troubleshooting',
] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

/** The guide is the options page; `open-guide` opens it in a tab at `#<section>`. */
export const GUIDE_PAGE = 'options.html';

export const MESSAGE_TYPES = Object.freeze({
  getState: 'centrate/get-state',
  pair: 'centrate/pair',
  openGuide: 'centrate/open-guide',
  refresh: 'centrate/refresh',
  /** Background → pages broadcast whenever the snapshot may have changed. */
  stateChanged: 'centrate/state-changed',
});

export type BackgroundRequest =
  | { type: typeof MESSAGE_TYPES.getState }
  | {
      type: typeof MESSAGE_TYPES.pair;
      /** The 6 digits shown by the app; spaces and dashes are ignored. */
      code: string;
      /** Only when the app shows «Puerto: N» (default 47600). */
      port?: number;
    }
  | { type: typeof MESSAGE_TYPES.openGuide; section?: GuideSection }
  /** Sync and heartbeat now (e.g. after the guide obtained the host permission). */
  | { type: typeof MESSAGE_TYPES.refresh };

export type PairErrorCode =
  /** Not 6 digits, or a bad port (checked before any request). */
  | 'invalid_format'
  /** 401 `pairing_code_invalid`. */
  | 'code_invalid'
  /** 410 `pairing_code_expired`, or the code burned after 5 failures. */
  | 'code_expired'
  /** 409 `pairing_no_code`: the app has not shown a code. */
  | 'no_code'
  /** 403: the guardian did not see this browser as the caller (`peer_not_browser`). */
  | 'peer_not_browser'
  /** 403 `origin_not_allowed`: an extension id the guardian does not know. */
  | 'origin_not_allowed'
  | 'rate_limited'
  /** No guardian on the port (not installed or stopped). */
  | 'unreachable'
  | 'timeout'
  /** 503 `read_only`: the guardian is in safe mode or the disk is full. */
  | 'read_only'
  /**
   * The claim answered with a rules key other than the one(s) that signed the blocks still
   * running (pairing.ts): refused until they end.
   */
  | 'key_changed'
  /** Another port while the guardian still answers on the paired one (pairing.ts). */
  | 'guardian_elsewhere'
  | 'unexpected';

export type PairResult =
  | { ok: true; state: ExtensionStateSnapshot }
  | { ok: false; error: PairErrorCode; retryAfterSeconds: number | null };

export type BackgroundFailure = { ok: false; error: 'bad_request' | 'internal' };

export interface BackgroundResponses {
  'centrate/get-state': { ok: true; state: ExtensionStateSnapshot };
  'centrate/pair': PairResult;
  'centrate/open-guide': { ok: true };
  'centrate/refresh': { ok: true; state: ExtensionStateSnapshot };
}

export type BackgroundResponse<T extends BackgroundRequest['type']> =
  BackgroundResponses[T] | BackgroundFailure;

export interface StateChangedMessage {
  type: typeof MESSAGE_TYPES.stateChanged;
  state: ExtensionStateSnapshot;
}

type Loose = Record<string, unknown>;

/** Validates a message from a page (anything else is refused with `bad_request`). */
export function parseBackgroundRequest(value: unknown): BackgroundRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const msg = value as Loose;
  const keys = Object.keys(msg);
  const only = (...allowed: string[]): boolean => keys.every((k) => allowed.includes(k));
  switch (msg['type']) {
    case MESSAGE_TYPES.getState:
      return only('type') ? { type: MESSAGE_TYPES.getState } : null;
    case MESSAGE_TYPES.refresh:
      return only('type') ? { type: MESSAGE_TYPES.refresh } : null;
    case MESSAGE_TYPES.openGuide: {
      const section = msg['section'];
      if (!only('type', 'section')) return null;
      if (section === undefined) return { type: MESSAGE_TYPES.openGuide };
      return (GUIDE_SECTIONS as readonly unknown[]).includes(section)
        ? { type: MESSAGE_TYPES.openGuide, section: section as GuideSection }
        : null;
    }
    case MESSAGE_TYPES.pair: {
      const { code, port } = msg;
      if (!only('type', 'code', 'port') || typeof code !== 'string' || code.length > 32)
        return null;
      if (port !== undefined && typeof port !== 'number') return null;
      return port === undefined
        ? { type: MESSAGE_TYPES.pair, code }
        : { type: MESSAGE_TYPES.pair, code, port };
    }
    default:
      return null;
  }
}

/** For pages: sends a typed request to the background and returns its typed answer. */
export async function sendToBackground<R extends BackgroundRequest>(
  request: R,
): Promise<BackgroundResponse<R['type']>> {
  return (await chrome.runtime.sendMessage(request)) as BackgroundResponse<R['type']>;
}

/** For pages: listens to background broadcasts of the snapshot; returns the unsubscribe. */
export function onStateChanged(listener: (state: ExtensionStateSnapshot) => void): () => void {
  const handler = (message: unknown): void => {
    const msg = message as Partial<StateChangedMessage> | null;
    if (msg?.type === MESSAGE_TYPES.stateChanged && msg.state !== undefined) listener(msg.state);
  };
  chrome.runtime.onMessage.addListener(handler);
  return () => chrome.runtime.onMessage.removeListener(handler);
}

// ---------------------------------------------------------------------------------------
// Plugins: enforcement modules the background drives (DNR rules, attempts)
// ---------------------------------------------------------------------------------------

/** What the background offers its plugins. */
export interface BackgroundApi {
  /** The rules in force now (see `computeEffectiveRules`); `null` with nothing cached. */
  getEffectiveRules(): Promise<ExtRulesResponse | null>;
  /** `matchHost` against the rules in force. */
  matchHost(host: string): Promise<HostMatch>;
  /**
   * `POST /v1/attempts` with the extension token (`layer: "extension"`, the hostname only;
   * the URL never leaves the browser). `null` when unpaired, unauthorized, or the guardian
   * did not answer.
   */
  reportAttempt(input: { host: string; incognito: boolean }): Promise<AttemptResponse | null>;
  getSnapshot(): Promise<ExtensionStateSnapshot>;
  browser(): Promise<BrowserInfo>;
}

export interface BackgroundPlugin {
  name: string;
  /**
   * Applies the rules in force (declarativeNetRequest). Called at every worker start with
   * the cached rules, after each verified change, when the guardian link changes and when
   * a cached block or allowance ends. `null`: nothing cached, remove every rule (never
   * called while a stored record cannot be read: the browser keeps what it enforces). Must
   * be idempotent; a throw means the version is not reported as applied. Only the main
   * instance calls it (see `followRules`).
   */
  applyRules?(rules: ExtRulesResponse | null): Promise<void>;
  /**
   * In an instance that follows the main one instead of enforcing (Chromium's incognito
   * instance in split mode, index.ts: the dynamic rules are shared and the main instance
   * owns them), called instead of `applyRules` whenever the rules in force change there,
   * e.g. to move that instance's open tabs (the main instance cannot see incognito tabs).
   */
  followRules?(rules: ExtRulesResponse | null): Promise<void>;
  /**
   * Answers a page message the core does not know (e.g. blocked.html asking for its
   * attempt). Return `undefined` to pass; the resolved value is sent back.
   */
  handleMessage?(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> | undefined;
  /** Called once per worker start, after the core listeners are registered. */
  start?(api: BackgroundApi): void;
}

const plugins: BackgroundPlugin[] = [];

/**
 * Registers a plugin. Call it at the top level of a module that background/index.ts
 * imports, so it is in place before the worker starts.
 */
export function registerBackgroundPlugin(plugin: BackgroundPlugin): void {
  if (!plugins.some((p) => p.name === plugin.name)) plugins.push(plugin);
}

/** Registered plugins, in registration order. */
export function backgroundPlugins(): readonly BackgroundPlugin[] {
  return plugins;
}
