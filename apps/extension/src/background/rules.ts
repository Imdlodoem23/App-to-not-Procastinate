/**
 * Pure mapping from the rules in force to `declarativeNetRequest` dynamic rules
 * (docs/ARCHITECTURE.md §8.8), and the contract between the background and blocked.html.
 *
 * Input: the effective `ExtRulesResponse` that state.ts computes (the verified body while
 * the guardian answers; pruned at each cached `endsAt` while it does not; plus rules carried
 * from an older key). Everything time-related (block ends, allowance ends, boot hold)
 * already happened there, so this module only translates a set of hosts into rules.
 *
 * Priorities, highest first, exactly as §8.8 orders them:
 *
 * | priority | action     | condition                                                          |
 * | -------- | ---------- | ------------------------------------------------------------------ |
 * | 40       | `allow`    | `excludedDomains` (requestDomains) and loopback (one regexFilter)  |
 * | 30       | `redirect` | `blockDomains` (requestDomains, so subdomains too), main + sub     |
 * | 20       | `allow`    | `whitelist.allowDomains` (requestDomains), `allowHostPatterns`     |
 * | 10       | `redirect` | every other http(s) `main_frame`, only while `whitelist` is set    |
 *
 * So an excluded host (accounts.youtube.com) is never blocked, a whitelist entry never
 * reopens a host another block lists, and the whitelist rule never touches sub-resources.
 *
 * Decisions:
 * - **Sub-frames.** `blockDomains` redirects `main_frame` and `sub_frame` (§8.8): an embedded
 *   YouTube player shows blocked.html inside its iframe. Sub-frames are never counted as
 *   attempts (attempts.ts). The whitelist rule is `main_frame` only.
 * - **Allowances** (rewards) are not allow rules: the guardian already subtracts their
 *   catalog hosts from `blockDomains` and adds them to the whitelist allow set, and
 *   state.ts re-blocks them at their cached `endsAt` while the guardian is away. An allow
 *   rule on `youtube.com` would also reopen hosts under it that another block lists by name.
 * - **Redirect URL.** `/blocked.html?cause=domain&service=youtube`: only the cause and the
 *   catalog service of the rule, so the page can name the site at once (also inside an
 *   iframe). Never the reason, the block id or the URL: the page gets those from the
 *   background (`BlockedTabInfo`), because it is web-accessible and must not trust its
 *   own query string for anything but display.
 * - **One redirect rule per catalog service** (hosts under no known service share
 *   service-less rules), at most `domainsPerRule` hosts each; if that would exceed the rule
 *   budget, blocked hosts are merged into service-less rules instead (never dropped).
 * - **Host patterns** are anchored host regexes (catalog `hostPatterns`). A DNR
 *   `regexFilter` matches the whole URL, so each becomes
 *   `^https?://(?:<pattern>)(?::[0-9]+)?(?:[/?#]|$)`, and only patterns that cannot match
 *   across `/ ? # @ :` are used (no `.` wildcard, no negated classes, no lookarounds…).
 *   Unsafe, unsupported or over-budget patterns are left out: their hosts stay blocked
 *   (stricter, never looser).
 */

import { findServiceByDomain, isValidDomain } from '@centrate/shared/catalog';
import type {
  AttemptResponse,
  ExtRuleBlock,
  ExtRulesResponse,
} from '@centrate/shared/guardian-api';

export type DnrRule = chrome.declarativeNetRequest.Rule;
/** A dynamic rule before an id is assigned (dnr.ts assigns stable ids). */
export type DnrRuleSpec = Omit<DnrRule, 'id'>;
type ResourceType = NonNullable<
  chrome.declarativeNetRequest.RuleCondition['resourceTypes']
>[number];

// ---------------------------------------------------------------------------------------
// Priorities and limits
// ---------------------------------------------------------------------------------------

