/**
 * A mock Céntrate guardian over real HTTP on 127.0.0.1, for the extension's end-to-end
 * tests (apps/extension/e2e) and for trying the extension by hand without the Go service.
 *
 * It implements the extension's side of the contract (docs/ARCHITECTURE.md §8.8, §9.3, §9.4)
 * with the shared types, validators, catalog and points ledger:
 *
 * - `POST /v1/pairing/claim`: 6-digit code (single use, 5 failures burn it, TTL), returns
 *   a `cte_…` token bound to the browser family and the request `Origin`, plus the SPKI of
 *   a real ECDSA P-256 rules key generated at start.
 * - `GET /v1/ext/rules`: the body is signed (`X-Centrate-Signature: v1=…`, raw r‖s over the
 *   exact bytes) and echoes the request `nonce`; `ETag: "r-<extRulesVersion>"` with 304 on
 *   `If-None-Match`; long poll with `waitVersion` + `waitMs` (≤ 25 s), at most 4 per token.
 *   `extRulesVersion` starts at `Date.now()` and only grows, also across `stop()`/`start()`.
 * - `POST /v1/ext/heartbeat`: records it; the family must match the pairing.
 * - `POST /v1/attempts`: ext scope (`extension` + `domain`), coverage like §10.8, 30 s
 *   merge window and 5 min escalation through `applyLedgerInput` (−10, −20, −40, −80).
 * - `POST /v1/usage`: ext scope (`domain` items), clamped to the time since that
 *   extension's previous report (+ slack) and credited once per limit with the shared
 *   `limitUsageCredit`; an allowance used up creates a block with `limitId` (served to the
 *   extension as `kind: "manual"`, §8.4) until the next UTC midnight (the mock's «local day»).
 * - `GET /v1/health` and `POST /v1/pairing/code` (app token), so tests can act as the app.
 *
 * Request pipeline as in §8.3: `Host` must be `127.0.0.1:<port>` / `localhost:<port>`,
 * `Origin` (when present) must be the pinned Chromium extension id or a `moz-extension://`
 * origin, CORS preflights get the §9.4 headers, bodies need `application/json` (≤ 64 KiB).
 *
 * Test controls (in-process; the real guardian has no way to end a block early):
 * `addBlock`, `removeBlock`, `clearBlocks`, `addAllowance`, `removeAllowance`,
 * `setPunishment`, `setPenaltiesEnabled`, `addLimit`, `setLimitUsage`, `revokeExtensions`,
 * `stop`/`start` (guardian down and back on the same port) and waiters for attempts, usage
 * reports, heartbeats and applied versions.
 *
 * Not modelled: rate limits other than the long-poll cap, idempotency, the loopback peer
 * process check, events and the app routes the extension never calls.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  ALWAYS_ALLOWED_HOSTS,
  CATALOG_VERSION,
  findServiceByDomain,
  getService,
  isSameOrSubdomain,
  matchesHostPattern,
  normalizeDomain,
  resolveTargets,
  servicesInCategory,
  studyWhitelistDomains,
  studyWhitelistHostPatterns,
} from '@centrate/shared/catalog';
import type {
  AttemptId,
  BlockId,
  LimitId,
  BlockKind,
  BlockMode,
  BrowserFamily,
  ExtensionId,
  IsoUtc,
  PunishmentLevel,
} from '@centrate/shared/domain';
import type {
  CreditSpan,
  AttemptRequest,
  AttemptResponse,
  ExtHeartbeatRequest,
  ExtRuleBlock,
  ExtRuleLimit,
  ExtRulesResponse,
  GuardianErrorCode,
  HealthResponse,
  PairingClaimRequest,
  PairingClaimResponse,
  PairingCodeResponse,
  Schema,
  UsageReportRequest,
  UsageReportResponse,
} from '@centrate/shared/guardian-api';
import {
  APP_TOKEN_PREFIX,
  CHROMIUM_EXTENSION_ID,
  EXT_TOKEN_PREFIX,
  GUARDIAN_API_VERSION,
  GUARDIAN_CAPABILITIES,
  GUARDIAN_ERROR_STATUS,
  GUARDIAN_HEADERS,
  GUARDIAN_HOST,
  GUARDIAN_LIMITS,
  GUARDIAN_NAME,
  GUARDIAN_PATHS,
  attemptRequestSchema,
  computeRulesSignature,
  extHeartbeatRequestSchema,
  generateRulesKeyPair,
  limitUsageCredit,
  pairingClaimRequestSchema,
  usageReportRequestSchema,
  validateRequest,
  validationErrorCode,
} from '@centrate/shared/guardian-api';
import type { LedgerState } from '@centrate/shared/points';
import {
  POINT_RULES,
  RULES_VERSION,
  applyLedgerInput,
  attemptPenalty,
  initialLedgerState,
  nextEscalationIndex,
} from '@centrate/shared/points';

// ---------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------

export interface MockGuardianOptions {
  /** TCP port on 127.0.0.1; `0` (default) picks a free one. */
  port?: number;
  /** The code the app «shows» at start; default a random 6-digit code. `null`: none. */
  pairingCode?: string | null;
  /** Pairing code lifetime (default `GUARDIAN_LIMITS.pairingCodeTtlMs`, 300 s). */
  pairingCodeTtlMs?: number;
  /** `settings.attemptPenalties` (default true). */
  penaltiesEnabled?: boolean;
  /** Reported as `guardianVersion` / `version`. Default `0.1.0-mock`. */
  guardianVersion?: string;
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Receives one line per request (e.g. `console.log` while debugging a test). */
  log?: (line: string) => void;
}