/** DNR priorities (higher wins). Spaced so later features can slot in between. */
export const DNR_PRIORITY = Object.freeze({
  /** `allow` excluded hosts and loopback: beats every redirect. */
  allowExempt: 40,
  /** `redirect` the hosts blocks list (main_frame + sub_frame). */
  redirectBlocked: 30,
  /** `allow` whitelist hosts and host patterns: beats only the whitelist rule. */
  allowWhitelist: 20,
  /** `redirect` every other main frame while a whitelist block is active. */
  redirectWhitelist: 10,
});

export interface DnrLimits {
  /** Dynamic rules this module may use (after rules other modules own). */
  maxRules: number;
  /** Regex rules this module may use (`MAX_NUMBER_OF_REGEX_RULES`). */
  maxRegexRules: number;
  /** Hosts per `requestDomains` list. */
  domainsPerRule: number;
}

/**
 * Safe everywhere: Chrome 121+ allows 30 000 dynamic rules but only 5 000 «unsafe»
 * (redirect) ones; Firefox 128 allows 5 000 dynamic rules; both allow 1 000 regex rules.
 * dnr.ts lowers these with the browser's own constants when they are smaller.
 */
export const DEFAULT_DNR_LIMITS: Readonly<DnrLimits> = Object.freeze({
  maxRules: 5_000,
  maxRegexRules: 1_000,
  domainsPerRule: 1_000,
});

const BLOCK_TYPES: ResourceType[] = ['main_frame', 'sub_frame'];
const MAIN_FRAME: ResourceType[] = ['main_frame'];

/** Loopback (the guardian, local dev servers): allowed in every mode. */
export const LOOPBACK_REGEX_FILTER =
  '^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::[0-9]+)?(?:[/?#]|$)';

/** Every http(s) URL (the whitelist rule). */
export const ANY_WEB_URL_FILTER = '|http';

// ---------------------------------------------------------------------------------------
// blocked.html contract
// ---------------------------------------------------------------------------------------

/** The extension page every redirect goes to (web-accessible for `<all_urls>`). */
export const BLOCKED_PAGE = 'blocked.html';

/**
 * Why the page shows: `domain`, a host some block lists; `whitelist`, a host the
 * whitelist (exam, punishment level 2) does not allow.
 */
export type BlockedCause = 'domain' | 'whitelist';

export interface BlockedPageParams {
  cause: BlockedCause;
  /** Catalog service of the rule that redirected; `null` for custom hosts and the whitelist. */
  serviceId: string | null;
  /**
   * The tab was already open on the site when the block started and the extension moved
   * it here: not an attempt, no points.
   */
  enforced: boolean;
}

const CATALOG_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `/blocked.html?cause=…[&service=…][&tab=1]`, for `redirect.extensionPath` and tabs. */
export function blockedPagePath(params: BlockedPageParams): string {
  const query = new URLSearchParams({ cause: params.cause });
  if (params.serviceId !== null && CATALOG_ID_RE.test(params.serviceId)) {
    query.set('service', params.serviceId);
  }
  if (params.enforced) query.set('tab', '1');
  return `/${BLOCKED_PAGE}?${query.toString()}`;
}

/**
 * Reads the page's query string (`location.search` or a full URL). Anything can open the
 * page with any query, so values are validated and only ever used for display.
 */
export function parseBlockedPageParams(input: string): BlockedPageParams {
  let search = input;
  const q = input.indexOf('?');
  if (q >= 0) search = input.slice(q + 1);
  const hash = search.indexOf('#');
  if (hash >= 0) search = search.slice(0, hash);
  const query = new URLSearchParams(search);
  const service = query.get('service');
  return {
    cause: query.get('cause') === 'whitelist' ? 'whitelist' : 'domain',
    serviceId:
      service !== null && service.length <= 64 && CATALOG_ID_RE.test(service) ? service : null,
    enforced: query.get('tab') === '1',
  };
}

/** True when `url` is the blocked page of the extension whose base URL is `extensionBase`. */
export function isBlockedPageUrl(url: string, extensionBase: string): boolean {
  const page = extensionBase.replace(/\/+$/, '') + '/' + BLOCKED_PAGE;
  return url === page || url.startsWith(page + '?') || url.startsWith(page + '#');
}

/**
 * The hostname of an http(s) URL as DNR sees it (lowercase, punycode), without trailing
 * dots (`youtube.com.` is `youtube.com`); `null` for other schemes and invalid URLs.
 */
export function hostFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/\.+$/, '');
  return host.length > 0 ? host : null;
}

/** Status of the attempt shown on blocked.html. */
export type BlockedTabStatus =
  /** Being reported to the guardian. */
  | 'reporting'
  /** Counted by the guardian (`pointsDelta` ≤ 0; 0 with penalties off). */
  | 'counted'
  /** Same attempt as one less than 30 s earlier: `episodePointsDelta` is what it cost. */
  | 'merged'
  /** The guardian did not count it (`guardianReason`: not blocked any more, allowance). */
  | 'not_counted'
  /** No answer from the guardian (down, unpaired, rate limited): nothing was charged. */
  | 'unreported'
  /** A reload or back/forward within the dedupe window: not reported again. */
  | 'ignored'
  /** The tab was already open when the block started: not an attempt. */
  | 'enforced';

/** The covering block the page shows (its reason, «tu motivo», and when it ends). */
export type BlockedTabBlock = Pick<ExtRuleBlock, 'id' | 'kind' | 'mode' | 'endsAt' | 'reason'>;

/**
 * What the background tells blocked.html about the attempt in its tab. Kept in
 * `chrome.storage.session` (memory only, cleared when the browser closes) under
 * `blockedTabKey(tabId)`; the page reads it for its own tab (`chrome.tabs.getCurrent()`)
 * and listens to `chrome.storage.onChanged`, or asks with `BLOCKED_INFO_MESSAGE`.
 */
export interface BlockedTabInfo {
  v: 1;
  tabId: number;
  /** Hostname the tab tried to open (the only thing sent to the guardian). */
  host: string | null;
  /** Full URL, kept in session storage only (never sent), e.g. to reopen it later. */
  url: string | null;
  serviceId: string | null;
  cause: BlockedCause;
  status: BlockedTabStatus;
  /** `Date.now()` of the detection. Pages ignore info older than their own load. */
  at: number;
  /** Points this detection cost (≤ 0); `null` when unknown. */
  pointsDelta: number | null;
  /** Points the attempt it belongs to cost (≤ 0), for «−20 puntos» after a reload. */
  episodePointsDelta: number | null;
  /** What another attempt would cost now (positive), from the guardian. */
  nextPenalty: number | null;
  penaltiesEnabled: boolean | null;
  guardianReason: AttemptResponse['reason'];
  block: BlockedTabBlock | null;
}

/** Key of a tab's `BlockedTabInfo` in `chrome.storage.session`. */
export const BLOCKED_TAB_KEY_PREFIX = 'centrate.blockedTab.';

export function blockedTabKey(tabId: number): string {
  return `${BLOCKED_TAB_KEY_PREFIX}${tabId}`;
}

/** Message type blocked.html may send; the answer is its tab's `BlockedTabInfo` or `null`. */
export const BLOCKED_INFO_MESSAGE = 'centrate/blocked-info';

const STATUSES: readonly BlockedTabStatus[] = [
  'reporting',
  'counted',
  'merged',
  'not_counted',
  'unreported',
  'ignored',
  'enforced',
];

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v));
const isStringOrNull = (v: unknown, max: number): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= max);

/** Longest `BlockedTabInfo.url` kept (and accepted by `parseBlockedTabInfo`). */
export const MAX_STORED_URL = 8192;

/** The URL to keep in a `BlockedTabInfo`: longer ones are dropped so the record stays valid. */
export function storedUrl(url: string | null): string | null {
  return url !== null && url.length <= MAX_STORED_URL ? url : null;
}