export interface MockBlockInput {
  /** Catalog service ids (`youtube`, `instagram`…). */
  services?: readonly string[];
  /** Catalog category ids (`social`, `video`…). */
  categories?: readonly string[];
  /** Custom domains or URLs (expanded with `www.` like the app does). */
  domains?: readonly string[];
  /** Whitelist-only block (exam mode, level-2 punishment): blocks every site but the allowed. */
  whitelistOnly?: boolean;
  /**
   * Whitelist blocks only: allowed hosts (each with its subdomains). Default: the catalog's
   * study whitelist (`studyWhitelistDomains()`), which includes wikipedia.org.
   */
  allowDomains?: readonly string[];
  /** Whitelist blocks only: allowed host patterns. Default `studyWhitelistHostPatterns()`. */
  allowHostPatterns?: readonly string[];
  /** Duration from now (default 25). Ignored when `endsAt` is given. */
  minutes?: number;
  /** End as epoch ms or ISO text. */
  endsAt?: number | IsoUtc;
  /** «Tu motivo» (default «Quiero aprobar mates»). */
  reason?: string;
  /** Default `strict` (`exam` for whitelist blocks). */
  mode?: BlockMode;
  /** Default `manual`. */
  kind?: BlockKind;
}

export interface MockLimitInput {
  /** Default: the first service's name, else «Límite». */
  name?: string;
  services?: readonly string[];
  domains?: readonly string[];
  dailyMinutes: number;
  /** Default true (the weekday is in `days`). */
  appliesToday?: boolean;
  mode?: BlockMode;
  reason?: string;
}

/** A daily limit as the mock stores it (usage of the current UTC day). */
export interface MockLimit {
  id: LimitId;
  name: string;
  serviceIds: string[];
  domains: string[];
  excludedDomains: string[];
  dailyMinutes: number;
  appliesToday: boolean;
  mode: BlockMode;
  reason: string;
  usedMs: number;
  creditedUntil: number;
  credited: CreditSpan[];
  /** The block created when the allowance ran out today, if any. */
  blockId: BlockId | null;
}

export interface RecordedUsage {
  at: number;
  extensionId: ExtensionId;
  request: UsageReportRequest;
  response: UsageReportResponse;
}

/** A block as the mock stores it. */
export interface MockBlock {
  id: BlockId;
  /** Set for a limit block (served as `kind: "manual"` to the extension). */
  limitId?: LimitId;
  kind: BlockKind;
  mode: BlockMode;
  reason: string;
  createdAt: number;
  endsAt: number;
  serviceIds: string[];
  domains: string[];
  excludedDomains: string[];
  whitelistOnly: boolean;
  allowDomains: string[];
  allowHostPatterns: string[];
}

export interface MockAllowance {
  serviceId: string;
  endsAt: number;
}

export interface MockExtension {
  id: ExtensionId;
  token: string;
  browser: BrowserFamily;
  browserVersion: string;
  extVersion: string;
  boundOrigin: string | null;
  pairedAt: number;
  revoked: boolean;
}

export interface RecordedRequest {
  at: number;
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  status: number;
  origin: string | null;
  /** The extension id the bearer token belongs to, if any. */
  extensionId: ExtensionId | null;
}

export interface RecordedHeartbeat {
  at: number;
  extensionId: ExtensionId;
  body: ExtHeartbeatRequest;
}

export interface RecordedAttempt {
  at: number;
  extensionId: ExtensionId;
  request: AttemptRequest;
  response: AttemptResponse;
}

export interface MockGuardian {
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /** base64url SPKI of the rules key (what the claim returns). */
  readonly rulesPublicKey: string;
  /** The app token (`cta_…`) accepted by `POST /v1/pairing/code` and `GET /v1/health`. */
  readonly appToken: string;
  /** The code the app is showing, or `null` (used, expired or burned). */
  readonly pairingCode: string | null;
  /** Current `extRulesVersion`. */
  readonly extRulesVersion: number;
  /** Points balance from the ledger (attempt penalties only). */
  readonly balance: number;
  /** True between `stop()` and `start()`. */
  readonly stopped: boolean;

  /** Like the app asking for a code: a new one replaces the previous. */
  newPairingCode(code?: string): string;
  extensions(): MockExtension[];
  /** 401 for every token from now on (like «Quitar» in the app). */
  revokeExtensions(): void;

  addBlock(input: MockBlockInput): MockBlock;
  /** Test-only: the real guardian never ends a block early. */
  removeBlock(id: BlockId): boolean;
  clearBlocks(): void;
  blocks(): MockBlock[];
  /** A reward allowance for a catalog service (default 15 min). */
  addAllowance(serviceId: string, minutes?: number): MockAllowance;
  removeAllowance(serviceId: string): boolean;
  setPunishment(value: { level: PunishmentLevel; minutes: number } | null): void;
  setPenaltiesEnabled(enabled: boolean): void;
  /** A daily limit (§5.10), enabled; it appears in `rules().limits`. */
  addLimit(input: MockLimitInput): MockLimit;
  /** Test-only: sets today's usage of a limit (and blocks at once when it is used up). */
  setLimitUsage(id: LimitId, seconds: number): MockLimit;
  limits(): MockLimit[];

  /** The rules body as it would be served now (with an empty nonce). */
  rules(): ExtRulesResponse;
  requests(): RecordedRequest[];
  heartbeats(): RecordedHeartbeat[];
  attempts(): RecordedAttempt[];
  usageReports(): RecordedUsage[];