/** Validates a stored `BlockedTabInfo` (pages use it before displaying anything). */
export function parseBlockedTabInfo(value: unknown): BlockedTabInfo | null {
  if (!isObject(value) || value['v'] !== 1) return null;
  const v = value;
  if (typeof v['tabId'] !== 'number' || !Number.isSafeInteger(v['tabId'])) return null;
  if (!isStringOrNull(v['host'], 253) || !isStringOrNull(v['url'], MAX_STORED_URL)) return null;
  if (!isStringOrNull(v['serviceId'], 64)) return null;
  if (v['cause'] !== 'domain' && v['cause'] !== 'whitelist') return null;
  if (!STATUSES.includes(v['status'] as BlockedTabStatus)) return null;
  if (typeof v['at'] !== 'number' || !Number.isFinite(v['at'])) return null;
  if (!isIntOrNull(v['pointsDelta']) || !isIntOrNull(v['episodePointsDelta'])) return null;
  if (!isIntOrNull(v['nextPenalty'])) return null;
  if (v['penaltiesEnabled'] !== null && typeof v['penaltiesEnabled'] !== 'boolean') return null;
  const reason = v['guardianReason'];
  if (reason !== null && reason !== 'not_blocked' && reason !== 'allowance_active') return null;
  const block = v['block'];
  if (block !== null) {
    if (!isObject(block)) return null;
    for (const key of ['id', 'kind', 'mode', 'endsAt'] as const) {
      if (typeof block[key] !== 'string' || (block[key] as string).length > 64) return null;
    }
    if (typeof block['reason'] !== 'string' || block['reason'].length > 400) return null;
  }
  return value as unknown as BlockedTabInfo;
}

/** For blocked.html: its tab's info, validated (`null` if absent or malformed). */
export async function readBlockedTabInfo(tabId: number): Promise<BlockedTabInfo | null> {
  const key = blockedTabKey(tabId);
  const items = await chrome.storage.session.get(key);
  return parseBlockedTabInfo(items[key]);
}

/** For blocked.html: calls `listener` whenever its tab's info changes; returns the unsubscribe. */
export function watchBlockedTabInfo(
  tabId: number,
  listener: (info: BlockedTabInfo | null) => void,
): () => void {
  const key = blockedTabKey(tabId);
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const change = changes[key];
    if (area === 'session' && change !== undefined) listener(parseBlockedTabInfo(change.newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// ---------------------------------------------------------------------------------------
// Host patterns → regexFilter
// ---------------------------------------------------------------------------------------

/** Characters that separate the host from the rest of a URL; a host pattern must not match them. */
const URL_DELIMITERS = ['/', '?', '#', '@', ':', '\\', '[', ']', '%', ' '];
const DELIMITER_CODES = URL_DELIMITERS.map((c) => c.charCodeAt(0));
const ALNUM = /^[A-Za-z0-9]$/;

function isUnescapedAnchor(pattern: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && pattern[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 0;
}

/**
 * An escape (`\` + `next`) that stays within host characters: `\d`, `\w` and escaped
 * punctuation other than URL delimiters (`\.`, `\-`). Letter escapes (`\D`, `\s`, `\x2f`,
 * `\p{…}`, backreferences…) could match a delimiter or differ between RE2 and JavaScript.
 */
function isSafeEscape(next: string | undefined): next is string {
  if (next === undefined) return false;
  if (next === 'd' || next === 'w') return true;
  return !ALNUM.test(next) && !URL_DELIMITERS.includes(next);
}

/**
 * True when the body of a host pattern (without `^…$`) can only match host characters:
 * no `.` wildcard, no negated or delimiter-spanning class, no lookaround, no
 * backreference, no inner anchor. The catalog patterns (`^lh[3-7]\.google\.com$`…) pass.
 */
function isSafeHostPatternBody(body: string): boolean {
  let i = 0;
  while (i < body.length) {
    const c = body[i] as string;
    if (c === '\\') {
      if (!isSafeEscape(body[i + 1])) return false;
      i += 2;
      continue;
    }
    if (c === '.' || c === '^' || c === '$') return false;
    if (c === '(') {
      if (body[i + 1] === '?' && body[i + 2] !== ':') return false;
      i += 1;
      continue;
    }
    if (c === '[') {
      const end = scanClass(body, i);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return true;
}

/**
 * Validates the character class starting at `start` (no negation, no member or range that
 * covers a URL delimiter); returns the index of its closing `]`, or −1.
 */
function scanClass(body: string, start: number): number {
  let i = start + 1;
  if (body[i] === '^' || body[i] === ']') return -1;
  while (i < body.length) {
    let c = body[i] as string;
    if (c === ']') return i;
    if (c === '\\') {
      const next = body[i + 1];
      if (next === 'd' || next === 'w') {
        i += 2;
        continue;
      }
      if (!isSafeEscape(next)) return -1;
      c = next;
      i += 1;
    }
    const low = c.charCodeAt(0);
    if (DELIMITER_CODES.includes(low)) return -1;
    if (body[i + 1] === '-' && body[i + 2] !== undefined && body[i + 2] !== ']') {
      let highChar = body[i + 2] as string;
      let skip = 3;
      if (highChar === '\\') {
        const escaped = body[i + 3];
        if (!isSafeEscape(escaped) || escaped === 'd' || escaped === 'w') return -1;
        highChar = escaped;
        skip = 4;
      }
      const high = highChar.charCodeAt(0);
      if (high < low || DELIMITER_CODES.some((d) => d >= low && d <= high)) return -1;
      i += skip;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * The DNR `regexFilter` for a whitelist host pattern (`^…$`, matched against the whole
 * host), or `null` when the pattern is not anchored or not provably host-only.
 */
export function hostPatternToRegexFilter(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length < 3 || pattern.length > 512) return null;
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return null;
  if (!isUnescapedAnchor(pattern, pattern.length - 1)) return null;
  const body = pattern.slice(1, -1);
  if (!isSafeHostPatternBody(body)) return null;
  return `^https?://(?:${body})(?::[0-9]+)?(?:[/?#]|$)`;
}

// ---------------------------------------------------------------------------------------
// Rules → DNR
// ---------------------------------------------------------------------------------------

export interface BuildDnrOptions {
  limits?: Partial<DnrLimits>;
  /** `regexFilter`s the browser rejected (`isRegexSupported`); they are left out. */
  unsupportedRegex?: ReadonlySet<string>;
  /** Leave out every host-pattern rule (fallback after the browser refused an update). */
  skipHostPatterns?: boolean;
}

export interface DnrPlan {
  rules: DnrRuleSpec[];
  /** Whitelist host patterns left out (unsafe, unsupported, over budget): their hosts stay blocked. */
  droppedPatterns: string[];
  /** Blocked hosts were merged into service-less redirect rules to fit `maxRules`. */
  merged: boolean;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Blocked hosts per catalog service (`null`: no known service), services sorted, `null` last. */
export function groupDomainsByService(
  domains: readonly string[],
): Array<[string | null, string[]]> {
  const groups = new Map<string | null, string[]>();
  for (const domain of uniqueSorted(domains)) {
    const id = findServiceByDomain(domain)?.id ?? null;
    const list = groups.get(id);
    if (list) list.push(domain);
    else groups.set(id, [domain]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  });
}

function allowDomainsRules(
  domains: readonly string[],
  size: number,
  types: ResourceType[],
  priority: number,
): DnrRuleSpec[] {
  return chunk(domains, size).map((requestDomains) => ({
    priority,
    action: { type: 'allow' },
    condition: { requestDomains, resourceTypes: [...types] },
  }));
}

function redirectRule(requestDomains: string[], serviceId: string | null): DnrRuleSpec {
  return {
    priority: DNR_PRIORITY.redirectBlocked,
    action: {
      type: 'redirect',
      redirect: { extensionPath: blockedPagePath({ cause: 'domain', serviceId, enforced: false }) },
    },
    condition: { requestDomains, resourceTypes: [...BLOCK_TYPES] },
  };
}

/**
 * The dynamic rules for `rules` (without ids), in priority order. `null` or nothing to
 * enforce gives no rules at all.
 */
export function buildDnrRules(
  rules: ExtRulesResponse | null,
  options: BuildDnrOptions = {},
): DnrPlan {
  const limits: DnrLimits = { ...DEFAULT_DNR_LIMITS, ...options.limits };
  const empty: DnrPlan = { rules: [], droppedPatterns: [], merged: false };
  if (rules === null) return empty;

  const blockDomains = uniqueSorted(rules.blockDomains.filter(isValidDomain));
  const whitelist = rules.whitelist;
  if (blockDomains.length === 0 && whitelist === null) return empty;

  const excluded = uniqueSorted(rules.excludedDomains.filter(isValidDomain));
  const allowDomains =
    whitelist === null ? [] : uniqueSorted(whitelist.allowDomains.filter(isValidDomain));

  // Host patterns: the loopback rule takes one regex slot.
  const droppedPatterns: string[] = [];
  const patternFilters: string[] = [];
  if (whitelist !== null) {
    let slots = Math.max(0, limits.maxRegexRules - 1);
    for (const pattern of uniqueSorted(whitelist.allowHostPatterns)) {
      const filter = options.skipHostPatterns ? null : hostPatternToRegexFilter(pattern);
      if (filter === null || options.unsupportedRegex?.has(filter) || slots === 0) {
        droppedPatterns.push(pattern);
        continue;
      }
      slots -= 1;
      patternFilters.push(filter);
    }
  }

  const build = (domainsPerRule: number, merged: boolean, patterns: boolean): DnrRuleSpec[] => {
    const out: DnrRuleSpec[] = [];
    out.push(...allowDomainsRules(excluded, domainsPerRule, BLOCK_TYPES, DNR_PRIORITY.allowExempt));
    out.push({
      priority: DNR_PRIORITY.allowExempt,
      action: { type: 'allow' },
      condition: { regexFilter: LOOPBACK_REGEX_FILTER, resourceTypes: [...BLOCK_TYPES] },
    });
    const groups: Array<[string | null, string[]]> = merged
      ? [[null, blockDomains]]
      : groupDomainsByService(blockDomains);
    for (const [serviceId, domains] of groups) {
      for (const part of chunk(domains, domainsPerRule)) out.push(redirectRule(part, serviceId));
    }
    if (whitelist !== null) {
      out.push(
        ...allowDomainsRules(allowDomains, domainsPerRule, MAIN_FRAME, DNR_PRIORITY.allowWhitelist),
      );
      for (const regexFilter of patterns ? patternFilters : []) {
        out.push({
          priority: DNR_PRIORITY.allowWhitelist,
          action: { type: 'allow' },
          condition: { regexFilter, resourceTypes: [...MAIN_FRAME] },
        });
      }
      out.push({
        priority: DNR_PRIORITY.redirectWhitelist,
        action: {
          type: 'redirect',
          redirect: {
            extensionPath: blockedPagePath({
              cause: 'whitelist',
              serviceId: null,
              enforced: false,
            }),
          },
        },
        condition: { urlFilter: ANY_WEB_URL_FILTER, resourceTypes: [...MAIN_FRAME] },
      });
    }
    return out;
  };

  let size = Math.max(1, Math.floor(limits.domainsPerRule));
  let merged = false;
  let out = build(size, merged, true);
  while (out.length > limits.maxRules) {
    // Never drop a blocked host: merge services first, then grow the lists.
    if (!merged) merged = true;
    else if (size < 1_000_000) size *= 2;
    else break;
    out = build(size, merged, true);
  }
  if (out.length > limits.maxRules && patternFilters.length > 0) {
    // Last resort: whitelist host patterns (their hosts stay blocked). If it still does not
    // fit, the browser refuses the update and the previous rules stay.
    out = build(size, merged, false);
    const kept = new Set(droppedPatterns);
    for (const pattern of uniqueSorted(whitelist?.allowHostPatterns ?? [])) {
      if (!kept.has(pattern)) droppedPatterns.push(pattern);
    }
  }
  return { rules: out, droppedPatterns, merged };
}