  /** Resolves with the first attempt (from now or already recorded) matching `predicate`. */
  waitForAttempt(
    predicate?: (attempt: RecordedAttempt) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedAttempt>;
  waitForUsage(
    predicate?: (report: RecordedUsage) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedUsage>;
  waitForHeartbeat(
    predicate?: (heartbeat: RecordedHeartbeat) => boolean,
    timeoutMs?: number,
  ): Promise<RecordedHeartbeat>;
  /**
   * Resolves when an extension reports (heartbeat `appliedExtRulesVersion`) the given
   * version, default the current one: its declarativeNetRequest rules are in place.
   */
  waitForApplied(version?: number, timeoutMs?: number): Promise<RecordedHeartbeat>;

  /** Guardian down: closes the listener and every open connection (long polls included). */
  stop(): Promise<void>;
  /** Listens again on the same port (same keys, tokens, blocks and version counter). */
  start(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LONG_POLLS_PER_TOKEN = 4;
const DEFAULT_REASON = 'Quiero aprobar mates';
const MOZ_ORIGIN_RE =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function newId<P extends string>(prefix: P): `${P}_${string}` {
  let body = '';
  for (let i = 0; i < 22; i += 1) body += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `${prefix}_${body}`;
}

const isoAt = (ms: number): IsoUtc => new Date(ms).toISOString();
const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const underAny = (host: string, parents: Iterable<string>): boolean => {
  for (const parent of parents) if (isSameOrSubdomain(host, parent)) return true;
  return false;
};

/** Intersection of the whitelist blocks' allow sets; `null` without whitelist blocks. */
function whitelistAllowSet(
  whitelistBlocks: readonly MockBlock[],
): { allowDomains: string[]; allowHostPatterns: string[] } | null {
  const [first, ...rest] = whitelistBlocks;
  if (first === undefined) return null;
  let allowDomains = first.allowDomains;
  let allowHostPatterns = first.allowHostPatterns;
  for (const block of rest) {
    allowDomains = allowDomains.filter((d) => block.allowDomains.includes(d));
    allowHostPatterns = allowHostPatterns.filter((p) => block.allowHostPatterns.includes(p));
  }
  return { allowDomains: unique(allowDomains), allowHostPatterns: unique(allowHostPatterns) };
}

function randomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** An allowed extension origin (§9.4): the pinned Chromium id or any Firefox UUID. */
export function isAllowedExtensionOrigin(origin: string): boolean {
  return origin === `chrome-extension://${CHROMIUM_EXTENSION_ID}` || MOZ_ORIGIN_RE.test(origin);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: GuardianErrorCode | string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function fail(
  code: GuardianErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
  headers: Record<string, string> = {},
): HttpError {
  return new HttpError(GUARDIAN_ERROR_STATUS[code], code, message, details, headers);
}

function validated<T>(schema: Schema<T>, value: unknown): T {
  const result = validateRequest(schema, value);
  if (result.ok) return result.value;
  const { path, issue, message } = result.issue;
  throw fail(validationErrorCode(result.issue), message, { path, issue });
}

// ---------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------

interface Waiter<T> {
  match(value: T): boolean;
  resolve(value: T): void;
}

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  origin: string | null;
  corsHeaders: Record<string, string>;
  extension: MockExtension | null;
  record: RecordedRequest;
}

export async function startMockGuardian(options: MockGuardianOptions = {}): Promise<MockGuardian> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const guardianVersion = options.guardianVersion ?? '0.1.0-mock';
  const codeTtlMs = options.pairingCodeTtlMs ?? GUARDIAN_LIMITS.pairingCodeTtlMs;
  const startedAt = now();
  const keys = await generateRulesKeyPair();
  const appToken = `${APP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

  let port = options.port ?? 0;
  let stopped = true;
  let penaltiesEnabled = options.penaltiesEnabled ?? true;
  let code: { value: string; expiresAt: number; failures: number } | null = null;
  const extensions = new Map<string, MockExtension>();
  const blocks = new Map<BlockId, MockBlock>();
  const limits = new Map<LimitId, MockLimit>();
  /** When each extension's previous usage report was accepted (§10.13 per-client clamp). */
  const lastUsageAt = new Map<ExtensionId, number>();
  const allowances = new Map<string, MockAllowance>();
  let punishment: { endsAt: number; level: PunishmentLevel } | null = null;
  let ledger: LedgerState = initialLedgerState();
  /** Last counted attempt per dedupe key, to answer merged detections. */
  const lastCounted = new Map<string, { id: AttemptId; delta: number }>();

  // extRulesVersion: persisted-and-increasing in the real guardian; here one counter per mock.
  let version = Math.max(1, startedAt);
  let fingerprint = '';
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const versionWaiters = new Set<() => void>();
  const longPolls = new Map<string, number>();

  const recorded: RecordedRequest[] = [];
  const heartbeatLog: RecordedHeartbeat[] = [];
  const attemptLog: RecordedAttempt[] = [];
  const usageLog: RecordedUsage[] = [];
  const usageWaiters = new Set<Waiter<RecordedUsage>>();
  const heartbeatWaiters = new Set<Waiter<RecordedHeartbeat>>();
  const attemptWaiters = new Set<Waiter<RecordedAttempt>>();

  const sockets = new Set<Socket>();
  let server: Server | null = null;

  const setCode = (value: string | null): string | null => {
    code = value === null ? null : { value, expiresAt: now() + codeTtlMs, failures: 0 };
    return value;
  };
  setCode(options.pairingCode === undefined ? randomCode() : options.pairingCode);

  // --- Rules ---------------------------------------------------------------------------

  const liveBlocks = (at: number): MockBlock[] =>
    [...blocks.values()].filter((b) => b.endsAt > at).sort((a, b) => a.createdAt - b.createdAt);
  const liveAllowances = (at: number): MockAllowance[] =>
    [...allowances.values()].filter((a) => a.endsAt > at);
  const allowanceHosts = (at: number): string[] =>
    liveAllowances(at).flatMap((a) => getService(a.serviceId)?.domains ?? []);

  function buildRules(at: number, nonce: string): ExtRulesResponse {
    const live = liveBlocks(at);
    const opened = allowanceHosts(at);
    const domainBlocks = live.filter((b) => !b.whitelistOnly);
    const whitelistBlocks = live.filter((b) => b.whitelistOnly);

    const blocked = unique(domainBlocks.flatMap((b) => b.domains)).filter(
      (host) => !underAny(host, opened) && !underAny(host, ALWAYS_ALLOWED_HOSTS),
    );
    const excluded = unique([
      ...domainBlocks.flatMap((b) => b.excludedDomains),
      ...ALWAYS_ALLOWED_HOSTS.filter((host) => blocked.some((d) => isSameOrSubdomain(host, d))),
    ]);

    const allowSet = whitelistAllowSet(whitelistBlocks);
    const whitelist: ExtRulesResponse['whitelist'] =
      allowSet === null
        ? null
        : {
            allowDomains: unique([...allowSet.allowDomains, ...opened, ...ALWAYS_ALLOWED_HOSTS]),
            allowHostPatterns: allowSet.allowHostPatterns,
          };

    const ends = [...live.map((b) => b.endsAt), ...liveAllowances(at).map((a) => a.endsAt)];
    const livePunishment = punishment !== null && punishment.endsAt > at ? punishment : null;
    return {
      extRulesVersion: version,
      nonce,
      serverNow: isoAt(at),
      blockDomains: blocked,
      excludedDomains: excluded,
      whitelist,
      blocks: live.map((b): ExtRuleBlock => ({
        id: b.id,
        kind: b.kind,
        mode: b.mode,
        endsAt: isoAt(b.endsAt),
        reason: b.reason,
        serviceIds: b.serviceIds,
        domains: b.whitelistOnly ? [] : b.domains,
        whitelistOnly: b.whitelistOnly,
        ...(b.limitId === undefined ? {} : { limitId: b.limitId }),
      })),
      allowances: liveAllowances(at).map((a) => ({
        serviceId: a.serviceId,
        endsAt: isoAt(a.endsAt),
      })),
      punishment:
        livePunishment === null
          ? null
          : { endsAt: isoAt(livePunishment.endsAt), level: livePunishment.level },
      nextChangeAt: ends.length > 0 ? isoAt(Math.min(...ends)) : null,
      penaltiesEnabled,
      limits: [...limits.values()].map((l): ExtRuleLimit => ({
        id: l.id,
        name: l.name,
        serviceIds: l.serviceIds,
        domains: l.domains,
        excludedDomains: l.excludedDomains,
        dailyMinutes: l.dailyMinutes,
        appliesToday: l.appliesToday,
      })),
    };
  }

  /** Bumps the version when the served rules changed (a mutation or something ending). */
  function refresh(): void {
    const at = now();
    const rules = buildRules(at, '');
    const print = JSON.stringify({ ...rules, extRulesVersion: 0, serverNow: '' });
    if (print !== fingerprint) {
      const first = fingerprint === '';
      fingerprint = print;
      if (!first) {
        version += 1;
        for (const wake of [...versionWaiters]) wake();
      }
    }
    if (changeTimer !== null) clearTimeout(changeTimer);
    changeTimer = null;
    const next = rules.nextChangeAt === null ? null : Date.parse(rules.nextChangeAt);
    const punishmentEnd = punishment !== null && punishment.endsAt > at ? punishment.endsAt : null;
    const wakeAt = [next, punishmentEnd].filter((t): t is number => t !== null);
    if (wakeAt.length > 0) {
      // setTimeout fires at once past 2^31 − 1 ms: far ends just re-check later.
      const delay = Math.min(Math.max(0, Math.min(...wakeAt) - at) + 20, 2 ** 31 - 1);
      changeTimer = setTimeout(refresh, delay);
      changeTimer.unref();
    }
  }
  refresh();

  async function signedRules(nonce: string): Promise<{ body: string; signature: string }> {
    const body = JSON.stringify(buildRules(now(), nonce));
    return { body, signature: await computeRulesSignature(body, keys.privateKey) };
  }

  // --- Attempts ------------------------------------------------------------------------

  /** Live blocks that cover `host` (§10.8), ignoring allowances. */
  function coveringBlocks(host: string, at: number): MockBlock[] {
    if (underAny(host, ALWAYS_ALLOWED_HOSTS)) return [];
    const live = liveBlocks(at);
    const covering = live.filter(
      (b) => !b.whitelistOnly && underAny(host, b.domains) && !underAny(host, b.excludedDomains),
    );
    const whitelistBlocks = live.filter((b) => b.whitelistOnly);
    const allowSet = whitelistAllowSet(whitelistBlocks);
    if (
      allowSet !== null &&
      !underAny(host, allowSet.allowDomains) &&
      !allowSet.allowHostPatterns.some((p) => matchesHostPattern(host, p))
    ) {
      covering.push(...whitelistBlocks);
    }
    return covering;
  }

  function handleAttempt(request: AttemptRequest): AttemptResponse {
    const at = now();
    const escalationNow = (): number =>
      attemptPenalty(nextEscalationIndex(ledger.escalation, at, POINT_RULES), POINT_RULES);
    const host = normalizeDomain(request.target.value);
    const service = host === null ? undefined : findServiceByDomain(host);
    const notBlocked = (reason: AttemptResponse['reason']): AttemptResponse => ({
      blocked: false,
      counted: false,
      merged: false,
      attemptId: null,
      pointsDelta: 0,
      episodePointsDelta: 0,
      escalationIndex: null,
      nextPenalty: escalationNow(),
      serviceId: service?.id ?? null,
      block: null,
      reason,
    });
    if (host === null) return notBlocked('not_blocked');
    const covering = coveringBlocks(host, at);
    if (covering.length === 0) return notBlocked('not_blocked');
    if (service !== undefined && liveAllowances(at).some((a) => a.serviceId === service.id)) {
      return notBlocked('allowance_active');
    }

    // The block with the latest end (ties: the most recently created).
    const shown = covering.reduce((best, b) =>
      b.endsAt > best.endsAt || (b.endsAt === best.endsAt && b.createdAt >= best.createdAt)
        ? b
        : best,
    );
    const key = service !== undefined ? `svc:${service.id}` : `dom:${host.replace(/^www\./, '')}`;
    const step = applyLedgerInput(
      ledger,
      {
        type: 'attempt_detected',
        atMs: at,
        day: isoAt(at).slice(0, 10),
        key,
        penalized: penaltiesEnabled,
      },
      POINT_RULES,
    );
    ledger = step.state;
    const counted = step.outcome.counted === true;
    let attemptId: AttemptId | null;
    let episode: number;
    if (counted) {
      attemptId = newId('att');
      episode = step.points;
      lastCounted.set(key, { id: attemptId, delta: episode });
    } else {
      const previous = lastCounted.get(key);
      attemptId = previous?.id ?? null;
      episode = previous?.delta ?? 0;
    }
    return {
      blocked: true,
      counted,
      merged: !counted,
      attemptId,
      pointsDelta: counted ? step.points : 0,
      episodePointsDelta: episode,
      escalationIndex: counted ? (step.outcome.escalationIndex ?? 0) : null,
      nextPenalty: escalationNow(),
      serviceId: service?.id ?? null,
      block: {
        id: shown.id,
        kind: shown.kind,
        mode: shown.mode,
        endsAt: isoAt(shown.endsAt),
        reason: shown.reason,
        ...(shown.limitId === undefined ? {} : { limitId: shown.limitId }),
      },
      reason: null,
    };
  }

  // --- Daily limits --------------------------------------------------------------------

  const DAY_MS = 86_400_000;
  /** The mock's «local day» is the UTC day. */
  const dayStart = (at: number): number => Math.floor(at / DAY_MS) * DAY_MS;

  /** Blocks a limit whose allowance ran out today (once per day, §10.13). */
  function evaluateLimit(limit: MockLimit, at: number): void {
    if (!limit.appliesToday || limit.blockId !== null) return;
    if (limit.usedMs < limit.dailyMinutes * 60_000) return;
    const block: MockBlock = {
      id: newId('blk'),
      limitId: limit.id,
      // The extension token never sees kind `limit` (§8.4).
      kind: 'manual',
      mode: limit.mode,
      reason: limit.reason,
      createdAt: at,
      endsAt: dayStart(at) + DAY_MS,
      serviceIds: limit.serviceIds,
      domains: limit.domains,
      excludedDomains: limit.excludedDomains,
      whitelistOnly: false,
      allowDomains: [],
      allowHostPatterns: [],
    };
    blocks.set(block.id, block);
    limit.blockId = block.id;
    refresh();
  }

  function handleUsage(ext: MockExtension, request: UsageReportRequest): UsageReportResponse {
    const at = now();
    const previous = lastUsageAt.get(ext.id);
    lastUsageAt.set(ext.id, at);
    const slack = GUARDIAN_LIMITS.usageSlackMs;
    const interval =
      previous === undefined
        ? request.intervalMs
        : Math.min(request.intervalMs, Math.max(0, at - previous) + slack);
    const credited = new Map<LimitId, number>();
    for (const limit of limits.values()) {
      let reported = 0;
      for (const item of request.items) {
        const host = normalizeDomain(item.value);
        if (host === null) continue;
        if (underAny(host, limit.domains) && !underAny(host, limit.excludedDomains)) {
          reported += item.seconds * 1_000;
        }
      }
      const credit = limitUsageCredit({
        nowMs: at,
        dayStartMs: dayStart(at),
        intervalMs: interval,
        reportedMs: Math.min(reported, interval),
        creditedUntilMs: limit.creditedUntil,
        credited: limit.credited,
        slackMs: slack,
      });
      limit.usedMs += credit.creditMs;
      limit.credited = credit.credited;
      credited.set(limit.id, Math.floor(credit.creditMs / 1_000));
      evaluateLimit(limit, at);
    }
    return {
      day: isoAt(at).slice(0, 10),
      limits: [...limits.values()].map((l) => {
        const used = Math.floor(l.usedMs / 1_000);
        const block = l.blockId === null ? undefined : blocks.get(l.blockId);
        return {
          limitId: l.id,
          usedTodaySeconds: used,
          remainingTodaySeconds: Math.max(0, l.dailyMinutes * 60 - used),
          appliesToday: l.appliesToday,
          creditedSeconds: credited.get(l.id) ?? 0,
          blockedUntil: block !== undefined && block.endsAt > at ? isoAt(block.endsAt) : null,
        };
      }),
      serverNow: isoAt(at),
    };
  }

  // --- HTTP ----------------------------------------------------------------------------

  const send = (
    ctx: Context,
    status: number,
    body: string | null,
    headers: Record<string, string> = {},
  ): void => {
    ctx.record.status = status;
    if (ctx.res.headersSent || ctx.res.destroyed) return;
    ctx.res.writeHead(status, {
      'Cache-Control': 'no-store',
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      ...ctx.corsHeaders,
      ...headers,
    });
    ctx.res.end(body ?? undefined);
  };
  const sendJson = (
    ctx: Context,
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
  ): void => send(ctx, status, JSON.stringify(value), headers);

  function readBody(req: IncomingMessage): Promise<unknown> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      req.resume();
      return Promise.reject(fail('unsupported_media_type', 'expected application/json'));
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(fail('body_too_large', 'body over 64 KiB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', reject);
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(fail('invalid_json', 'malformed JSON'));
        }
      });
    });
  }

  function bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length).trim();
  }

  function requireExtension(ctx: Context): MockExtension {
    const ext = ctx.extension;
    if (ext === null) {
      throw fail('unauthorized', 'missing or unknown token', null, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (ext.boundOrigin !== null && ctx.origin !== null && ctx.origin !== ext.boundOrigin) {
      throw fail('origin_not_allowed', 'origin does not match the paired extension');
    }
    return ext;
  }

  function requireApp(ctx: Context): void {
    const token = bearer(ctx.req);
    if (token === null || !token.startsWith(APP_TOKEN_PREFIX) || token !== appToken) {
      throw fail('unauthorized', 'missing or unknown token', null, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (ctx.origin !== null) throw fail('origin_not_allowed', 'app requests carry no Origin');
  }

  async function handleExtRules(ctx: Context): Promise<void> {
    const ext = requireExtension(ctx);
    const q = ctx.url.searchParams;
    const nonce = q.get('nonce');
    if (nonce === null || !NONCE_RE.test(nonce)) {
      throw fail('bad_query', 'nonce must be 16–64 base64url characters');
    }
    const intParam = (name: string, max: number): number | undefined => {
      const raw = q.get(name);
      if (raw === null) return undefined;
      if (!/^\d{1,16}$/.test(raw) || Number(raw) > max) throw fail('bad_query', `bad ${name}`);
      return Number(raw);
    };
    const waitVersion = intParam('waitVersion', Number.MAX_SAFE_INTEGER);
    const waitMs = intParam('waitMs', GUARDIAN_LIMITS.longPollMaxMs) ?? 0;

    refresh();
    if (waitVersion !== undefined && waitMs > 0 && waitVersion === version) {
      const open = longPolls.get(ext.token) ?? 0;
      if (open >= MAX_LONG_POLLS_PER_TOKEN) {
        throw fail('rate_limited', 'too many long polls', null, { 'Retry-After': '1' });
      }
      longPolls.set(ext.token, open + 1);
      try {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            versionWaiters.delete(done);
            ctx.res.off('close', done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          versionWaiters.add(done);
          ctx.res.on('close', done);
        });
      } finally {
        longPolls.set(ext.token, (longPolls.get(ext.token) ?? 1) - 1);
      }
      if (ctx.res.destroyed || ext.revoked) {
        if (ext.revoked) send(ctx, 401, errorText('unauthorized', 'extension revoked'));
        return;
      }
    }

    const etag = `"r-${version}"`;
    if (ctx.req.headers['if-none-match'] === etag) {
      send(ctx, 304, null, { ETag: etag });
      return;
    }
    const { body, signature } = await signedRules(nonce);
    send(ctx, 200, body, { ETag: etag, [GUARDIAN_HEADERS.signature]: signature });
  }

  async function route(ctx: Context): Promise<void> {
    const { req, url } = ctx;
    const method = req.method ?? 'GET';
    const P = GUARDIAN_PATHS;
    const allow = (methods: string): never => {
      throw fail('method_not_allowed', `use ${methods}`, null, { Allow: methods });
    };

    switch (url.pathname) {
      case P.health: {
        if (method !== 'GET') allow('GET');
        const health: HealthResponse = {
          ok: true,
          name: GUARDIAN_NAME,
          version: guardianVersion,
          apiVersion: GUARDIAN_API_VERSION,
          capabilities: [...GUARDIAN_CAPABILITIES],
          schemaVersion: 1,
          catalogVersion: CATALOG_VERSION,
          rulesVersion: RULES_VERSION,
          startedAt: isoAt(startedAt),
          serverNow: isoAt(now()),
          mode: 'normal',
          problems: [],
        };
        sendJson(ctx, 200, health);
        return;
      }
      case P.pairingCode: {
        if (method !== 'POST') allow('POST');
        requireApp(ctx);
        await readBody(req);
        const value = setCode(randomCode()) ?? '';
        const body: PairingCodeResponse = {
          code: value,
          expiresAt: isoAt(code?.expiresAt ?? now()),
          port,
        };
        sendJson(ctx, 201, body);
        return;
      }
      case P.pairingClaim: {
        if (method !== 'POST') allow('POST');
        const body: PairingClaimRequest = validated(pairingClaimRequestSchema, await readBody(req));
        if (code === null) throw fail('pairing_no_code', 'the app is not showing a code');
        if (now() >= code.expiresAt) {
          code = null;
          throw fail('pairing_code_expired', 'the code expired');
        }
        if (body.code !== code.value) {
          code.failures += 1;
          if (code.failures >= GUARDIAN_LIMITS.pairingMaxFailures) {
            code = null;
            throw fail('pairing_code_expired', 'too many failures: the code was burned');
          }
          throw fail('pairing_code_invalid', 'wrong code');
        }
        code = null;
        const ext: MockExtension = {
          id: newId('ext'),
          token: `${EXT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`,
          browser: body.browser,
          browserVersion: body.browserVersion,
          extVersion: body.extVersion,
          boundOrigin: ctx.origin,
          pairedAt: now(),
          revoked: false,
        };
        extensions.set(ext.token, ext);
        const answer: PairingClaimResponse = {
          extensionId: ext.id,
          token: ext.token,
          guardianVersion,
          boundOrigin: ext.boundOrigin,
          rulesPublicKey: keys.publicKey,
        };
        sendJson(ctx, 201, answer);
        return;
      }
      case P.extRules: {
        if (method !== 'GET') allow('GET');
        await handleExtRules(ctx);
        return;
      }
      case P.extHeartbeat: {
        if (method !== 'POST') allow('POST');
        const ext = requireExtension(ctx);
        const body = validated(extHeartbeatRequestSchema, await readBody(req));
        if (body.browser !== ext.browser) {
          throw fail('insufficient_scope', 'browser family differs from the pairing', {
            reason: 'browser_mismatch',
          });
        }
        const beat: RecordedHeartbeat = { at: now(), extensionId: ext.id, body };
        heartbeatLog.push(beat);
        for (const waiter of [...heartbeatWaiters]) if (waiter.match(beat)) waiter.resolve(beat);
        refresh();
        sendJson(ctx, 200, { extRulesVersion: version, serverNow: isoAt(now()) });
        return;
      }
      case P.usage: {
        if (method !== 'POST') allow('POST');
        const ext = requireExtension(ctx);
        const body = validated(usageReportRequestSchema, await readBody(req));
        if (body.items.some((item) => item.type !== 'domain')) {
          throw fail('insufficient_scope', 'the extension reports domains only');
        }
        refresh();
        const response = handleUsage(ext, body);
        const report: RecordedUsage = { at: now(), extensionId: ext.id, request: body, response };
        usageLog.push(report);
        for (const waiter of [...usageWaiters]) if (waiter.match(report)) waiter.resolve(report);
        sendJson(ctx, 200, response);
        return;
      }
      case P.attempts: {
        if (method !== 'POST') allow('POST');
        const ext = requireExtension(ctx);
        const body = validated(attemptRequestSchema, await readBody(req));
        if (body.layer !== 'extension' || body.target.type !== 'domain') {
          throw fail('insufficient_scope', 'the extension reports domains only');
        }
        refresh();
        const response = handleAttempt(body);
        const attempt: RecordedAttempt = {
          at: now(),
          extensionId: ext.id,
          request: body,
          response,
        };
        attemptLog.push(attempt);
        for (const waiter of [...attemptWaiters])
          if (waiter.match(attempt)) waiter.resolve(attempt);
        sendJson(ctx, 200, response);
        return;
      }
      default:
        throw fail('not_found', `no route for ${url.pathname}`);
    }
  }

  function errorText(
    code: string,
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    return JSON.stringify({ error: { code, message, details } });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${GUARDIAN_HOST}:${port}`);
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === 'string' ? originHeader : null;
    const token = bearer(req);
    const ext = token === null ? null : (extensions.get(token) ?? null);
    const extension = ext !== null && !ext.revoked ? ext : null;
    const record: RecordedRequest = {
      at: now(),
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      status: 0,
      origin,
      extensionId: extension?.id ?? null,
    };
    recorded.push(record);
    const ctx: Context = { req, res, url, origin, corsHeaders: {}, extension, record };

    try {
      // 1. Host (anti DNS rebinding).
      const host = req.headers.host;
      if (host !== `${GUARDIAN_HOST}:${port}` && host !== `localhost:${port}`) {
        throw fail('host_not_allowed', `host ${host ?? '(none)'} not allowed`);
      }
      // 2. Origin: only extension origins (web pages get 403 on every route).
      if (origin !== null) {
        if (!isAllowedExtensionOrigin(origin)) throw fail('origin_not_allowed', 'origin');
        ctx.corsHeaders = {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers':
            'ETag, X-Centrate-Signature, Idempotent-Replayed, Retry-After',
          Vary: 'Origin',
        };
      }
      if (req.method === 'OPTIONS') {
        if (origin === null) throw fail('origin_not_allowed', 'preflight without origin');
        const headers: Record<string, string> = {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, Idempotency-Key, If-None-Match',
          'Access-Control-Max-Age': '600',
        };
        if (req.headers['access-control-request-private-network'] === 'true') {
          headers['Access-Control-Allow-Private-Network'] = 'true';
        }
        send(ctx, 204, null, headers);
        return;
      }
      await route(ctx);
    } catch (error) {
      const e =
        error instanceof HttpError
          ? error
          : new HttpError(500, 'internal', error instanceof Error ? error.message : String(error));
      send(ctx, e.status, errorText(e.code, e.message, e.details), e.headers);
    } finally {
      log(`${record.method} ${req.url ?? ''} → ${record.status}`);
    }
  }

  async function listen(): Promise<void> {
    const next = createServer((req, res) => {
      void handle(req, res);
    });
    next.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject);
      next.listen(port, GUARDIAN_HOST, () => {
        next.off('error', reject);
        resolve();
      });
    });
    port = (next.address() as AddressInfo).port;
    server = next;
    stopped = false;
  }

  async function shutdown(): Promise<void> {
    const current = server;
    server = null;
    stopped = true;
    if (current === null) return;
    const closed = new Promise<void>((resolve) => current.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await closed;
  }

  function waitFor<T>(
    entries: readonly T[],
    waiters: Set<Waiter<T>>,
    match: (value: T) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const existing = entries.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        match,
        resolve: (value) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(value);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`mock guardian: no ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  }

  await listen();

  const guardian: MockGuardian = {
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://${GUARDIAN_HOST}:${port}`;
    },
    rulesPublicKey: keys.publicKey,
    appToken,
    get pairingCode() {
      return code !== null && now() < code.expiresAt ? code.value : null;
    },
    get extRulesVersion() {
      refresh();
      return version;
    },
    get balance() {
      return ledger.balance;
    },
    get stopped() {
      return stopped;
    },

    newPairingCode(value) {
      if (value !== undefined && !/^\d{6}$/.test(value)) throw new Error('a code is 6 digits');
      return setCode(value ?? randomCode()) ?? '';
    },
    extensions: () => [...extensions.values()].map((e) => ({ ...e })),
    revokeExtensions() {
      for (const ext of extensions.values()) ext.revoked = true;
      for (const wake of [...versionWaiters]) wake();
    },

    addBlock(input) {
      const at = now();
      const whitelistOnly = input.whitelistOnly ?? false;
      const resolved = resolveTargets(
        {
          serviceIds: input.services ?? [],
          categoryIds: input.categories ?? [],
          domains: input.domains ?? [],
        },
        'linux',
      );
      if (!whitelistOnly && resolved.domains.length === 0) {
        throw new Error('mock guardian: a block needs at least one valid target');
      }
      const serviceIds = unique([
        ...(input.services ?? []).filter((id) => getService(id) !== undefined),
        ...(input.categories ?? []).flatMap((id) => servicesInCategory(id).map((s) => s.id)),
      ]);
      const endsAt =
        input.endsAt === undefined
          ? at + (input.minutes ?? 25) * 60_000
          : typeof input.endsAt === 'number'
            ? input.endsAt
            : Date.parse(input.endsAt);
      if (!Number.isFinite(endsAt)) throw new Error('mock guardian: bad endsAt');
      const block: MockBlock = {
        id: newId('blk'),
        kind: input.kind ?? 'manual',
        mode: input.mode ?? (whitelistOnly ? 'exam' : 'strict'),
        reason: input.reason ?? DEFAULT_REASON,
        createdAt: at,
        endsAt,
        serviceIds: whitelistOnly ? [] : serviceIds,
        domains: whitelistOnly ? [] : resolved.domains,
        excludedDomains: whitelistOnly ? [] : resolved.excludedDomains,
        whitelistOnly,
        allowDomains: unique(
          (input.allowDomains ?? studyWhitelistDomains())
            .map((d) => normalizeDomain(d))
            .filter((d): d is string => d !== null),
        ),
        allowHostPatterns: unique(input.allowHostPatterns ?? studyWhitelistHostPatterns()),
      };
      blocks.set(block.id, block);
      refresh();
      return { ...block };
    },
    removeBlock(id) {
      const removed = blocks.delete(id);
      refresh();
      return removed;
    },
    clearBlocks() {
      blocks.clear();
      refresh();
    },
    blocks: () => [...blocks.values()].map((b) => ({ ...b })),
    addAllowance(serviceId, minutes = 15) {
      if (getService(serviceId) === undefined) {
        throw new Error(`mock guardian: unknown service ${serviceId}`);
      }
      const allowance: MockAllowance = { serviceId, endsAt: now() + minutes * 60_000 };
      allowances.set(serviceId, allowance);
      refresh();
      return { ...allowance };
    },
    removeAllowance(serviceId) {
      const removed = allowances.delete(serviceId);
      refresh();
      return removed;
    },
    setPunishment(value) {
      punishment =
        value === null ? null : { level: value.level, endsAt: now() + value.minutes * 60_000 };
      refresh();
    },
    setPenaltiesEnabled(enabled) {
      penaltiesEnabled = enabled;
      refresh();
    },
    addLimit(input) {
      const resolved = resolveTargets(
        { serviceIds: input.services ?? [], categoryIds: [], domains: input.domains ?? [] },
        'linux',
      );
      if (resolved.domains.length === 0) {
        throw new Error('mock guardian: a limit needs at least one valid target');
      }
      const serviceIds = unique((input.services ?? []).filter((id) => getService(id)));
      const limit: MockLimit = {
        id: newId('lim'),
        name: input.name ?? getService(serviceIds[0] ?? '')?.name ?? 'Límite',
        serviceIds,
        domains: resolved.domains,
        excludedDomains: resolved.excludedDomains,
        dailyMinutes: input.dailyMinutes,
        appliesToday: input.appliesToday ?? true,
        mode: input.mode ?? 'strict',
        reason: input.reason ?? '',
        usedMs: 0,
        creditedUntil: 0,
        credited: [],
        blockId: null,
      };
      limits.set(limit.id, limit);
      refresh();
      return { ...limit };
    },
    setLimitUsage(id, seconds) {
      const limit = limits.get(id);
      if (limit === undefined) throw new Error(`mock guardian: unknown limit ${id}`);
      limit.usedMs = seconds * 1_000;
      evaluateLimit(limit, now());
      return { ...limit };
    },
    limits: () => [...limits.values()].map((l) => ({ ...l })),

    rules: () => {
      refresh();
      return buildRules(now(), '');
    },
    requests: () => recorded.map((r) => ({ ...r })),
    heartbeats: () => [...heartbeatLog],
    attempts: () => [...attemptLog],
    usageReports: () => [...usageLog],

    waitForAttempt: (predicate = () => true, timeoutMs = 10_000) =>
      waitFor(attemptLog, attemptWaiters, predicate, timeoutMs, 'attempt'),
    waitForUsage: (predicate = () => true, timeoutMs = 10_000) =>
      waitFor(usageLog, usageWaiters, predicate, timeoutMs, 'usage report'),
    waitForHeartbeat: (predicate = () => true, timeoutMs = 10_000) =>
      waitFor(heartbeatLog, heartbeatWaiters, predicate, timeoutMs, 'heartbeat'),
    waitForApplied(target, timeoutMs = 15_000) {
      refresh();
      const wanted = target ?? version;
      return waitFor(
        heartbeatLog,
        heartbeatWaiters,
        (beat) => beat.body.appliedExtRulesVersion === wanted,
        timeoutMs,
        `heartbeat with appliedExtRulesVersion ${wanted}`,
      );
    },

    stop: shutdown,
    async start() {
      if (server !== null) return;
      await listen();
    },
    async close() {
      if (changeTimer !== null) clearTimeout(changeTimer);
      changeTimer = null;
      await shutdown();
    },
  };
  return guardian;
}
