/**
 * Guardian HTTP API contract (v1): endpoint paths, limits, error codes, request and
 * response types, strict hand-written runtime validators and a tiny typed client usable
 * from the Electron main process and from the MV3 extension.
 *
 * The full reference (auth, side effects, algorithms) is docs/ARCHITECTURE.md §7–§8.
 *
 * Validation modes:
 * - Requests are validated **strictly**: unknown fields are rejected (the guardian does
 *   the same, so a newer app must gate new request fields on `health.capabilities`).
 * - Responses are validated **openly**: unknown fields are ignored (the API evolves
 *   additively), but every known field must have the right type.
 *
 * Dependency-free: only the catalog helpers of this package and platform `fetch`,
 * `crypto.subtle`, `TextEncoder` and `atob`.
 */
import type { CatalogPlatform, CategoryId } from './catalog';
import {
  APPS,
  CATEGORIES,
  CATEGORY_IDS,
  SERVICES,
  findAppByProcessName,
  findServiceByDomain,
  findServiceByProcessName,
  isMultiLabelPublicSuffix,
  isProtectedProcessName,
  isSameOrSubdomain,
  isValidDomain,
  isValidProcessName,
  processNameKey,
} from './catalog';
import type {
  Achieved,
  AllowanceId,
  AttemptId,
  Block,
  BlockId,
  BlockKind,
  BlockMode,
  BrowserFamily,
  ClockJumpSource,
  ClockTrust,
  EmergencyCancelReason,
  EmergencyId,
  EmergencyUnlock,
  DailyLimit,
  DailyLimitDefinition,
  EpochId,
  EpochKeptState,
  EscalationState,
  EventDataMap,
  EventEnvelopeBase,
  EventType,
  ExtensionId,
  GuardianMode,
  GuardianSettings,
  HeartbeatState,
  IdKind,
  IsoUtc,
  IsoWeekday,
  LimitId,
  LimitMode,
  MalformedGuardianEvent,
  PendingLimitChange,
  PendingSettingChange,
  PendingSettingPath,
  PendingSettingValues,
  PointsSummary,
  PomodoroSpec,
  Punishment,
  PunishmentId,
  PunishmentLevel,
  PunishmentPolicy,
  RewardAllowance,
  RewardsLockReason,
  Schedule,
  ScheduleId,
  StrikeCause,
  StudyOutcome,
  StudySession,
  StudySessionId,
  TargetSpec,
  WhitelistAllow,
  WireEvent,
} from './domain';
import {
  ACHIEVED_VALUES,
  ALLOWANCE_STATUSES,
  ATTEMPT_LAYERS,
  BLOCK_KINDS,
  BLOCK_MODES,
  BLOCK_STATUSES,
  BROWSER_FAMILIES,
  CLOCK_JUMP_SOURCES,
  CLOCK_TRUST_LEVELS,
  EMERGENCY_CANCEL_REASONS,
  EMERGENCY_STATUSES,
  EMERGENCY_STATUS_REASONS,
  GUARDIAN_MODES,
  HEARTBEAT_STATES,
  ID_PREFIXES,
  LIMIT_MODES,
  PUNISHMENT_CAUSES,
  PUNISHMENT_LEVELS,
  PUNISHMENT_STATUSES,
  REWARDS_LOCK_REASONS,
  STRIKE_CAUSES,
  STUDY_OUTCOMES,
  STUDY_PHASES,
  STUDY_STATUSES,
  TAMPER_KINDS,
  isEventType,
  isIdOf,
} from './domain';
import { POINT_RULES, STUDY_RULES, isLocalDay } from './points';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/** Default guardian port (configurable in the admin-only `config.json`). */
export const DEFAULT_GUARDIAN_PORT = 47600;
/** The only address the guardian binds. */
export const GUARDIAN_HOST = '127.0.0.1';
export const GUARDIAN_API_VERSION = 1;
export const GUARDIAN_API_PREFIX = '/v1';
/** `name` reported by `/v1/health`. */
export const GUARDIAN_NAME = 'centrate-guardian';

/** `http://127.0.0.1:<port>` (never `localhost`: it may resolve to `::1`). */
export function guardianBaseUrl(port: number = DEFAULT_GUARDIAN_PORT): string {
  return `http://${GUARDIAN_HOST}:${port}`;
}

/** Chromium extension id pinned by the `key` in the extension manifest (DECISIONS.md). */
export const CHROMIUM_EXTENSION_ID = 'dlabilkpafinafimngfclcfmeghilcah';

/** App bearer tokens (from `<sysdir>/client.json`) start with this. */
export const APP_TOKEN_PREFIX = 'cta_';
/** Extension bearer tokens (from pairing) start with this. */
export const EXT_TOKEN_PREFIX = 'cte_';

export const GUARDIAN_HEADERS = {
  authorization: 'Authorization',
  contentType: 'Content-Type',
  idempotencyKey: 'Idempotency-Key',
  ifNoneMatch: 'If-None-Match',
  etag: 'ETag',
  signature: 'X-Centrate-Signature',
  replayed: 'Idempotent-Replayed',
  retryAfter: 'Retry-After',
} as const;

/** Words accepted by `POST /v1/data/delete` (trimmed, case-insensitive). */
export const DATA_DELETE_CONFIRM_WORDS: readonly string[] = Object.freeze(['BORRAR', 'DELETE']);

/**
 * Limits shared by the app (confirmation card, forms) and the guardian (validation). The
 * guardian embeds `apiContractSnapshot()`, so both always use the same numbers.
 *
 * Every text length (`reasonMaxLength`, `taskMaxLength`, `scheduleNameMaxLength`,
 * `phraseMaxLength`, …) counts **UTF-16 code units** (JavaScript `.length`), not bytes or
 * runes: Go computes it as `utf16Len(s) = Σ over runes (r ≥ 0x10000 ? 2 : 1)` (see
 * `textLength`). 139 BMP characters plus one emoji is 141 units.
 */
export const GUARDIAN_LIMITS = Object.freeze({
  /** A block lasts 5 min … 24 h. */
  blockMinMinutes: 5,
  /**
   * One rule for create and extend: the remaining time of a block (endsAt − now) can never
   * exceed 24 h. Extending a block that ends in 23 h accepts at most +60 min.
   */
  blockMaxMinutes: 1440,
  /** Longer blocks need `acknowledgeLong` (the double confirmation of PROMPT §4). */
  longBlockConfirmMinutes: 240,
  /** `addMinutes` of one extension: 1 … 1440 (then capped by `blockMaxMinutes`). */
  extendMaxAddMinutes: 1440,
  reasonMaxLength: 140,
  taskMaxLength: 80,
  scheduleNameMaxLength: 60,
  maxSchedules: 50,
  /** Weakening edits are refused this close to a schedule's next start. */
  scheduleFreezeMinutes: 10,
  maxIdsPerList: 64,
  maxCustomDomains: 200,
  maxCustomProcesses: 50,
  maxWhitelistExtraDomains: 100,
  maxWhitelistExtraProcesses: 50,
  /**
   * Active blocks of any kind. A client create beyond it gets 422 `too_many_targets`;
   * guardian-created blocks (punishments, schedule occurrences) are never refused.
   */
  maxActiveBlocks: 32,
  /**
   * Hosts entries from custom domains (after `www.`/apex expansion) across active user
   * blocks (`manual`); a create beyond it gets 422 `too_many_targets`.
   */
  maxActiveCustomHosts: 1_000,
  /** The same budget across enabled schedules, checked on schedule create and update. */
  maxScheduleCustomHosts: 1_000,
  /**
   * Hard cap of the hosts section. With the limits above it is never reached; if it were,
   * entries are dropped by priority (punishment > exam > hardcore > strict > normal,
   * catalog before custom, older blocks first), never alphabetically.
   */
  hostsMaxDomains: 20_000,
  /** One service's allowance can be extended up to this many minutes in total. */
  allowanceMaxMinutes: 60,
  /** Weakening settings changes become effective after this delay. */
  settingsWeakeningDelayMs: 24 * 3_600_000,
  maxBodyBytes: 65_536,
  /** The desktop polls `/v1/state` this often while its window is visible. */
  statePollIntervalMs: 2_000,
  /** Default client timeout («si no responde en 3 s»). */
  requestTimeoutMs: 3_000,
  longPollMaxMs: 25_000,
  eventsPageDefault: 500,
  eventsPageMax: 1_000,
  /**
   * Largest atomic batch (a calibration that reactivates `unverifiedCompletionsMax`
   * blocks). A page of `/v1/events` never splits a batch.
   */
  maxBatchEvents: 256,
  blocksPageMax: 100,
  heartbeatMaxFocusMs: 600_000,
  /** «¿Sigues ahí?» warnings one heartbeat (or the end request) may report. */
  heartbeatMaxWarnings: 100,
  idempotencyTtlMs: 600_000,
  idempotencyKeyMaxLength: 128,
  /** Idempotency records kept (with their stored responses, persisted across restarts). */
  idempotencyMaxEntries: 256,
  /** Completions kept for resurrection until a network time check (§10.2). */
  unverifiedCompletionsMax: 200,
  pairingCodeTtlMs: 300_000,
  pairingMaxFailures: 5,
  pairingClaimsPerWindow: 20,
  pairingClaimWindowMs: 600_000,
  extRulesAlarmMs: 30_000,
  extHeartbeatIntervalMs: 30_000,
  /** An extension is "connected" if it sent a heartbeat within this window. */
  extConnectedWindowMs: 90_000,
  /** An extension still counts as protecting this long after the rules changed. */
  extRulesCurrentGraceMs: 60_000,
  /** A browser running this long without a connected extension is reported (or closed). */
  browserWithoutExtensionGraceMs: 60_000,
  /** `/v1/state.recent.endedBlocks` keeps blocks that ended within this window. */
  recentEndedBlocksMs: 120_000,
  /** `/v1/state.recent.endedStudy` keeps the last session this long after it ended. */
  recentEndedStudyMs: 120_000,
  /** `GET /v1/study/sessions/{id}` serves sessions that ended within this window. */
  studyHistoryMs: 7 * 24 * 3_600_000,
  emergencyMaxBlocks: 50,
  phraseMaxLength: 400,
  /** The app sends a Nuclear heartbeat this often while the overlay is shown. */
  nuclearHeartbeatIntervalMs: 3_000,
  /** Without a Nuclear heartbeat for this long, the guardian relaunches the app. */
  nuclearLivenessMs: 10_000,
  /** Daily limits (§5.10): at most this many exist at once (422 `validation_failed`). */
  maxLimits: 50,
  limitNameMaxLength: 60,
  /** `dailyMinutes` of a limit: 5 min … 12 h. */
  limitMinMinutes: 5,
  limitMaxMinutes: 720,
  /**
   * Hosts entries from custom domains (after `www.`/apex expansion) across **enabled**
   * limits, checked on limit create and update (422 `too_many_targets`, `details.kind:
   * "limit_custom_hosts"`).
   */
  maxLimitCustomHosts: 1_000,
  /** `limit_warning` once per limit and day when 0 < remaining ≤ this (5 min). */
  limitWarningSeconds: 300,
  /** Weakening limit changes (and deletions) wait this long, like settings. */
  limitWeakeningDelayMs: 24 * 3_600_000,
  /**
   * Limit blocks one limit may materialize per local day (the first one plus the ones a
   * later strengthening edit adds); beyond it an edit applies from the next day.
   */
  limitMaxBlocksPerDay: 4,
  /** A limit block is not created when less than this is left before local midnight. */
  limitMinBlockMs: 60_000,
  /** Clients send `POST /v1/usage` this often while they have unreported seconds. */
  usageReportIntervalMs: 30_000,
  /**
   * …and this often while a limit they count toward applies today and has less than
   * `usageReportIntervalMs` of allowance left (from their last usage response), so the
   * block arrives within seconds of the allowance running out.
   */
  usageFastReportIntervalMs: 5_000,
  /**
   * Largest `intervalMs` of one usage report; a client that could not report for longer
   * drops the older seconds.
   */
  usageMaxIntervalMs: 120_000,
  usageMaxItems: 32,
  /**
   * Tolerance of the guardian's usage clamps (the per-client elapsed-time clamp and the
   * per-limit watermark), so network and timer jitter never lose seconds.
   */
  usageSlackMs: 2_000,
  /** Clients stop counting usage after this long without keyboard or mouse input. */
  usageIdleSeconds: 60,
});

/**
 * Size caps of the response validators. They are deliberately far above anything the
 * guardian may emit under `GUARDIAN_LIMITS` (a test checks it): one oversized list must
 * never make a whole response invalid.
 */
export const RESPONSE_LIMITS = Object.freeze({
  domains: 100_000,
  processes: 10_000,
  ids: 10_000,
  blocks: 10_000,
  punishments: 1_000,
  allowances: 1_000,
  schedules: 1_000,
  limits: 1_000,
});

/** Features a guardian build supports; clients gate optional request fields on them. */
export const GUARDIAN_CAPABILITIES = [
  'blocks',
  'schedules',
  'study',
  'attempts',
  'emergency',
  'rewards',
  'settings',
  'pairing',
  'ext_rules_signed',
  'events_longpoll',
  'data_delete',
  'study_history',
  'nuclear_heartbeat',
  'daily_limits',
] as const;
export type GuardianCapability = (typeof GUARDIAN_CAPABILITIES)[number];

/**
 * Capability reported only by builds with the `testhooks` tag (they serve
 * `POST /v1/_test/clock`). A release must never report it; the release workflow checks it.
 */
export const GUARDIAN_TEST_CAPABILITY = 'testhooks';

/** Problem codes in `/v1/health` and `/v1/state` (codes only, no personal data). */
export const GUARDIAN_PROBLEMS = [
  'hosts_write_failed',
  'hosts_contested',
  'hosts_unwritable',
  'hosts_locked',
  'hosts_path_overridden',
  'process_watcher_failed',
  'schema_too_new',
  'safe_mode',
  'ledger_repaired',
  'rollback_detected',
  'disk_full',
  'clock_unverified',
] as const;
export type GuardianProblem = (typeof GUARDIAN_PROBLEMS)[number];

// ---------------------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------------------

function seg(id: string): string {
  return encodeURIComponent(id);
}

/** Paths of every endpoint. Functions encode the id segment. */
export const GUARDIAN_PATHS = {
  health: '/v1/health',
  state: '/v1/state',
  diagnostics: '/v1/diagnostics',
  blocks: '/v1/blocks',
  block: (id: BlockId) => `/v1/blocks/${seg(id)}`,
  blockExtend: (id: BlockId) => `/v1/blocks/${seg(id)}/extend`,
  schedules: '/v1/schedules',
  schedule: (id: ScheduleId) => `/v1/schedules/${seg(id)}`,
  limits: '/v1/limits',
  limit: (id: LimitId) => `/v1/limits/${seg(id)}`,
  usage: '/v1/usage',
  studySessions: '/v1/study/sessions',
  studyCurrent: '/v1/study/sessions/current',
  studySession: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}`,
  studyHeartbeat: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/heartbeat`,
  studyStrike: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/strike`,
  studyPause: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/pause`,
  studyResume: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/resume`,
  studyEnd: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/end`,
  studyOutcome: (id: StudySessionId) => `/v1/study/sessions/${seg(id)}/outcome`,
  attempts: '/v1/attempts',
  points: '/v1/points',
  events: '/v1/events',
  emergencyPreview: '/v1/emergency/preview',
  emergency: '/v1/emergency',
  emergencyCancel: (id: EmergencyId) => `/v1/emergency/${seg(id)}/cancel`,
  emergencyConfirm: (id: EmergencyId) => `/v1/emergency/${seg(id)}/confirm`,
  rewards: '/v1/rewards',
  rewardsRedeem: '/v1/rewards/redeem',
  settings: '/v1/settings',
  pairingCode: '/v1/pairing/code',
  pairingClaim: '/v1/pairing/claim',
  pairingExtensions: '/v1/pairing/extensions',
  pairingExtension: (id: ExtensionId) => `/v1/pairing/extensions/${seg(id)}`,
  extRules: '/v1/ext/rules',
  extHeartbeat: '/v1/ext/heartbeat',
  nuclearHeartbeat: '/v1/nuclear/heartbeat',
  dataDelete: '/v1/data/delete',
  /** Only in builds with the `testhooks` tag. */
  testClock: '/v1/_test/clock',
} as const;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * - `none`: no token (health; the claim is gated by the pairing code).
 * - `app`: the app token from `client.json`, requests without an `Origin` header.
 * - `ext`: a paired extension token.
 * - `app_or_ext`: either (scope rules apply, e.g. attempts).
 */
export type EndpointAuth = 'none' | 'app' | 'ext' | 'app_or_ext';

export interface EndpointSpec {
  id: string;
  method: HttpMethod;
  /** Path template; `{id}` is an id segment. */
  path: string;
  auth: EndpointAuth;
  /** Accepts `Idempotency-Key` (replays return the stored response). */
  idempotencyKey: boolean;
  /** Supports `waitMs` long polling. */
  longPoll: boolean;
  /** Only compiled with the `testhooks` build tag. */
  testOnly: boolean;
}

function ep(
  id: string,
  method: HttpMethod,
  path: string,
  auth: EndpointAuth,
  flags: { idem?: boolean; longPoll?: boolean; testOnly?: boolean } = {},
): EndpointSpec {
  return {
    id,
    method,
    path,
    auth,
    idempotencyKey: flags.idem ?? false,
    longPoll: flags.longPoll ?? false,
    testOnly: flags.testOnly ?? false,
  };
}

/**
 * The complete route table. There is deliberately no route that ends, shortens, edits or
 * deletes a block: `/v1/blocks` only has create, read and extend.
 */
export const GUARDIAN_ENDPOINTS: readonly EndpointSpec[] = Object.freeze([
  ep('health', 'GET', '/v1/health', 'none'),
  ep('getState', 'GET', '/v1/state', 'app'),
  ep('diagnostics', 'GET', '/v1/diagnostics', 'app'),
  ep('createBlock', 'POST', '/v1/blocks', 'app', { idem: true }),
  ep('listBlocks', 'GET', '/v1/blocks', 'app'),
  ep('getBlock', 'GET', '/v1/blocks/{id}', 'app'),
  ep('extendBlock', 'POST', '/v1/blocks/{id}/extend', 'app', { idem: true }),
  ep('listSchedules', 'GET', '/v1/schedules', 'app'),
  ep('createSchedule', 'POST', '/v1/schedules', 'app', { idem: true }),
  ep('updateSchedule', 'PUT', '/v1/schedules/{id}', 'app'),
  ep('deleteSchedule', 'DELETE', '/v1/schedules/{id}', 'app'),
  ep('listLimits', 'GET', '/v1/limits', 'app'),
  ep('createLimit', 'POST', '/v1/limits', 'app', { idem: true }),
  ep('updateLimit', 'PUT', '/v1/limits/{id}', 'app'),
  ep('deleteLimit', 'DELETE', '/v1/limits/{id}', 'app'),
  ep('reportUsage', 'POST', '/v1/usage', 'app_or_ext'),
  ep('startStudy', 'POST', '/v1/study/sessions', 'app', { idem: true }),
  ep('currentStudy', 'GET', '/v1/study/sessions/current', 'app'),
  ep('getStudySession', 'GET', '/v1/study/sessions/{id}', 'app'),
  ep('studyHeartbeat', 'POST', '/v1/study/sessions/{id}/heartbeat', 'app'),
  ep('studyStrike', 'POST', '/v1/study/sessions/{id}/strike', 'app', { idem: true }),
  ep('pauseStudy', 'POST', '/v1/study/sessions/{id}/pause', 'app'),
  ep('resumeStudy', 'POST', '/v1/study/sessions/{id}/resume', 'app'),
  ep('endStudy', 'POST', '/v1/study/sessions/{id}/end', 'app', { idem: true }),
  ep('setStudyOutcome', 'POST', '/v1/study/sessions/{id}/outcome', 'app'),
  ep('reportAttempt', 'POST', '/v1/attempts', 'app_or_ext'),
  ep('getPoints', 'GET', '/v1/points', 'app'),
  ep('getEvents', 'GET', '/v1/events', 'app', { longPoll: true }),
  ep('emergencyPreview', 'GET', '/v1/emergency/preview', 'app'),
  ep('requestEmergency', 'POST', '/v1/emergency', 'app', { idem: true }),
  ep('cancelEmergency', 'POST', '/v1/emergency/{id}/cancel', 'app'),
  ep('confirmEmergency', 'POST', '/v1/emergency/{id}/confirm', 'app', { idem: true }),
  ep('listRewards', 'GET', '/v1/rewards', 'app'),
  ep('redeemReward', 'POST', '/v1/rewards/redeem', 'app', { idem: true }),
  ep('getSettings', 'GET', '/v1/settings', 'app'),
  ep('updateSettings', 'PUT', '/v1/settings', 'app'),
  ep('createPairingCode', 'POST', '/v1/pairing/code', 'app'),
  ep('claimPairing', 'POST', '/v1/pairing/claim', 'none'),
  ep('listExtensions', 'GET', '/v1/pairing/extensions', 'app'),
  ep('revokeExtension', 'DELETE', '/v1/pairing/extensions/{id}', 'app'),
  ep('getExtRules', 'GET', '/v1/ext/rules', 'ext', { longPoll: true }),
  ep('extHeartbeat', 'POST', '/v1/ext/heartbeat', 'ext'),
  ep('nuclearHeartbeat', 'POST', '/v1/nuclear/heartbeat', 'app'),
  ep('deleteData', 'POST', '/v1/data/delete', 'app', { idem: true }),
  ep('testClock', 'POST', '/v1/_test/clock', 'app', { testOnly: true }),
]);

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** Every error code with its HTTP status. The guardian embeds this table. */
export const GUARDIAN_ERROR_STATUS = Object.freeze({
  invalid_json: 400,
  unknown_field: 400,
  bad_query: 400,
  unauthorized: 401,
  pairing_code_invalid: 401,
  host_not_allowed: 403,
  origin_not_allowed: 403,
  insufficient_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  block_not_active: 409,
  not_extendable: 409,
  schedule_in_progress: 409,
  schedule_starting_soon: 409,
  study_already_active: 409,
  study_not_active: 409,
  already_paused: 409,
  not_paused: 409,
  pause_quota_exhausted: 409,
  outcome_already_set: 409,
  outcome_window_closed: 409,
  emergency_not_available: 409,
  emergency_in_progress: 409,
  emergency_not_ready: 409,
  emergency_expired: 409,
  emergency_moot: 409,
  rewards_locked: 409,
  service_not_blocked: 409,
  insufficient_points: 409,
  allowance_limit_reached: 409,
  data_delete_blocked: 409,
  pairing_no_code: 409,
  idempotency_conflict: 409,
  pairing_code_expired: 410,
  body_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  duration_out_of_range: 422,
  extension_exceeds_max: 422,
  confirmation_required: 422,
  phrase_mismatch: 422,
  confirm_word_mismatch: 422,
  unknown_id: 422,
  protected_target: 422,
  allow_distraction: 422,
  too_many_targets: 422,
  invalid_timezone: 422,
  unknown_offer: 422,
  rate_limited: 429,
  internal: 500,
  read_only: 503,
} as const);

export type GuardianErrorCode = keyof typeof GUARDIAN_ERROR_STATUS;
export const GUARDIAN_ERROR_CODES = Object.freeze(
  Object.keys(GUARDIAN_ERROR_STATUS) as GuardianErrorCode[],
);

/**
 * Errors produced by the client itself (no HTTP response, or an unusable one).
 * `stale_rules`: signed extension rules older than the version already applied.
 */
export type GuardianClientErrorCode =
  'unreachable' | 'timeout' | 'invalid_response' | 'invalid_signature' | 'stale_rules';

/** Body of every non-2xx response. `details` is code-specific (see ARCHITECTURE.md). */
export interface GuardianErrorBody {
  error: {
    /** A `GuardianErrorCode`; typed as string because newer guardians may add codes. */
    code: string;
    /** English, for developers and logs; never shown to users. */
    message: string;
    details: Record<string, unknown> | null;
  };
}

/** Thrown by the client for error responses and transport failures. */
export class GuardianApiError extends Error {
  /** HTTP status, or 0 when there was no response. */
  readonly status: number;
  readonly code: GuardianErrorCode | GuardianClientErrorCode | (string & {});
  readonly details: Record<string, unknown> | null;

  constructor(
    status: number,
    code: GuardianErrorCode | GuardianClientErrorCode | (string & {}),
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'GuardianApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------------------
// Request and response types
// ---------------------------------------------------------------------------------------

export type EmptyRequest = Record<string, never>;

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  apiVersion: number;
  /** `GuardianCapability` values; unknown ones may appear. */
  capabilities: string[];
  schemaVersion: number;
  catalogVersion: number;
  /** Points rules version (`RULES_VERSION` in points.ts), not the extension rules counter. */
  rulesVersion: number;
  startedAt: IsoUtc;
  serverNow: IsoUtc;
  mode: GuardianMode;
  /** `GuardianProblem` codes; unknown ones may appear. */
  problems: string[];
}

export interface ClockStatus {
  /** Display time = trusted time + wallOffsetMs. */
  wallOffsetMs: number;
  trust: ClockTrust;
  lastJump: { at: IsoUtc; deltaMs: number; source: ClockJumpSource } | null;
  lastCalibratedAt: IsoUtc | null;
  /**
   * After a reboot, blocks whose end passed while the machine was off stay enforced until
   * the first time check answers or this instant (at most 120 s after boot). The UI shows
   * «Comprobando la hora…» instead of 0:00 meanwhile. `null` when no hold is active.
   */
  bootHoldUntil: IsoUtc | null;
}

export const HOSTS_STATUSES = [
  'ok',
  'contested',
  'unwritable',
  'locked',
  'io_error',
  'path_overridden',
] as const;
export type HostsStatus = (typeof HOSTS_STATUSES)[number];

export interface ExtensionStatus {
  id: ExtensionId;
  /** Family bound at pairing; heartbeats with another `browser` are refused. */
  browser: BrowserFamily;
  extVersion: string;
  /** A heartbeat arrived within `extConnectedWindowMs`. */
  connected: boolean;
  lastSeenAt: IsoUtc | null;
  incognitoAllowed: boolean;
  hostPermission: boolean;
  appliedExtRulesVersion: number;
  /**
   * The family counts as protected: connected, `hostPermission`, the current
   * `extRulesVersion` applied (or changed < `extRulesCurrentGraceMs` ago) and incognito
   * allowed (or disabled by browser policy). Only protected families spare a browser from
   * `closeBrowsersWithoutExtension`.
   */
  protecting: boolean;
}

export interface ProtectionStatus {
  hosts: { ok: boolean; status: HostsStatus; entries: number; lastAppliedAt: IsoUtc | null };
  processWatcher: { ok: boolean };
  extensions: ExtensionStatus[];
  /** Browser families running for > 60 s without a connected extension. */
  browsersWithoutExtension: BrowserFamily[];
}

/** For «Hecho. +80 puntos»: blocks that ended in the last 2 min. */
export interface EndedBlockNotice {
  id: BlockId;
  kind: BlockKind;
  mode: BlockMode;
  outcome: 'completed' | 'cancelled_emergency';
  endedAt: IsoUtc;
  pointsDelta: number;
}

export interface NextScheduleInfo {
  scheduleId: ScheduleId;
  name: string;
  startsAt: IsoUtc;
  endsAt: IsoUtc;
}

/**
 * `GET /v1/state`: everything the main window and the tray need, in one call. Supports
 * `If-None-Match: "s-<stateVersion>"` → 304. All timestamps are display time.
 */
export interface GuardianStateResponse {
  stateVersion: number;
  serverNow: IsoUtc;
  epoch: EpochId;
  lastEventSeq: number;
  guardian: { version: string; apiVersion: number; mode: GuardianMode; problems: string[] };
  clock: ClockStatus;
  protection: ProtectionStatus;
  /** Active blocks (punishment blocks included), sorted by `endsAt` descending. */
  blocks: Block[];
  /** Active punishments (they stack), sorted by `endsAt` descending. */
  punishments: Punishment[];
  /** True while any active punishment has level `nuclear`. */
  nuclearActive: boolean;
  study: StudySession | null;
  /** A `counting` or `ready` emergency, if any. */
  emergency: EmergencyUnlock | null;
  /** Active allowances. */
  allowances: RewardAllowance[];
  rewardsLock: RewardsLockReason | null;
  nextSchedule: NextScheduleInfo | null;
  /**
   * Every daily limit, in creation order, with `usedTodaySeconds` floored to whole minutes
   * (and `remainingTodaySeconds` derived from it) so the ETag changes at most once a minute
   * per limit; `GET /v1/limits` and `POST /v1/usage` carry exact seconds. Guardians
   * without the `daily_limits` capability omit it (read it as `[]`).
   */
  limits?: DailyLimit[];
  points: PointsSummary;
  pendingSettings: PendingSettingChange[];
  recent: {
    endedBlocks: EndedBlockNotice[];
    /**
     * The last study session if it ended within `recentEndedStudyMs` (also when the
     * guardian ended it: completion, abandonment, third strike, reboot), for «Resumen».
     */
    endedStudy: StudySessionDetail | null;
  };
}

/** `GET /v1/diagnostics` («Copiar diagnóstico»): no domains, reasons, tasks or usernames. */
export interface DiagnosticsResponse {
  guardian: {
    version: string;
    commit: string;
    goVersion: string;
    os: string;
    arch: string;
    serviceManager: string;
    pid: number;
    port: number;
    startedAt: IsoUtc;
    uptimeMs: number;
    mode: GuardianMode;
  };
  state: {
    schemaVersion: number;
    epoch: EpochId;
    lastEventSeq: number;
    integrity: 'ok' | 'repaired' | 'rollback' | 'rebuilt';
    stateBytes: number;
    eventsBytes: number;
  };
  clock: {
    wallOffsetMs: number;
    trust: ClockTrust;
    bootClock: string;
    awakeClock: string;
    jumps24h: number;
    lastCalibration: { at: IsoUtc; ok: boolean; deltaMs: number; sources: number } | null;
  };
  hosts: {
    /**
     * The default path, or the `DataBasePath` override with any user-profile prefix
     * replaced by `%USERPROFILE%` (`~` on POSIX): diagnostics never carry a username.
     */
    path: string;
    pathOverridden: boolean;
    status: HostsStatus;
    entries: number;
    lastWriteAt: IsoUtc | null;
    lastVerifyAt: IsoUtc | null;
    tamper24h: number;
    lastFlush: { at: IsoUtc; ok: boolean; method: string } | null;
  };
  processWatcher: { intervalMs: number; lastScanMs: number; kills24h: number };
  extensions: ExtensionStatus[];
  catalogVersion: number;
  /** Points rules version. */
  rulesVersion: number;
  errors: Array<{ code: string; count: number; lastAt: IsoUtc }>;
}

export interface CreateBlockRequest {
  /** Must be all-empty when `whitelistOnly`; at least one entry otherwise. */
  targets: TargetSpec;
  /** Required `true` for mode `exam`. */
  whitelistOnly: boolean;
  /** Must be empty unless `whitelistOnly`. */
  allow: WhitelistAllow;
  mode: BlockMode;
  /** Exactly one of `durationMinutes` and `endsAt` is non-null. */
  durationMinutes: number | null;
  /** «hasta las 20:30», in display time (the guardian converts it to trusted time). */
  endsAt: IsoUtc | null;
  reason: string;
  /** Required `true` when the duration exceeds `longBlockConfirmMinutes`. */
  acknowledgeLong: boolean;
  /** Required `true` for hardcore and exam. */
  acknowledgeNoEmergency: boolean;
}

export interface CreateBlockResponse {
  block: Block;
  stateVersion: number;
}

export interface ListBlocksQuery {
  /** Default `active`. */
  status?: 'active' | 'ended';
  /**
   * For `ended`: the opaque `nextCursor` of the previous page. Pages are ordered by
   * (trusted `endedAt` desc, id desc), so blocks sharing an `endedAt` are never skipped
   * or repeated, and clock changes between pages do not matter.
   */
  cursor?: string;
  limit?: number;
}

export interface ListBlocksResponse {
  blocks: Block[];
  /** `null` on the last page. */
  nextCursor: string | null;
}

export interface BlockProgress {
  creditedMinutes: number;
  downtimeMs: number;
}

export interface GetBlockResponse {
  block: Block;
  progress: BlockProgress;
}

export interface ExtendBlockRequest {
  addMinutes: number;
}

export interface ExtendBlockResponse {
  block: Block;
  stateVersion: number;
}

export interface ScheduleInput {
  name: string;
  enabled: boolean;
  days: IsoWeekday[];
  start: string;
  end: string;
  timezone: string;
  targets: TargetSpec;
  whitelistOnly: boolean;
  allow: WhitelistAllow;
  mode: BlockMode;
  reason: string;
  acknowledgeNoEmergency: boolean;
}

export interface ScheduleResponse {
  schedule: Schedule;
}

export interface ListSchedulesResponse {
  schedules: Schedule[];
}

/**
 * `POST /v1/limits` and `PUT /v1/limits/{id}` (full replace). On `PUT` the guardian applies
 * the strengthening part at once and turns the rest into `pendingChange` (§5.10,
 * `splitLimitChange`).
 */
export interface DailyLimitInput extends DailyLimitDefinition {
  /** Required `true` for mode `hardcore` (422 `confirmation_required` otherwise). */
  acknowledgeNoEmergency: boolean;
}

export interface LimitResponse {
  limit: DailyLimit;
}

export interface ListLimitsResponse {
  limits: DailyLimit[];
}

/**
 * One usage figure: seconds the target was in use during the report's interval.
 * - `domain`: extension tokens only; a canonical host of the focused window's active tab
 *   that matches some `ExtRulesResponse.limits[].domains` entry (never any other host).
 * - `process`: app token only; the foreground executable's base name (any valid name).
 */
export interface UsageItem {
  type: 'domain' | 'process';
  value: string;
  /** 1 … ceil(intervalMs / 1000). */
  seconds: number;
}

/**
 * `POST /v1/usage` (ext or app token). The guardian never trusts it beyond real time: it
 * clamps the interval to the elapsed time since that client's previous accepted report
 * and credits each trusted millisecond at most once per limit (`limitUsageCredit`).
 */
export interface UsageReportRequest {
  /**
   * Length of the interval the items cover, measured with the client's monotonic clock:
   * 1 000 … `usageMaxIntervalMs`.
   */
  intervalMs: number;
  /** Unique (`type`, `value`) pairs, at most `usageMaxItems`; may be empty. */
  items: UsageItem[];
}

/** Today's usage of one enabled limit, exact to the second. */
export interface LimitUsageStatus {
  limitId: LimitId;
  usedTodaySeconds: number;
  remainingTodaySeconds: number;
  appliesToday: boolean;
  /** Seconds this report added to the limit (after every clamp). */
  creditedSeconds: number;
  /** End of today's active limit block (display time), `null` when none is active. */
  blockedUntil: IsoUtc | null;
}

export interface UsageReportResponse {
  /** The guardian's current local day. */
  day: string;
  /** Every enabled limit, in creation order. */
  limits: LimitUsageStatus[];
  serverNow: IsoUtc;
}

export interface StartStudyRequest {
  task: string;
  plannedMinutes: number;
  pomodoro: PomodoroSpec | null;
  camera: boolean;
}

export interface StudySessionResponse {
  session: StudySession;
}

export interface CurrentStudyResponse {
  session: StudySession | null;
}

export interface HeartbeatRequest {
  /** Strictly increasing per session; a repeated or older `seq` is a no-op. */
  seq: number;
  state: HeartbeatState;
  focusScore: number | null;
  /** Focused milliseconds the app measured since its previous heartbeat. */
  focusedMsSinceLast: number;
  /** «¿Sigues ahí?» warnings shown since the previous heartbeat (0–100). */
  warningsSinceLast: number;
  cameraOn: boolean;
}

export interface HeartbeatResponse {
  duplicate: boolean;
  /**
   * min(focusedMsSinceLast, unclaimed work-phase awake time). The accepted amount is
   * subtracted from the unclaimed time (capped at 10 min), not reset, so tick phase never
   * loses credit.
   */
  acceptedFocusMs: number;
  session: StudySession;
  serverNow: IsoUtc;
  /** Silence (awake) after which the session counts as abandoned. */
  heartbeatDeadlineMs: number;
}

export interface StrikeRequest {
  cause: StrikeCause;
}

export interface StrikeResponse {
  counted: boolean;
  reason: 'cooldown' | 'not_in_work_phase' | null;
  strikeNumber: number;
  /**
   * Penalties of this strike: −15, or −115 on the punishing strike (strike + punishment).
   * Other deltas of the same batch (focus flush, allowance refunds) are not included.
   */
  pointsDelta: number;
  /** 0, or −100 when this strike started the punishment. */
  punishmentPointsDelta: number;
  cooldownUntil: IsoUtc | null;
  /** Set when this strike triggered the punishment (3rd strike). */
  punishment: Punishment | null;
  session: StudySession;
}

export interface EndStudyRequest {
  reason: 'user';
  /** Focus since the last heartbeat, accepted like a heartbeat's (closes the interval). */
  focusedMsSinceLast: number;
  /** «¿Sigues ahí?» warnings since the last heartbeat. */
  warningsSinceLast: number;
}

/** «Resumen»: the numbers the guardian also logs in `study_ended`. */
export interface StudySummary {
  outcome: StudyOutcome;
  activeMinutes: number;
  /** Active minutes in `work` phases. */
  workMinutes: number;
  focusedMinutes: number;
  /** round(100 × focusedMinutes / workMinutes), 0 when there was no work time. */
  focusPct: number;
  strikes: number;
  warnings: number;
  attempts: number;
  /**
   * Net points of the session: the recorded points of every event whose data carries
   * this session (focus minutes, strikes, the clean bonus, the punishment) plus the
   * attempts counted while it was active. Allowance refunds are not included.
   */
  pointsTotal: number;
  cleanBonus: number;
}

/**
 * `POST …/end` response. Ending a session that already ended (the guardian may have
 * ended it first) returns 200 with its stored summary.
 */
export interface EndStudyResponse {
  session: StudySession;
  summary: StudySummary;
}

/** One session; `summary` is `null` while it is still active. */
export interface StudySessionDetail {
  session: StudySession;
  summary: StudySummary | null;
}

/** `GET /v1/study/sessions/{id}`: the current session or one that ended ≤ 7 days ago. */
export type StudySessionDetailResponse = StudySessionDetail;

export interface StudyOutcomeRequest {
  achieved: Achieved;
}

export type AttemptTarget = { type: 'domain'; value: string } | { type: 'service'; value: string };

export interface AttemptRequest {
  /** The ext token may only send `extension` + `domain`; the app token `window` + `service`. */
  layer: 'extension' | 'window';
  target: AttemptTarget;
  browser: BrowserFamily | null;
  incognito: boolean;
}

export interface AttemptResponse {
  /** The target is covered by an active block right now. */
  blocked: boolean;
  /** A new attempt was counted (and charged if penalties are on). */
  counted: boolean;
  /** Merged into a detection of the same target less than 30 s earlier. */
  merged: boolean;
  /** The counted attempt, or the one this detection merged into (if still known). */
  attemptId: AttemptId | null;
  /** Points charged by this call (≤ 0). */
  pointsDelta: number;
  /** Points charged by the attempt this call counted or merged into (for blocked.html). */
  episodePointsDelta: number;
  escalationIndex: number | null;
  /** What a new attempt would cost right now (positive). */
  nextPenalty: number;
  serviceId: string | null;
  /**
   * The covering block with the latest `endsAt` (ties: the most recently created), since
   * that is when access actually returns; blocked.html shows its `endsAt` and `reason`.
   */
  block: {
    id: BlockId;
    /** Extension tokens get `manual` for a limit block (§8.4) and read `limitId`. */
    kind: BlockKind;
    mode: BlockMode;
    endsAt: IsoUtc;
    reason: string;
    /** Set for a limit block; absent from guardians without `daily_limits`. */
    limitId?: LimitId | null;
  } | null;
  reason: 'not_blocked' | 'allowance_active' | null;
}

export interface PointsResponse {
  points: PointsSummary;
}

export interface EventsQuery {
  /** Omitted or different from the current epoch → `reset: true` from the epoch start. */
  epoch?: EpochId;
  after?: number;
  limit?: number;
  waitMs?: number;
}

/**
 * `GET /v1/events`. Event timestamps are trusted time (never converted; display time is
 * `value + wallOffsetMs`).
 */
export interface EventsResponse {
  epoch: EpochId;
  reset: boolean;
  /**
   * Ordered by `seq`. A page never splits a batch: it ends on a `txEnd: true` line and
   * holds at most `limit` events, unless its first batch alone is longer (then exactly
   * that batch, ≤ `maxBatchEvents`).
   */
  events: WireEvent[];
  /**
   * The app's cursor: the `seq` of the last returned event; when `events` is empty, the
   * request's `after` (0 on `reset`).
   */
  lastSeq: number;
  /** An event with `seq > lastSeq` already exists in this epoch. */
  hasMore: boolean;
}

export interface EmergencyPreviewResponse {
  eligible: boolean;
  reason: 'hardcore' | 'exam' | 'no_active_blocks' | 'emergency_in_progress' | null;
  blockIds: BlockId[];
  /** Hardcore and exam blocks that stay active regardless. */
  excludedBlockIds: BlockId[];
  countdownMinutes: number | null;
  /** max(200, floor((balance + allowanceValue) / 2)) if confirmed now. */
  penaltyPoints: number;
  balance: number;
  /** Points parked in active allowances (they count towards the penalty). */
  allowanceValue: number;
  streakDays: number;
  /** The commitment phrase in each UI language; the UI shows its own. */
  phrases: { es: string; en: string };
}

/** `phrase` may be typed in either language (`emergencyPhraseMatches`). */
export interface EmergencyRequest {
  blockIds: BlockId[];
  phrase: string;
}

export interface EmergencyResponse {
  emergency: EmergencyUnlock;
}

export interface ConfirmEmergencyRequest {
  acknowledge: true;
}

export interface ConfirmEmergencyResponse {
  emergency: EmergencyUnlock;
  penaltyApplied: number;
  balanceAfter: number;
  cancelledBlockIds: BlockId[];
  streakDaysLost: number;
}

export interface RewardOfferStatus {
  offerId: string;
  serviceId: string;
  minutes: number;
  cost: number;
  affordable: boolean;
  /** «Te faltan 40 puntos»; 0 when affordable. */
  shortBy: number;
  available: boolean;
  /** `allowance_limit`: the service's allowance would exceed `allowanceMaxMinutes`. */
  unavailableReason: 'not_blocked' | 'insufficient_points' | 'locked' | 'allowance_limit' | null;
}

export interface RewardsResponse {
  locked: boolean;
  lockReason: RewardsLockReason | null;
  balance: number;
  offers: RewardOfferStatus[];
  allowances: RewardAllowance[];
}

export interface RedeemRewardRequest {
  offerId: string;
}

export interface RedeemRewardResponse {
  allowance: RewardAllowance;
  pointsDelta: number;
  balanceAfter: number;
}

export interface SettingsResponse {
  settings: GuardianSettings;
  pending: PendingSettingChange[];
}

export interface PairingCodeResponse {
  code: string;
  expiresAt: IsoUtc;
  port: number;
}

export interface PairingClaimRequest {
  code: string;
  browser: BrowserFamily;
  browserVersion: string;
  extVersion: string;
}

export interface PairingClaimResponse {
  extensionId: ExtensionId;
  token: string;
  guardianVersion: string;
  boundOrigin: string | null;
  /**
   * base64url SPKI (DER) of the guardian's ECDSA P-256 rules key: the extension verifies
   * `/v1/ext/rules` with it (`verifyRulesSignature`), so a process that squats the port
   * cannot forge rules even with the extension token.
   */
  rulesPublicKey: string;
}

export interface PairedExtension {
  id: ExtensionId;
  browser: BrowserFamily;
  extVersion: string;
  pairedAt: IsoUtc;
  lastSeenAt: IsoUtc | null;
  boundOrigin: string | null;
}

export interface PairedExtensionsResponse {
  extensions: PairedExtension[];
}

export interface ExtRuleBlock {
  id: BlockId;
  /** A limit block is reported as `manual` with `limitId` set (§8.4). */
  kind: BlockKind;
  mode: BlockMode;
  endsAt: IsoUtc;
  reason: string;
  /** Catalog services it blocks (categories expanded), for «YouTube: bloqueado». */
  serviceIds: string[];
  /** Resolved hosts; `[]` for whitelist-only blocks. */
  domains: string[];
  whitelistOnly: boolean;
  /** The daily limit behind a limit block; absent from guardians without `daily_limits`. */
  limitId?: LimitId | null;
}

/**
 * An enabled daily limit as the extension needs it: which hosts count as usage (the
 * badge, `POST /v1/usage`) and the copy of blocked.html («Has usado tus 30 min de YouTube
 * de hoy»). Usage itself is not here (it would change the ETag every report): it comes
 * back from `POST /v1/usage`.
 */
export interface ExtRuleLimit {
  id: LimitId;
  name: string;
  /** Catalog services it covers (categories expanded). */
  serviceIds: string[];
  /**
   * Resolved hosts (custom domains with their `www.`/apex variants, minus always-allowed
   * hosts): a tab counts when its host equals or is under one of them and is not equal to
   * or under an `excludedDomains` entry.
   */
  domains: string[];
  /** Catalog `excludedSubdomains` of its services and always-allowed hosts under `domains`. */
  excludedDomains: string[];
  dailyMinutes: number;
  appliesToday: boolean;
}

/**
 * Exemptions from the **whitelist rule only** (never from `blockDomains`): the
 * intersection of the active whitelist blocks' allow sets, plus allowance domains and
 * always-allowed hosts.
 */
export interface ExtWhitelistRules {
  /** Allowed hosts; each also allows its subdomains. */
  allowDomains: string[];
  /** RE2 sources matched against the whole host (`^…$`), from catalog `hostPatterns`. */
  allowHostPatterns: string[];
}

/**
 * `GET /v1/ext/rules`. DNR priorities, highest first: allow `excludedDomains`,
 * `127.0.0.1` and `localhost`; redirect `blockDomains`; allow `whitelist` entries;
 * redirect every other `main_frame` (only while `whitelist` is set). So a whitelist
 * allowance never reopens a host another block lists explicitly.
 */
export interface ExtRulesResponse {
  /**
   * Enforcement counter (not the points `rulesVersion`). Persisted and strictly
   * increasing across restarts and epochs; the extension rejects a lower one.
   */
  extRulesVersion: number;
  /** Echo of the request's `nonce` (inside the signed body: no replays). */
  nonce: string;
  serverNow: IsoUtc;
  /**
   * The union of the non-whitelist blocks' resolved domains − allowance domains −
   * always-allowed hosts. Whitelist allow sets never subtract from it.
   */
  blockDomains: string[];
  /**
   * Hosts under `blockDomains` that must stay reachable (catalog `excludedSubdomains` and
   * always-allowed hosts). The extension matches subdomains, so it exempts these with
   * `excludedRequestDomains` or a higher-priority allow rule; the hosts file never lists
   * them.
   */
  excludedDomains: string[];
  /** Present while any whitelist-only block is active: block every main frame except these. */
  whitelist: ExtWhitelistRules | null;
  blocks: ExtRuleBlock[];
  allowances: Array<{ serviceId: string; endsAt: IsoUtc }>;
  /**
   * Summary of the active punishments (they stack): the latest `endsAt` and the highest
   * `level` (`distractions` < `whitelist` < `nuclear`); `null` without punishments.
   */
  punishment: { endsAt: IsoUtc; level: PunishmentLevel } | null;
  /** Earliest end among blocks and allowances (the extension sets an alarm). */
  nextChangeAt: IsoUtc | null;
  penaltiesEnabled: boolean;
  /**
   * Enabled daily limits (creation order). Their changes, and a new local day, bump
   * `extRulesVersion`. Absent from guardians without `daily_limits`: then the extension
   * reports no usage.
   */
  limits?: ExtRuleLimit[];
}

export interface ExtHeartbeatRequest {
  extVersion: string;
  /** Must equal the family bound at pairing (403 `insufficient_scope` otherwise). */
  browser: BrowserFamily;
  browserVersion: string;
  incognitoAllowed: boolean;
  hostPermission: boolean;
  appliedExtRulesVersion: number;
}

export interface ExtHeartbeatResponse {
  extRulesVersion: number;
  serverNow: IsoUtc;
}

/**
 * `POST /v1/nuclear/heartbeat`, every `nuclearHeartbeatIntervalMs` while the Nuclear
 * overlay runs. The guardian only accepts it from a loopback peer whose process image is
 * the installed app (`config.json` `appPath`) in the console session; without one for
 * `nuclearLivenessMs` it relaunches the app.
 */
export interface NuclearHeartbeatRequest {
  /** The overlay covers every display right now. */
  overlayShown: boolean;
  /** Displays covered (1–16). */
  displays: number;
}

export interface NuclearHeartbeatResponse {
  nuclearActive: boolean;
  /** Latest end among active Nuclear punishments (display time); `null` when none. */
  endsAt: IsoUtc | null;
  serverNow: IsoUtc;
}

export interface DeleteDataRequest {
  confirm: string;
}

export interface DeleteDataResponse {
  epoch: EpochId;
  carryOverBalance: number;
  keptBlockIds: BlockId[];
  keptPunishmentIds: PunishmentId[];
  keptScheduleIds: ScheduleId[];
  /** Every limit is kept (§10.11); absent from guardians without `daily_limits`. */
  keptLimitIds?: LimitId[];
}

/** Test builds only: drive the fake clock. Exactly one action per call. */
export interface TestClockRequest {
  advanceMs: number | null;
  suspendMs: number | null;
  jumpMs: number | null;
  reboot: boolean;
}

export interface TestClockResponse {
  serverNow: IsoUtc;
  trustedNow: IsoUtc;
}

// ---------------------------------------------------------------------------------------
// Validation library
// ---------------------------------------------------------------------------------------

export type ValidationIssueKind =
  | 'type'
  | 'required'
  | 'unknown_field'
  | 'enum'
  | 'range'
  | 'pattern'
  | 'length'
  | 'duplicate'
  | 'invalid_domain'
  | 'invalid_process'
  | 'protected_process'
  | 'rule';

/** First problem found. `path` is like `targets.customDomains[2]` (`$` = the root). */
export interface ValidationIssue {
  path: string;
  issue: ValidationIssueKind;
  message: string;
}

interface Ctx {
  strict: boolean;
}

type Check = (value: unknown, path: string, ctx: Ctx) => ValidationIssue | null;

/** A runtime validator for values of type `T`. */
export interface Schema<T> {
  readonly check: Check;
  /** Phantom field that carries `T`; never set. */
  readonly __type?: T;
}

export type SchemaValue<S> = S extends Schema<infer T> ? T : never;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

function make<T>(check: Check): Schema<T> {
  return { check };
}

function issue(path: string, kind: ValidationIssueKind, message: string): ValidationIssue {
  return { path: path === '' ? '$' : path, issue: kind, message };
}

function child(path: string, key: string): string {
  if (key === '') return path;
  return path === '' ? key : `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Control characters and bidi overrides are never accepted in user text. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

const bool: Schema<boolean> = make((v, p) =>
  typeof v === 'boolean' ? null : issue(p, v === undefined ? 'required' : 'type', 'boolean'),
);

function literal<L extends string | number | boolean>(lit: L): Schema<L> {
  return make((v, p) =>
    v === lit
      ? null
      : issue(p, v === undefined ? 'required' : 'enum', `expected ${JSON.stringify(lit)}`),
  );
}

function int(min: number, max: number): Schema<number> {
  return make((v, p) => {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return issue(p, v === undefined ? 'required' : 'type', 'integer');
    }
    return v < min || v > max ? issue(p, 'range', `integer in [${min}, ${max}]`) : null;
  });
}

const I32 = 2_147_483_647;
const SAFE = Number.MAX_SAFE_INTEGER;
const count = int(0, SAFE);
const signed = int(-SAFE, SAFE);

/**
 * Length of a text as every limit counts it: UTF-16 code units (JavaScript `.length`).
 * Go: `utf16Len(s) = Σ over runes (r ≥ 0x10000 ? 2 : 1)`.
 */
export function textLength(text: string): number {
  return text.length;
}

function str(opts: {
  min?: number;
  max: number;
  pattern?: RegExp;
  text?: boolean;
}): Schema<string> {
  const min = opts.min ?? 0;
  return make((v, p) => {
    if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
    const length = textLength(v);
    if (length < min || length > opts.max) {
      return issue(p, 'length', `length in [${min}, ${opts.max}]`);
    }
    if (opts.text && UNSAFE_TEXT_RE.test(v)) return issue(p, 'pattern', 'control characters');
    if (opts.pattern && !opts.pattern.test(v)) return issue(p, 'pattern', 'invalid format');
    return null;
  });
}

function oneOf<T extends string | number>(values: readonly T[]): Schema<T> {
  const set: ReadonlySet<unknown> = new Set(values);
  return make((v, p) =>
    set.has(v)
      ? null
      : issue(p, v === undefined ? 'required' : 'enum', `one of ${values.join(', ')}`),
  );
}

function nullable<T>(s: Schema<T>): Schema<T | null> {
  return make((v, p, ctx) => (v === null ? null : s.check(v, p, ctx)));
}

/**
 * A response field an older guardian may omit (§8.4): absent is accepted, a present value
 * must match. Only for fields added after v0.1 (their TS property is optional).
 */
function optional<T>(s: Schema<T>): Schema<T> {
  return make((v, p, ctx) => (v === undefined ? null : s.check(v, p, ctx)));
}

function arr<T>(
  item: Schema<T>,
  opts: { min?: number; max: number; unique?: boolean },
): Schema<T[]> {
  const min = opts.min ?? 0;
  return make((v, p, ctx) => {
    if (!Array.isArray(v)) return issue(p, v === undefined ? 'required' : 'type', 'array');
    if (v.length < min || v.length > opts.max) {
      return issue(p, 'length', `between ${min} and ${opts.max} items`);
    }
    const seen = new Set<unknown>();
    for (let i = 0; i < v.length; i += 1) {
      const r = item.check(v[i], `${p === '' ? '$' : p}[${i}]`, ctx);
      if (r) return r;
      if (opts.unique) {
        if (seen.has(v[i])) return issue(`${p === '' ? '$' : p}[${i}]`, 'duplicate', 'duplicate');
        seen.add(v[i]);
      }
    }
    return null;
  });
}

type Shape<T> = { [K in keyof T]-?: Schema<T[K]> };

function obj<T extends object>(shape: Shape<T>): Schema<T> {
  const keys = Object.keys(shape) as Array<keyof T & string>;
  return make((v, p, ctx) => {
    if (!isRecord(v)) return issue(p, v === undefined ? 'required' : 'type', 'object');
    for (const key of keys) {
      const r = shape[key].check(hasOwn(v, key) ? v[key] : undefined, child(p, key), ctx);
      if (r) return r;
    }
    if (ctx.strict) {
      for (const key of Object.keys(v)) {
        if (!hasOwn(shape, key)) return issue(child(p, key), 'unknown_field', 'unknown field');
      }
    }
    return null;
  });
}

function tagged<M extends Record<string, Schema<unknown>>>(
  key: string,
  map: M,
): Schema<SchemaValue<M[keyof M]>> {
  return make((v, p, ctx) => {
    if (!isRecord(v)) return issue(p, v === undefined ? 'required' : 'type', 'object');
    const tag = v[key];
    if (typeof tag !== 'string' || !hasOwn(map, tag)) {
      return issue(child(p, key), tag === undefined ? 'required' : 'enum', 'unknown variant');
    }
    return (map[tag] as Schema<unknown>).check(v, p, ctx);
  });
}

function refine<T>(
  s: Schema<T>,
  rule: (value: T) => { path: string; message: string } | null,
): Schema<T> {
  return make((v, p, ctx) => {
    const r = s.check(v, p, ctx);
    if (r) return r;
    const broken = rule(v as T);
    return broken ? issue(child(p, broken.path), 'rule', broken.message) : null;
  });
}

interface IdTypes {
  block: BlockId;
  schedule: ScheduleId;
  study: StudySessionId;
  punishment: PunishmentId;
  emergency: EmergencyId;
  allowance: AllowanceId;
  attempt: AttemptId;
  extension: ExtensionId;
  epoch: EpochId;
  limit: LimitId;
}

function idOf<K extends IdKind>(kind: K): Schema<IdTypes[K]> {
  return make((v, p) =>
    isIdOf(kind, v)
      ? null
      : issue(p, v === undefined ? 'required' : 'pattern', `${ID_PREFIXES[kind]}_ id`),
  );
}

/**
 * Exactly `YYYY-MM-DDTHH:MM:SS.sssZ` (what `Date.prototype.toISOString` prints). Go writes
 * `t.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")`; its default
 * RFC 3339 encoding (nanoseconds, offsets) is rejected.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const iso: Schema<IsoUtc> = make((v, p) => {
  if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
  return ISO_RE.test(v) && Number.isFinite(Date.parse(v))
    ? null
    : issue(p, 'pattern', 'ISO 8601 UTC timestamp with milliseconds');
});

const localDay = make<string>((v, p) =>
  isLocalDay(v) ? null : issue(p, v === undefined ? 'required' : 'pattern', 'YYYY-MM-DD'),
);

const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const clockTime = str({ max: 5, pattern: CLOCK_TIME_RE });

const TIMEZONE_RE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
const timezone = str({ min: 1, max: 64, pattern: TIMEZONE_RE });

const CATALOG_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const catalogId = str({ min: 1, max: 64, pattern: CATALOG_ID_RE });
const versionString = str({ min: 1, max: 64, pattern: /^[0-9A-Za-z.+_-]+$/ });
const categoryId: Schema<CategoryId> = oneOf<CategoryId>(CATEGORY_IDS);

const domain = make<string>((v, p) => {
  if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
  return isValidDomain(v) ? null : issue(p, 'invalid_domain', 'canonical domain');
});

/** Process names in requests: valid and never protected (system, Céntrate). */
const processName = make<string>((v, p) => {
  if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
  if (!isValidProcessName(v)) return issue(p, 'invalid_process', 'executable base name');
  return isProtectedProcessName(v) ? issue(p, 'protected_process', 'protected process') : null;
});

/** Process names in responses (already validated by the guardian). */
const anyProcessName = make<string>((v, p) => {
  if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
  return isValidProcessName(v) ? null : issue(p, 'invalid_process', 'executable base name');
});

const L = GUARDIAN_LIMITS;

const reasonText = str({ max: L.reasonMaxLength, text: true });
const taskText = str({ max: L.taskMaxLength, text: true });
const scheduleNameText = str({ min: 1, max: L.scheduleNameMaxLength, text: true });
const limitNameText = str({ min: 1, max: L.limitNameMaxLength, text: true });

function validateWith<T>(schema: Schema<T>, value: unknown, strict: boolean): ValidationResult<T> {
  const r = schema.check(value, '', { strict });
  return r ? { ok: false, issue: r } : { ok: true, value: value as T };
}

/** Strict validation (requests): unknown fields are rejected. */
export function validateRequest<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  return validateWith(schema, value, true);
}

/** Open validation (responses): unknown fields are ignored. */
export function validateResponse<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  return validateWith(schema, value, false);
}

function requestGuard<T>(schema: Schema<T>): (value: unknown) => value is T {
  return (value: unknown): value is T => schema.check(value, '', { strict: true }) === null;
}

function responseGuard<T>(schema: Schema<T>): (value: unknown) => value is T {
  return (value: unknown): value is T => schema.check(value, '', { strict: false }) === null;
}

// ---------------------------------------------------------------------------------------
// Domain schemas
// ---------------------------------------------------------------------------------------

interface ListCaps {
  ids: number;
  domains: number;
  processes: number;
}

/** Request caps (what a client may send). */
const IN_CAPS: ListCaps = {
  ids: L.maxIdsPerList,
  domains: L.maxCustomDomains,
  processes: L.maxCustomProcesses,
};
/**
 * Response caps: far larger, because the guardian legitimately emits more (a
 * `recovered` block carries the whole hosts section as `customDomains`).
 */
const OUT_CAPS: ListCaps = {
  ids: RESPONSE_LIMITS.ids,
  domains: RESPONSE_LIMITS.domains,
  processes: RESPONSE_LIMITS.processes,
};

function targetSpecSchema(process: Schema<string>, caps: ListCaps): Schema<TargetSpec> {
  return obj<TargetSpec>({
    serviceIds: arr(catalogId, { max: caps.ids, unique: true }),
    categoryIds: arr(categoryId, { max: CATEGORY_IDS.length, unique: true }),
    appIds: arr(catalogId, { max: caps.ids, unique: true }),
    customDomains: arr(domain, { max: caps.domains, unique: true }),
    customProcesses: arr(process, { max: caps.processes, unique: true }),
  });
}

function whitelistAllowSchema(process: Schema<string>, caps: ListCaps): Schema<WhitelistAllow> {
  return obj<WhitelistAllow>({
    customDomains: arr(domain, { max: caps.domains, unique: true }),
    customProcesses: arr(process, { max: caps.processes, unique: true }),
  });
}

const targetSpecIn = targetSpecSchema(processName, IN_CAPS);
const targetSpecOut = targetSpecSchema(anyProcessName, OUT_CAPS);
const allowIn = whitelistAllowSchema(processName, IN_CAPS);
const allowOut = whitelistAllowSchema(anyProcessName, OUT_CAPS);

const blockMode = oneOf(BLOCK_MODES);
const blockKind = oneOf(BLOCK_KINDS);
const browserFamily = oneOf(BROWSER_FAMILIES);
const isoWeekday = oneOf<IsoWeekday>([1, 2, 3, 4, 5, 6, 7]);
const punishmentLevel = oneOf(PUNISHMENT_LEVELS);

export const blockSchema: Schema<Block> = obj<Block>({
  id: idOf('block'),
  kind: blockKind,
  mode: blockMode,
  status: oneOf(BLOCK_STATUSES),
  targets: targetSpecOut,
  whitelistOnly: bool,
  allow: allowOut,
  reason: str({ max: L.reasonMaxLength }),
  createdAt: iso,
  startsAt: iso,
  endsAt: iso,
  originalEndsAt: iso,
  endedAt: nullable(iso),
  extendedMinutes: count,
  scheduleId: nullable(idOf('schedule')),
  punishmentId: nullable(idOf('punishment')),
  limitId: optional(nullable(idOf('limit'))),
  attemptsCounted: count,
  emergencyEligible: bool,
  pointsDelta: nullable(signed),
});

export const scheduleSchema: Schema<Schedule> = obj<Schedule>({
  id: idOf('schedule'),
  name: str({ min: 1, max: L.scheduleNameMaxLength }),
  enabled: bool,
  days: arr(isoWeekday, { min: 1, max: 7, unique: true }),
  start: clockTime,
  end: clockTime,
  timezone,
  targets: targetSpecOut,
  whitelistOnly: bool,
  allow: allowOut,
  mode: blockMode,
  reason: str({ max: L.reasonMaxLength }),
  createdAt: iso,
  updatedAt: iso,
  nextOccurrence: nullable(
    obj<{ startsAt: IsoUtc; endsAt: IsoUtc }>({ startsAt: iso, endsAt: iso }),
  ),
  activeBlockId: nullable(idOf('block')),
});

const limitMode = oneOf(LIMIT_MODES);
const limitNameOut = str({ min: 1, max: L.limitNameMaxLength });
const limitDays = arr(isoWeekday, { min: 1, max: 7, unique: true });
const limitMinutes = int(L.limitMinMinutes, L.limitMaxMinutes);

function limitDefinitionShape(
  targets: Schema<TargetSpec>,
  name: Schema<string>,
  reason: Schema<string>,
): Shape<DailyLimitDefinition> {
  return {
    name,
    enabled: bool,
    targets,
    dailyMinutes: limitMinutes,
    days: limitDays,
    mode: limitMode,
    reason,
  };
}

/** Limits always block something: at least one target. */
function limitTargetRule(r: { targets: TargetSpec }): { path: string; message: string } | null {
  return targetCount(r.targets) === 0 ? { path: 'targets', message: 'at least one target' } : null;
}

const limitDefinitionOut: Schema<DailyLimitDefinition> = refine(
  obj<DailyLimitDefinition>(
    limitDefinitionShape(targetSpecOut, limitNameOut, str({ max: L.reasonMaxLength })),
  ),
  limitTargetRule,
);

export const pendingLimitChangeSchema: Schema<PendingLimitChange> = obj<PendingLimitChange>({
  definition: nullable(limitDefinitionOut),
  effectiveAt: iso,
});

export const limitSchema: Schema<DailyLimit> = refine(
  obj<DailyLimit>({
    ...limitDefinitionShape(targetSpecOut, limitNameOut, str({ max: L.reasonMaxLength })),
    id: idOf('limit'),
    createdAt: iso,
    updatedAt: iso,
    day: localDay,
    appliesToday: bool,
    usedTodaySeconds: count,
    remainingTodaySeconds: int(0, L.limitMaxMinutes * 60),
    reachedAt: nullable(iso),
    activeBlockId: nullable(idOf('block')),
    pendingChange: nullable(pendingLimitChangeSchema),
  }),
  limitTargetRule,
);

const pomodoroSchema: Schema<PomodoroSpec> = obj<PomodoroSpec>({
  workMinutes: int(STUDY_RULES.pomodoroWorkMinutes.min, STUDY_RULES.pomodoroWorkMinutes.max),
  breakMinutes: int(STUDY_RULES.pomodoroBreakMinutes.min, STUDY_RULES.pomodoroBreakMinutes.max),
});

const punishmentPolicySchema: Schema<PunishmentPolicy> = obj<PunishmentPolicy>({
  level: punishmentLevel,
  minutes: int(STUDY_RULES.punishmentMinutes.min, STUDY_RULES.punishmentMinutes.max),
});

export const studySessionSchema: Schema<StudySession> = obj<StudySession>({
  id: idOf('study'),
  task: str({ max: L.taskMaxLength }),
  plannedMinutes: int(STUDY_RULES.plannedMinutes.min, STUDY_RULES.plannedMinutes.max),
  pomodoro: nullable(pomodoroSchema),
  camera: bool,
  status: oneOf(STUDY_STATUSES),
  phase: oneOf(STUDY_PHASES),
  phaseEndsAt: nullable(iso),
  startedAt: iso,
  plannedEndsAt: iso,
  endedAt: nullable(iso),
  activeMinutes: count,
  focusedMinutes: count,
  strikes: count,
  attempts: count,
  cooldownUntil: nullable(iso),
  pausesLeft: count,
  nextPauseAvailableAt: nullable(iso),
  lastHeartbeatAt: nullable(iso),
  lastHeartbeatSeq: count,
  warnings: count,
  policy: punishmentPolicySchema,
  achieved: nullable(oneOf(ACHIEVED_VALUES)),
});

export const punishmentSchema: Schema<Punishment> = obj<Punishment>({
  id: idOf('punishment'),
  blockId: idOf('block'),
  sessionId: nullable(idOf('study')),
  task: str({ max: L.taskMaxLength }),
  cause: oneOf(PUNISHMENT_CAUSES),
  level: punishmentLevel,
  minutes: int(1, 1440),
  startsAt: iso,
  endsAt: iso,
  status: oneOf(PUNISHMENT_STATUSES),
  endedAt: nullable(iso),
});

export const emergencySchema: Schema<EmergencyUnlock> = refine(
  obj<EmergencyUnlock>({
    id: idOf('emergency'),
    blockIds: arr(idOf('block'), { min: 1, max: L.emergencyMaxBlocks, unique: true }),
    status: oneOf(EMERGENCY_STATUSES),
    countdownMinutes: int(1, 1440),
    requestedAt: iso,
    readyAt: iso,
    confirmBy: nullable(iso),
    penaltyPreview: count,
    streakDaysAtRisk: count,
    resolvedAt: nullable(iso),
    cancelReason: nullable(oneOf(EMERGENCY_CANCEL_REASONS)),
  }),
  (e) =>
    (EMERGENCY_STATUS_REASONS[e.status] as readonly (EmergencyCancelReason | null)[]).includes(
      e.cancelReason,
    )
      ? null
      : { path: 'cancelReason', message: `not allowed with status ${e.status}` },
);

export const allowanceSchema: Schema<RewardAllowance> = obj<RewardAllowance>({
  id: idOf('allowance'),
  offerId: catalogId,
  serviceId: catalogId,
  minutes: int(1, 1440),
  cost: count,
  startedAt: iso,
  endsAt: iso,
  status: oneOf(ALLOWANCE_STATUSES),
  endedAt: nullable(iso),
  refund: count,
});

const studyWhitelistSchema = (
  process: Schema<string>,
): Schema<GuardianSettings['studyWhitelist']> =>
  obj<GuardianSettings['studyWhitelist']>({
    extraDomains: arr(domain, { max: L.maxWhitelistExtraDomains, unique: true }),
    extraProcesses: arr(process, { max: L.maxWhitelistExtraProcesses, unique: true }),
  });

const timezoneOrNull: Schema<string | null> = nullable(
  refine(timezone, (tz) =>
    tz === 'Local' ? { path: '', message: '"Local" is not allowed' } : null,
  ),
);

const dailyGoal = int(1, 1440);

function settingsSchema(process: Schema<string>, goal: Schema<number>): Schema<GuardianSettings> {
  return obj<GuardianSettings>({
    timezone: timezoneOrNull,
    dailyGoalMinutes: goal,
    attemptPenalties: bool,
    punishment: punishmentPolicySchema,
    closeBrowsersWithoutExtension: bool,
    serverTimeCheck: bool,
    studyWhitelist: studyWhitelistSchema(process),
  });
}

const settingsOut = settingsSchema(anyProcessName, dailyGoal);

function pendingField<P extends PendingSettingPath>(
  field: P,
  value: Schema<PendingSettingValues[P]>,
): Schema<{ field: P; value: PendingSettingValues[P]; effectiveAt: IsoUtc }> {
  return obj<{ field: P; value: PendingSettingValues[P]; effectiveAt: IsoUtc }>({
    field: literal(field),
    value,
    effectiveAt: iso,
  });
}

export const pendingSettingSchema: Schema<PendingSettingChange> = tagged('field', {
  timezone: pendingField('timezone', timezoneOrNull),
  dailyGoalMinutes: pendingField('dailyGoalMinutes', dailyGoal),
  attemptPenalties: pendingField('attemptPenalties', bool),
  closeBrowsersWithoutExtension: pendingField('closeBrowsersWithoutExtension', bool),
  serverTimeCheck: pendingField('serverTimeCheck', bool),
  'studyWhitelist.extraDomains': pendingField(
    'studyWhitelist.extraDomains',
    arr(domain, { max: L.maxWhitelistExtraDomains, unique: true }),
  ),
  'studyWhitelist.extraProcesses': pendingField(
    'studyWhitelist.extraProcesses',
    arr(anyProcessName, { max: L.maxWhitelistExtraProcesses, unique: true }),
  ),
});
const pendingList = arr(pendingSettingSchema, { max: 16 });

export const pointsSummarySchema: Schema<PointsSummary> = obj<PointsSummary>({
  balance: signed,
  xp: count,
  level: int(1, SAFE),
  levelFloorXp: count,
  nextLevelXp: count,
  streakDays: count,
  bestStreakDays: count,
  today: obj<PointsSummary['today']>({
    day: localDay,
    focusMinutes: count,
    goalMinutes: dailyGoal,
    goalMet: bool,
  }),
  pendingFocusMinutes: count,
});

const escalationSchema: Schema<EscalationState> = obj<EscalationState>({
  lastCountedAt: nullable(iso),
  index: int(0, 64),
});

// ---------------------------------------------------------------------------------------
// Event schemas
// ---------------------------------------------------------------------------------------

const recoveryKind = oneOf([
  'none',
  'replayed',
  'backup_snapshot',
  'rebuilt',
  'partial',
  'hosts_section',
  'empty',
] as const);

const blockIdList = arr(idOf('block'), { max: RESPONSE_LIMITS.ids, unique: true });
/** `proc:` keys keep spaces (`proc:my game.exe`); control characters are never allowed. */
const targetKey = str({ min: 5, max: 300, pattern: /^(?:svc|app|dom|proc):\S.*$/, text: true });

type DataSchemas = { [K in EventType]: Schema<EventDataMap[K]> };
type Data<K extends EventType> = EventDataMap[K];

const eventDataSchemas: DataSchemas = {
  guardian_started: obj<Data<'guardian_started'>>({
    version: versionString,
    schemaVersion: int(1, I32),
    catalogVersion: int(0, I32),
    rulesVersion: int(0, I32),
    mode: oneOf(GUARDIAN_MODES),
    sameBoot: bool,
    downtimeMs: nullable(count),
    uncleanShutdown: bool,
    recovery: recoveryKind,
  }),
  epoch_started: obj<Data<'epoch_started'>>({
    reason: oneOf(['install', 'data_deleted', 'log_unreadable', 'untrusted_key'] as const),
    previousEpoch: nullable(idOf('epoch')),
    carryOverBalance: int(-SAFE, 0),
    escalation: escalationSchema,
    kept: obj<EpochKeptState>({
      blocks: arr(blockSchema, { max: RESPONSE_LIMITS.blocks }),
      punishments: arr(punishmentSchema, { max: RESPONSE_LIMITS.punishments }),
      allowances: arr(allowanceSchema, { max: RESPONSE_LIMITS.allowances }),
      schedules: arr(scheduleSchema, { max: RESPONSE_LIMITS.schedules }),
      settings: settingsOut,
      pendingSettings: pendingList,
      materializedOccurrences: arr(str({ min: 1, max: 128 }), { max: RESPONSE_LIMITS.ids }),
      limits: optional(arr(limitSchema, { max: RESPONSE_LIMITS.limits })),
    }),
  }),
  clock_jump: obj<Data<'clock_jump'>>({
    source: oneOf(CLOCK_JUMP_SOURCES),
    deltaMs: signed,
    wallOffsetMs: signed,
    trust: oneOf(CLOCK_TRUST_LEVELS),
    reactivatedBlockIds: blockIdList,
    shiftedBlockIds: blockIdList,
    shiftedAllowanceIds: arr(idOf('allowance'), { max: RESPONSE_LIMITS.ids, unique: true }),
  }),
  day_closed: obj<Data<'day_closed'>>({ day: localDay, goalMinutes: dailyGoal }),
  block_created: obj<Data<'block_created'>>({
    block: blockSchema,
    source: oneOf(['user', 'schedule', 'punishment', 'limit'] as const),
  }),
  block_extended: obj<Data<'block_extended'>>({
    blockId: idOf('block'),
    addMinutes: int(1, L.extendMaxAddMinutes),
    endsAt: iso,
  }),
  block_completed: obj<Data<'block_completed'>>({
    blockId: idOf('block'),
    kind: blockKind,
    mode: blockMode,
    creditedMinutes: count,
    attemptsCounted: count,
    downtimeMs: count,
    clockTrust: oneOf(CLOCK_TRUST_LEVELS),
  }),
  block_cancelled: obj<Data<'block_cancelled'>>({
    blockId: idOf('block'),
    emergencyId: idOf('emergency'),
    forfeitedMinutes: count,
  }),
  block_reactivated: obj<Data<'block_reactivated'>>({
    blockId: idOf('block'),
    revertsSeq: int(1, SAFE),
    revertPoints: count,
    endsAt: iso,
    reason: literal('clock_correction'),
  }),
  attempt: obj<Data<'attempt'>>({
    attemptId: idOf('attempt'),
    layer: oneOf(ATTEMPT_LAYERS),
    targetKey,
    targetType: oneOf(['service', 'app', 'domain', 'process'] as const),
    serviceId: nullable(catalogId),
    blockIds: blockIdList,
    browser: nullable(browserFamily),
    incognito: bool,
    escalationIndex: int(0, 64),
    penalized: bool,
  }),
  process_closed: obj<Data<'process_closed'>>({
    reason: oneOf(['running_at_block_start', 'logon_grace', 'browser_without_extension'] as const),
    serviceId: nullable(catalogId),
    appId: nullable(catalogId),
    browser: nullable(browserFamily),
    blockIds: blockIdList,
  }),
  study_started: obj<Data<'study_started'>>({ session: studySessionSchema }),
  study_paused: obj<Data<'study_paused'>>({ sessionId: idOf('study'), pauseEndsAt: iso }),
  study_resumed: obj<Data<'study_resumed'>>({ sessionId: idOf('study'), auto: bool }),
  focus_minutes: obj<Data<'focus_minutes'>>({ sessionId: idOf('study'), minutes: int(1, 1440) }),
  strike: obj<Data<'strike'>>({
    sessionId: idOf('study'),
    strikeNumber: int(1, 64),
    cause: oneOf(STRIKE_CAUSES),
  }),
  study_ended: obj<Data<'study_ended'>>({
    sessionId: idOf('study'),
    outcome: oneOf(STUDY_OUTCOMES),
    plannedMinutes: int(1, 1440),
    activeMinutes: count,
    workMinutes: count,
    focusedMinutes: count,
    focusPct: int(0, 100),
    strikes: count,
    warnings: count,
    attempts: count,
    pointsTotal: signed,
    cleanBonus: count,
  }),
  study_outcome: obj<Data<'study_outcome'>>({
    sessionId: idOf('study'),
    achieved: oneOf(ACHIEVED_VALUES),
  }),
  punishment_started: obj<Data<'punishment_started'>>({ punishment: punishmentSchema }),
  punishment_ended: obj<Data<'punishment_ended'>>({
    punishmentId: idOf('punishment'),
    blockId: idOf('block'),
    outcome: oneOf(['completed', 'emergency'] as const),
  }),
  emergency_requested: obj<Data<'emergency_requested'>>({ emergency: emergencySchema }),
  emergency_cancelled: obj<Data<'emergency_cancelled'>>({
    emergencyId: idOf('emergency'),
    reason: oneOf(EMERGENCY_CANCEL_REASONS),
  }),
  emergency_confirmed: obj<Data<'emergency_confirmed'>>({
    emergencyId: idOf('emergency'),
    blockIds: blockIdList,
    balanceBefore: signed,
    allowanceValue: count,
    penalty: count,
    streakDaysLost: count,
    goalMinutes: dailyGoal,
  }),
  reward_redeemed: obj<Data<'reward_redeemed'>>({
    allowanceId: idOf('allowance'),
    offerId: catalogId,
    serviceId: catalogId,
    offerMinutes: int(1, 1440),
    offerCost: count,
    allowanceMinutes: int(1, 1440),
    allowanceCost: count,
    endsAt: iso,
    extendedExisting: bool,
  }),
  reward_ended: obj<Data<'reward_ended'>>({
    allowanceId: idOf('allowance'),
    serviceId: catalogId,
    reason: oneOf(['expired', 'revoked'] as const),
    revokedByBlockId: nullable(idOf('block')),
    cost: count,
    totalMs: count,
    remainingMs: count,
    refund: count,
  }),
  schedule_created: obj<Data<'schedule_created'>>({ schedule: scheduleSchema }),
  schedule_updated: obj<Data<'schedule_updated'>>({ schedule: scheduleSchema }),
  schedule_deleted: obj<Data<'schedule_deleted'>>({ scheduleId: idOf('schedule') }),
  limit_created: obj<Data<'limit_created'>>({ limit: limitSchema }),
  limit_updated: obj<Data<'limit_updated'>>({
    limit: limitSchema,
    cause: oneOf(['user', 'pending_applied'] as const),
  }),
  limit_deleted: obj<Data<'limit_deleted'>>({ limitId: idOf('limit'), name: limitNameOut }),
  limit_warning: obj<Data<'limit_warning'>>({
    limitId: idOf('limit'),
    name: limitNameOut,
    day: localDay,
    dailyMinutes: limitMinutes,
    usedSeconds: count,
    remainingSeconds: int(1, L.limitWarningSeconds),
  }),
  limit_reached: obj<Data<'limit_reached'>>({
    limitId: idOf('limit'),
    name: limitNameOut,
    day: localDay,
    dailyMinutes: limitMinutes,
    usedSeconds: count,
    blockId: nullable(idOf('block')),
  }),
  limit_day_closed: obj<Data<'limit_day_closed'>>({
    limitId: idOf('limit'),
    name: limitNameOut,
    day: localDay,
    dailyMinutes: limitMinutes,
    usedSeconds: count,
    applied: bool,
    reached: bool,
  }),
  settings_changed: obj<Data<'settings_changed'>>({
    settings: settingsOut,
    pending: pendingList,
  }),
  extension_paired: obj<Data<'extension_paired'>>({
    extensionId: idOf('extension'),
    browser: browserFamily,
    boundOrigin: nullable(str({ min: 1, max: 200 })),
  }),
  extension_revoked: obj<Data<'extension_revoked'>>({ extensionId: idOf('extension') }),
  tamper_detected: obj<Data<'tamper_detected'>>({
    kind: oneOf(TAMPER_KINDS),
    balanceCorrection: int(-SAFE, 0),
    voidStreak: bool,
  }),
  ledger_repaired: obj<Data<'ledger_repaired'>>({
    droppedFromSeq: int(1, SAFE),
    droppedCount: count,
    archivedAs: str({ min: 1, max: 200 }),
    balanceCorrection: int(-SAFE, 0),
  }),
};

const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

const envelopeSchema: Schema<EventEnvelopeBase> = obj<EventEnvelopeBase>({
  v: literal(1),
  epoch: idOf('epoch'),
  seq: int(1, SAFE),
  at: iso,
  wallOffsetMs: signed,
  day: localDay,
  points: signed,
  xp: count,
  txEnd: bool,
  req: nullable(str({ min: 1, max: 128, pattern: /^[0-9a-f]+$/ })),
});

/** Envelope plus a well-formed `type` and a present `data` (any value). */
const eventLineSchema: Schema<EventEnvelopeBase & { type: string; data: unknown }> = make(
  (v, p) => {
    const r = envelopeSchema.check(v, p, { strict: false });
    if (r) return r;
    const record = v as Record<string, unknown>;
    const type = record['type'];
    if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
      return issue(child(p, 'type'), type === undefined ? 'required' : 'pattern', 'event type');
    }
    return hasOwn(record, 'data') ? null : issue(child(p, 'data'), 'required', 'data');
  },
);

/**
 * One fully valid event line: the envelope, and the payload of known types (it must be
 * an object for unknown, newer ones).
 */
export const wireEventSchema: Schema<WireEvent> = make((v, p, ctx) => {
  const r = eventLineSchema.check(v, p, ctx);
  if (r) return r;
  const record = v as Record<string, unknown>;
  const type = record['type'] as string;
  const data = record['data'];
  if (isEventType(type)) {
    return (eventDataSchemas[type] as Schema<unknown>).check(data, child(p, 'data'), ctx);
  }
  return isRecord(data) ? null : issue(child(p, 'data'), 'type', 'object');
});

/**
 * Classifies one event line whose envelope is valid (see `eventsResponseSchema`): a known
 * type with invalid `data` becomes a `MalformedGuardianEvent` instead of failing the page,
 * so the cursor keeps advancing and the recorded `points`/`xp` still apply.
 */
export function classifyWireEvent(
  line: EventEnvelopeBase & { type: string; data: unknown },
): WireEvent {
  const r = wireEventSchema.check(line, '', { strict: false });
  if (r === null) return line as WireEvent;
  const malformed: MalformedGuardianEvent = {
    ...line,
    malformed: { path: r.path, issue: r.issue, message: r.message },
  };
  return malformed;
}

// ---------------------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------------------

function targetCount(t: TargetSpec): number {
  return (
    t.serviceIds.length +
    t.categoryIds.length +
    t.appIds.length +
    t.customDomains.length +
    t.customProcesses.length
  );
}

function allowCount(a: WhitelistAllow): number {
  return a.customDomains.length + a.customProcesses.length;
}

/** Shared rules of blocks and schedules about targets, whitelist and mode. */
function targetRules(r: {
  targets: TargetSpec;
  whitelistOnly: boolean;
  allow: WhitelistAllow;
  mode: BlockMode;
}): { path: string; message: string } | null {
  if (r.mode === 'exam' && !r.whitelistOnly) {
    return { path: 'whitelistOnly', message: 'exam mode is whitelist-only' };
  }
  if (r.whitelistOnly) {
    return targetCount(r.targets) > 0
      ? { path: 'targets', message: 'whitelist-only blocks take no targets' }
      : null;
  }
  if (targetCount(r.targets) === 0) return { path: 'targets', message: 'at least one target' };
  if (allowCount(r.allow) > 0) return { path: 'allow', message: 'allow needs whitelistOnly' };
  return null;
}

export const createBlockRequestSchema: Schema<CreateBlockRequest> = refine(
  obj<CreateBlockRequest>({
    targets: targetSpecIn,
    whitelistOnly: bool,
    allow: allowIn,
    mode: blockMode,
    durationMinutes: nullable(int(L.blockMinMinutes, L.blockMaxMinutes)),
    endsAt: nullable(iso),
    reason: reasonText,
    acknowledgeLong: bool,
    acknowledgeNoEmergency: bool,
  }),
  (r) =>
    (r.durationMinutes === null) === (r.endsAt === null)
      ? { path: 'durationMinutes', message: 'exactly one of durationMinutes and endsAt' }
      : targetRules(r),
);

export const extendBlockRequestSchema: Schema<ExtendBlockRequest> = obj<ExtendBlockRequest>({
  addMinutes: int(1, L.extendMaxAddMinutes),
});

function clockMinutes(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** Length of a schedule window in minutes (`end <= start` wraps to the next day). */
export function scheduleWindowMinutes(start: string, end: string): number {
  const d = clockMinutes(end) - clockMinutes(start);
  return d <= 0 ? d + 1440 : d;
}

export const scheduleInputSchema: Schema<ScheduleInput> = refine(
  obj<ScheduleInput>({
    name: scheduleNameText,
    enabled: bool,
    days: arr(isoWeekday, { min: 1, max: 7, unique: true }),
    start: clockTime,
    end: clockTime,
    timezone: refine(timezone, (tz) =>
      tz === 'Local' ? { path: '', message: '"Local" is not allowed' } : null,
    ),
    targets: targetSpecIn,
    whitelistOnly: bool,
    allow: allowIn,
    mode: blockMode,
    reason: reasonText,
    acknowledgeNoEmergency: bool,
  }),
  (r) =>
    r.start === r.end
      ? { path: 'end', message: 'end must differ from start' }
      : scheduleWindowMinutes(r.start, r.end) < L.blockMinMinutes
        ? { path: 'end', message: `window shorter than ${L.blockMinMinutes} min` }
        : targetRules(r),
);

/** `POST /v1/limits`, `PUT /v1/limits/{id}`. */
export const dailyLimitInputSchema: Schema<DailyLimitInput> = refine(
  obj<DailyLimitInput>({
    ...limitDefinitionShape(targetSpecIn, limitNameText, reasonText),
    acknowledgeNoEmergency: bool,
  }),
  limitTargetRule,
);

const usageItemSchema: Schema<UsageItem> = tagged('type', {
  domain: obj<UsageItem>({
    type: literal('domain'),
    value: domain,
    seconds: int(1, L.usageMaxIntervalMs / 1000),
  }),
  process: obj<UsageItem>({
    type: literal('process'),
    value: anyProcessName,
    seconds: int(1, L.usageMaxIntervalMs / 1000),
  }),
}) as Schema<UsageItem>;

/** `POST /v1/usage`. Scope (§8.8): ext tokens send only `domain` items, the app `process`. */
export const usageReportRequestSchema: Schema<UsageReportRequest> = refine(
  obj<UsageReportRequest>({
    intervalMs: int(1_000, L.usageMaxIntervalMs),
    items: arr(usageItemSchema, { max: L.usageMaxItems }),
  }),
  (r) => {
    const maxSeconds = Math.ceil(r.intervalMs / 1000);
    const seen = new Set<string>();
    for (let i = 0; i < r.items.length; i += 1) {
      const item = r.items[i] as UsageItem;
      if (item.seconds > maxSeconds) {
        return { path: `items[${i}].seconds`, message: 'more seconds than the interval' };
      }
      const key = `${item.type}:${item.value}`;
      if (seen.has(key)) return { path: `items[${i}]`, message: 'duplicate item' };
      seen.add(key);
    }
    return null;
  },
);

export const startStudyRequestSchema: Schema<StartStudyRequest> = obj<StartStudyRequest>({
  task: taskText,
  plannedMinutes: int(STUDY_RULES.plannedMinutes.min, STUDY_RULES.plannedMinutes.max),
  pomodoro: nullable(pomodoroSchema),
  camera: bool,
});

export const heartbeatRequestSchema: Schema<HeartbeatRequest> = obj<HeartbeatRequest>({
  seq: int(1, I32),
  state: oneOf(HEARTBEAT_STATES),
  focusScore: nullable(int(0, 100)),
  focusedMsSinceLast: int(0, L.heartbeatMaxFocusMs),
  warningsSinceLast: int(0, L.heartbeatMaxWarnings),
  cameraOn: bool,
});

export const strikeRequestSchema: Schema<StrikeRequest> = obj<StrikeRequest>({
  cause: oneOf(STRIKE_CAUSES),
});

export const emptyRequestSchema: Schema<EmptyRequest> = make((v, p, ctx) => {
  if (!isRecord(v)) return issue(p, v === undefined ? 'required' : 'type', 'object');
  const extra = Object.keys(v)[0];
  return ctx.strict && extra !== undefined
    ? issue(child(p, extra), 'unknown_field', 'unknown field')
    : null;
});

export const endStudyRequestSchema: Schema<EndStudyRequest> = obj<EndStudyRequest>({
  reason: literal('user'),
  focusedMsSinceLast: int(0, L.heartbeatMaxFocusMs),
  warningsSinceLast: int(0, L.heartbeatMaxWarnings),
});

export const studyOutcomeRequestSchema: Schema<StudyOutcomeRequest> = obj<StudyOutcomeRequest>({
  achieved: oneOf(ACHIEVED_VALUES),
});

const attemptTargetSchema: Schema<AttemptTarget> = tagged('type', {
  domain: obj<{ type: 'domain'; value: string }>({ type: literal('domain'), value: domain }),
  service: obj<{ type: 'service'; value: string }>({ type: literal('service'), value: catalogId }),
});

export const attemptRequestSchema: Schema<AttemptRequest> = refine(
  obj<AttemptRequest>({
    layer: oneOf(['extension', 'window'] as const),
    target: attemptTargetSchema,
    browser: nullable(browserFamily),
    incognito: bool,
  }),
  (r) =>
    (r.layer === 'extension') !== (r.target.type === 'domain')
      ? { path: 'target.type', message: 'extension reports domains, window reports services' }
      : null,
);

const phraseText = str({ min: 1, max: L.phraseMaxLength });

export const emergencyRequestSchema: Schema<EmergencyRequest> = obj<EmergencyRequest>({
  blockIds: arr(idOf('block'), { min: 1, max: L.emergencyMaxBlocks, unique: true }),
  phrase: phraseText,
});

export const confirmEmergencyRequestSchema: Schema<ConfirmEmergencyRequest> =
  obj<ConfirmEmergencyRequest>({ acknowledge: literal(true) });

export const redeemRewardRequestSchema: Schema<RedeemRewardRequest> = obj<RedeemRewardRequest>({
  offerId: catalogId,
});

/** `PUT /v1/settings` body. */
export const settingsRequestSchema: Schema<GuardianSettings> = settingsSchema(
  processName,
  int(15, 600),
);

export const pairingClaimRequestSchema: Schema<PairingClaimRequest> = obj<PairingClaimRequest>({
  code: str({ min: 6, max: 6, pattern: /^\d{6}$/ }),
  browser: browserFamily,
  browserVersion: versionString,
  extVersion: versionString,
});

export const extHeartbeatRequestSchema: Schema<ExtHeartbeatRequest> = obj<ExtHeartbeatRequest>({
  extVersion: versionString,
  browser: browserFamily,
  browserVersion: versionString,
  incognitoAllowed: bool,
  hostPermission: bool,
  appliedExtRulesVersion: count,
});

export const nuclearHeartbeatRequestSchema: Schema<NuclearHeartbeatRequest> =
  obj<NuclearHeartbeatRequest>({
    overlayShown: bool,
    displays: int(1, 16),
  });

export const deleteDataRequestSchema: Schema<DeleteDataRequest> = obj<DeleteDataRequest>({
  confirm: str({ min: 1, max: 16, text: true }),
});

export const testClockRequestSchema: Schema<TestClockRequest> = refine(
  obj<TestClockRequest>({
    advanceMs: nullable(int(0, 30 * 86_400_000)),
    suspendMs: nullable(int(0, 30 * 86_400_000)),
    jumpMs: nullable(int(-365 * 86_400_000, 365 * 86_400_000)),
    reboot: bool,
  }),
  (r) =>
    [r.advanceMs !== null, r.suspendMs !== null, r.jumpMs !== null, r.reboot].filter(Boolean)
      .length === 1
      ? null
      : { path: '', message: 'exactly one action' },
);

// ---------------------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------------------

const problemList = arr(str({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_]*$/ }), { max: 64 });

export const errorBodySchema: Schema<GuardianErrorBody> = obj<GuardianErrorBody>({
  error: obj<GuardianErrorBody['error']>({
    code: str({ min: 1, max: 64, pattern: /^[a-z][a-z0-9_]*$/ }),
    message: str({ max: 1000 }),
    details: nullable(
      make<Record<string, unknown>>((v, p) => (isRecord(v) ? null : issue(p, 'type', 'object'))),
    ),
  }),
});

export const healthResponseSchema: Schema<HealthResponse> = obj<HealthResponse>({
  ok: bool,
  name: str({ min: 1, max: 64 }),
  version: versionString,
  apiVersion: int(1, 1000),
  capabilities: problemList,
  schemaVersion: int(1, I32),
  catalogVersion: int(0, I32),
  rulesVersion: int(0, I32),
  startedAt: iso,
  serverNow: iso,
  mode: oneOf(GUARDIAN_MODES),
  problems: problemList,
});

const clockStatusSchema: Schema<ClockStatus> = obj<ClockStatus>({
  wallOffsetMs: signed,
  trust: oneOf(CLOCK_TRUST_LEVELS),
  lastJump: nullable(
    obj<NonNullable<ClockStatus['lastJump']>>({
      at: iso,
      deltaMs: signed,
      source: oneOf(CLOCK_JUMP_SOURCES),
    }),
  ),
  lastCalibratedAt: nullable(iso),
  bootHoldUntil: nullable(iso),
});

const extensionStatusSchema: Schema<ExtensionStatus> = obj<ExtensionStatus>({
  id: idOf('extension'),
  browser: browserFamily,
  extVersion: versionString,
  connected: bool,
  lastSeenAt: nullable(iso),
  incognitoAllowed: bool,
  hostPermission: bool,
  appliedExtRulesVersion: count,
  protecting: bool,
});

const hostsStatus = oneOf(HOSTS_STATUSES);

const protectionSchema: Schema<ProtectionStatus> = obj<ProtectionStatus>({
  hosts: obj<ProtectionStatus['hosts']>({
    ok: bool,
    status: hostsStatus,
    entries: count,
    lastAppliedAt: nullable(iso),
  }),
  processWatcher: obj<ProtectionStatus['processWatcher']>({ ok: bool }),
  extensions: arr(extensionStatusSchema, { max: 64 }),
  browsersWithoutExtension: arr(browserFamily, { max: BROWSER_FAMILIES.length, unique: true }),
});

const endedBlockSchema: Schema<EndedBlockNotice> = obj<EndedBlockNotice>({
  id: idOf('block'),
  kind: blockKind,
  mode: blockMode,
  outcome: oneOf(['completed', 'cancelled_emergency'] as const),
  endedAt: iso,
  pointsDelta: signed,
});

const manyBlocks = arr(blockSchema, { max: RESPONSE_LIMITS.blocks });

const studySummarySchema: Schema<StudySummary> = obj<StudySummary>({
  outcome: oneOf(STUDY_OUTCOMES),
  activeMinutes: count,
  workMinutes: count,
  focusedMinutes: count,
  focusPct: int(0, 100),
  strikes: count,
  warnings: count,
  attempts: count,
  pointsTotal: signed,
  cleanBonus: count,
});

const studySessionDetailSchema: Schema<StudySessionDetail> = obj<StudySessionDetail>({
  session: studySessionSchema,
  summary: nullable(studySummarySchema),
});

export const stateResponseSchema: Schema<GuardianStateResponse> = obj<GuardianStateResponse>({
  stateVersion: count,
  serverNow: iso,
  epoch: idOf('epoch'),
  lastEventSeq: count,
  guardian: obj<GuardianStateResponse['guardian']>({
    version: versionString,
    apiVersion: int(1, 1000),
    mode: oneOf(GUARDIAN_MODES),
    problems: problemList,
  }),
  clock: clockStatusSchema,
  protection: protectionSchema,
  blocks: manyBlocks,
  punishments: arr(punishmentSchema, { max: RESPONSE_LIMITS.punishments }),
  nuclearActive: bool,
  study: nullable(studySessionSchema),
  emergency: nullable(emergencySchema),
  allowances: arr(allowanceSchema, { max: RESPONSE_LIMITS.allowances }),
  rewardsLock: nullable(oneOf(REWARDS_LOCK_REASONS)),
  nextSchedule: nullable(
    obj<NextScheduleInfo>({
      scheduleId: idOf('schedule'),
      name: str({ min: 1, max: L.scheduleNameMaxLength }),
      startsAt: iso,
      endsAt: iso,
    }),
  ),
  limits: optional(arr(limitSchema, { max: RESPONSE_LIMITS.limits })),
  points: pointsSummarySchema,
  pendingSettings: pendingList,
  recent: obj<GuardianStateResponse['recent']>({
    endedBlocks: arr(endedBlockSchema, { max: RESPONSE_LIMITS.blocks }),
    endedStudy: nullable(studySessionDetailSchema),
  }),
});

const anyText = (max: number): Schema<string> => str({ max });

export const diagnosticsResponseSchema: Schema<DiagnosticsResponse> = obj<DiagnosticsResponse>({
  guardian: obj<DiagnosticsResponse['guardian']>({
    version: versionString,
    commit: anyText(64),
    goVersion: anyText(64),
    os: anyText(32),
    arch: anyText(32),
    serviceManager: anyText(64),
    pid: count,
    port: int(1, 65_535),
    startedAt: iso,
    uptimeMs: count,
    mode: oneOf(GUARDIAN_MODES),
  }),
  state: obj<DiagnosticsResponse['state']>({
    schemaVersion: int(1, I32),
    epoch: idOf('epoch'),
    lastEventSeq: count,
    integrity: oneOf(['ok', 'repaired', 'rollback', 'rebuilt'] as const),
    stateBytes: count,
    eventsBytes: count,
  }),
  clock: obj<DiagnosticsResponse['clock']>({
    wallOffsetMs: signed,
    trust: oneOf(CLOCK_TRUST_LEVELS),
    bootClock: anyText(64),
    awakeClock: anyText(64),
    jumps24h: count,
    lastCalibration: nullable(
      obj<NonNullable<DiagnosticsResponse['clock']['lastCalibration']>>({
        at: iso,
        ok: bool,
        deltaMs: signed,
        sources: count,
      }),
    ),
  }),
  hosts: obj<DiagnosticsResponse['hosts']>({
    path: anyText(1024),
    pathOverridden: bool,
    status: hostsStatus,
    entries: count,
    lastWriteAt: nullable(iso),
    lastVerifyAt: nullable(iso),
    tamper24h: count,
    lastFlush: nullable(
      obj<NonNullable<DiagnosticsResponse['hosts']['lastFlush']>>({
        at: iso,
        ok: bool,
        method: anyText(32),
      }),
    ),
  }),
  processWatcher: obj<DiagnosticsResponse['processWatcher']>({
    intervalMs: count,
    lastScanMs: count,
    kills24h: count,
  }),
  extensions: arr(extensionStatusSchema, { max: 64 }),
  catalogVersion: int(0, I32),
  rulesVersion: int(0, I32),
  errors: arr(
    obj<DiagnosticsResponse['errors'][number]>({
      code: str({ min: 1, max: 64 }),
      count,
      lastAt: iso,
    }),
    { max: 256 },
  ),
});

export const createBlockResponseSchema: Schema<CreateBlockResponse> = obj<CreateBlockResponse>({
  block: blockSchema,
  stateVersion: count,
});

const cursorText = str({ min: 1, max: 200, pattern: /^[A-Za-z0-9_-]+$/ });

export const listBlocksResponseSchema: Schema<ListBlocksResponse> = obj<ListBlocksResponse>({
  blocks: manyBlocks,
  nextCursor: nullable(cursorText),
});

export const getBlockResponseSchema: Schema<GetBlockResponse> = obj<GetBlockResponse>({
  block: blockSchema,
  progress: obj<BlockProgress>({ creditedMinutes: count, downtimeMs: count }),
});

export const extendBlockResponseSchema: Schema<ExtendBlockResponse> = obj<ExtendBlockResponse>({
  block: blockSchema,
  stateVersion: count,
});

export const scheduleResponseSchema: Schema<ScheduleResponse> = obj<ScheduleResponse>({
  schedule: scheduleSchema,
});

export const listSchedulesResponseSchema: Schema<ListSchedulesResponse> =
  obj<ListSchedulesResponse>({
    schedules: arr(scheduleSchema, { max: RESPONSE_LIMITS.schedules }),
  });

export const limitResponseSchema: Schema<LimitResponse> = obj<LimitResponse>({
  limit: limitSchema,
});

export const listLimitsResponseSchema: Schema<ListLimitsResponse> = obj<ListLimitsResponse>({
  limits: arr(limitSchema, { max: RESPONSE_LIMITS.limits }),
});

export const usageReportResponseSchema: Schema<UsageReportResponse> = obj<UsageReportResponse>({
  day: localDay,
  limits: arr(
    obj<LimitUsageStatus>({
      limitId: idOf('limit'),
      usedTodaySeconds: count,
      remainingTodaySeconds: int(0, L.limitMaxMinutes * 60),
      appliesToday: bool,
      creditedSeconds: int(0, L.usageMaxIntervalMs / 1000),
      blockedUntil: nullable(iso),
    }),
    { max: RESPONSE_LIMITS.limits },
  ),
  serverNow: iso,
});

export const studySessionResponseSchema: Schema<StudySessionResponse> = obj<StudySessionResponse>({
  session: studySessionSchema,
});

export const currentStudyResponseSchema: Schema<CurrentStudyResponse> = obj<CurrentStudyResponse>({
  session: nullable(studySessionSchema),
});

export const studySessionDetailResponseSchema: Schema<StudySessionDetailResponse> =
  studySessionDetailSchema;

export const heartbeatResponseSchema: Schema<HeartbeatResponse> = obj<HeartbeatResponse>({
  duplicate: bool,
  acceptedFocusMs: int(0, L.heartbeatMaxFocusMs),
  session: studySessionSchema,
  serverNow: iso,
  heartbeatDeadlineMs: count,
});

export const strikeResponseSchema: Schema<StrikeResponse> = obj<StrikeResponse>({
  counted: bool,
  reason: nullable(oneOf(['cooldown', 'not_in_work_phase'] as const)),
  strikeNumber: count,
  pointsDelta: int(-SAFE, 0),
  punishmentPointsDelta: int(-SAFE, 0),
  cooldownUntil: nullable(iso),
  punishment: nullable(punishmentSchema),
  session: studySessionSchema,
});

export const endStudyResponseSchema: Schema<EndStudyResponse> = obj<EndStudyResponse>({
  session: studySessionSchema,
  summary: studySummarySchema,
});

export const attemptResponseSchema: Schema<AttemptResponse> = obj<AttemptResponse>({
  blocked: bool,
  counted: bool,
  merged: bool,
  attemptId: nullable(idOf('attempt')),
  pointsDelta: int(-SAFE, 0),
  episodePointsDelta: int(-SAFE, 0),
  escalationIndex: nullable(int(0, 64)),
  nextPenalty: count,
  serviceId: nullable(catalogId),
  block: nullable(
    obj<NonNullable<AttemptResponse['block']>>({
      id: idOf('block'),
      kind: blockKind,
      mode: blockMode,
      endsAt: iso,
      reason: str({ max: L.reasonMaxLength }),
      limitId: optional(nullable(idOf('limit'))),
    }),
  ),
  reason: nullable(oneOf(['not_blocked', 'allowance_active'] as const)),
});

export const pointsResponseSchema: Schema<PointsResponse> = obj<PointsResponse>({
  points: pointsSummarySchema,
});

/**
 * Checks every envelope but not the payloads: the client then runs `classifyWireEvent`
 * on each line, so one malformed event never blocks the sync of a whole page.
 */
export const eventsResponseSchema: Schema<EventsResponse> = obj<EventsResponse>({
  epoch: idOf('epoch'),
  reset: bool,
  events: arr(eventLineSchema, { max: L.eventsPageMax }) as unknown as Schema<WireEvent[]>,
  lastSeq: count,
  hasMore: bool,
});

export const emergencyPreviewResponseSchema: Schema<EmergencyPreviewResponse> =
  obj<EmergencyPreviewResponse>({
    eligible: bool,
    reason: nullable(
      oneOf(['hardcore', 'exam', 'no_active_blocks', 'emergency_in_progress'] as const),
    ),
    blockIds: blockIdList,
    excludedBlockIds: blockIdList,
    countdownMinutes: nullable(int(1, 1440)),
    penaltyPoints: count,
    balance: signed,
    allowanceValue: count,
    streakDays: count,
    phrases: obj<EmergencyPreviewResponse['phrases']>({ es: phraseText, en: phraseText }),
  });

export const emergencyResponseSchema: Schema<EmergencyResponse> = obj<EmergencyResponse>({
  emergency: emergencySchema,
});

export const confirmEmergencyResponseSchema: Schema<ConfirmEmergencyResponse> =
  obj<ConfirmEmergencyResponse>({
    emergency: emergencySchema,
    penaltyApplied: count,
    balanceAfter: signed,
    cancelledBlockIds: blockIdList,
    streakDaysLost: count,
  });

export const rewardsResponseSchema: Schema<RewardsResponse> = obj<RewardsResponse>({
  locked: bool,
  lockReason: nullable(oneOf(REWARDS_LOCK_REASONS)),
  balance: signed,
  offers: arr(
    obj<RewardOfferStatus>({
      offerId: catalogId,
      serviceId: catalogId,
      minutes: int(1, 1440),
      cost: count,
      affordable: bool,
      shortBy: count,
      available: bool,
      unavailableReason: nullable(
        oneOf(['not_blocked', 'insufficient_points', 'locked', 'allowance_limit'] as const),
      ),
    }),
    { max: 1000 },
  ),
  allowances: arr(allowanceSchema, { max: RESPONSE_LIMITS.allowances }),
});

export const redeemRewardResponseSchema: Schema<RedeemRewardResponse> = obj<RedeemRewardResponse>({
  allowance: allowanceSchema,
  pointsDelta: int(-SAFE, 0),
  balanceAfter: signed,
});

export const settingsResponseSchema: Schema<SettingsResponse> = obj<SettingsResponse>({
  settings: settingsOut,
  pending: pendingList,
});

export const pairingCodeResponseSchema: Schema<PairingCodeResponse> = obj<PairingCodeResponse>({
  code: str({ min: 6, max: 6, pattern: /^\d{6}$/ }),
  expiresAt: iso,
  port: int(1, 65_535),
});

export const pairingClaimResponseSchema: Schema<PairingClaimResponse> = obj<PairingClaimResponse>({
  extensionId: idOf('extension'),
  token: str({ min: 20, max: 200, pattern: /^cte_[0-9A-Za-z_-]+$/ }),
  guardianVersion: versionString,
  boundOrigin: nullable(str({ min: 1, max: 200 })),
  rulesPublicKey: str({ min: 40, max: 400, pattern: /^[A-Za-z0-9_-]+$/ }),
});

export const pairedExtensionsResponseSchema: Schema<PairedExtensionsResponse> =
  obj<PairedExtensionsResponse>({
    extensions: arr(
      obj<PairedExtension>({
        id: idOf('extension'),
        browser: browserFamily,
        extVersion: versionString,
        pairedAt: iso,
        lastSeenAt: nullable(iso),
        boundOrigin: nullable(str({ min: 1, max: 200 })),
      }),
      { max: 64 },
    ),
  });

const nonceText = str({ min: 16, max: 64, pattern: /^[A-Za-z0-9_-]+$/ });

export const extRulesResponseSchema: Schema<ExtRulesResponse> = obj<ExtRulesResponse>({
  extRulesVersion: count,
  nonce: nonceText,
  serverNow: iso,
  blockDomains: arr(domain, { max: RESPONSE_LIMITS.domains }),
  excludedDomains: arr(domain, { max: RESPONSE_LIMITS.domains }),
  whitelist: nullable(
    obj<ExtWhitelistRules>({
      allowDomains: arr(domain, { max: RESPONSE_LIMITS.domains }),
      allowHostPatterns: arr(str({ min: 1, max: 512 }), { max: 1000 }),
    }),
  ),
  blocks: arr(
    obj<ExtRuleBlock>({
      id: idOf('block'),
      kind: blockKind,
      mode: blockMode,
      endsAt: iso,
      reason: str({ max: L.reasonMaxLength }),
      serviceIds: arr(catalogId, { max: RESPONSE_LIMITS.ids }),
      domains: arr(domain, { max: RESPONSE_LIMITS.domains }),
      whitelistOnly: bool,
      limitId: optional(nullable(idOf('limit'))),
    }),
    { max: RESPONSE_LIMITS.blocks },
  ),
  allowances: arr(
    obj<{ serviceId: string; endsAt: IsoUtc }>({ serviceId: catalogId, endsAt: iso }),
    { max: RESPONSE_LIMITS.allowances },
  ),
  punishment: nullable(
    obj<{ endsAt: IsoUtc; level: PunishmentLevel }>({ endsAt: iso, level: punishmentLevel }),
  ),
  nextChangeAt: nullable(iso),
  penaltiesEnabled: bool,
  limits: optional(
    arr(
      obj<ExtRuleLimit>({
        id: idOf('limit'),
        name: limitNameOut,
        serviceIds: arr(catalogId, { max: RESPONSE_LIMITS.ids }),
        domains: arr(domain, { max: RESPONSE_LIMITS.domains }),
        excludedDomains: arr(domain, { max: RESPONSE_LIMITS.domains }),
        dailyMinutes: limitMinutes,
        appliesToday: bool,
      }),
      { max: RESPONSE_LIMITS.limits },
    ),
  ),
});

export const extHeartbeatResponseSchema: Schema<ExtHeartbeatResponse> = obj<ExtHeartbeatResponse>({
  extRulesVersion: count,
  serverNow: iso,
});

export const nuclearHeartbeatResponseSchema: Schema<NuclearHeartbeatResponse> =
  obj<NuclearHeartbeatResponse>({
    nuclearActive: bool,
    endsAt: nullable(iso),
    serverNow: iso,
  });

export const deleteDataResponseSchema: Schema<DeleteDataResponse> = obj<DeleteDataResponse>({
  epoch: idOf('epoch'),
  carryOverBalance: int(-SAFE, 0),
  keptBlockIds: blockIdList,
  keptPunishmentIds: arr(idOf('punishment'), { max: RESPONSE_LIMITS.ids, unique: true }),
  keptScheduleIds: arr(idOf('schedule'), { max: RESPONSE_LIMITS.ids, unique: true }),
  keptLimitIds: optional(arr(idOf('limit'), { max: RESPONSE_LIMITS.ids, unique: true })),
});

export const testClockResponseSchema: Schema<TestClockResponse> = obj<TestClockResponse>({
  serverNow: iso,
  trustedNow: iso,
});

// ---------------------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------------------

export const isCreateBlockRequest = requestGuard(createBlockRequestSchema);
export const isExtendBlockRequest = requestGuard(extendBlockRequestSchema);
export const isScheduleInput = requestGuard(scheduleInputSchema);
export const isDailyLimitInput = requestGuard(dailyLimitInputSchema);
export const isUsageReportRequest = requestGuard(usageReportRequestSchema);
export const isStartStudyRequest = requestGuard(startStudyRequestSchema);
export const isHeartbeatRequest = requestGuard(heartbeatRequestSchema);
export const isStrikeRequest = requestGuard(strikeRequestSchema);
export const isEmptyRequest = requestGuard(emptyRequestSchema);
export const isEndStudyRequest = requestGuard(endStudyRequestSchema);
export const isStudyOutcomeRequest = requestGuard(studyOutcomeRequestSchema);
export const isAttemptRequest = requestGuard(attemptRequestSchema);
export const isEmergencyRequest = requestGuard(emergencyRequestSchema);
export const isConfirmEmergencyRequest = requestGuard(confirmEmergencyRequestSchema);
export const isRedeemRewardRequest = requestGuard(redeemRewardRequestSchema);
export const isSettingsRequest = requestGuard(settingsRequestSchema);
export const isPairingClaimRequest = requestGuard(pairingClaimRequestSchema);
export const isExtHeartbeatRequest = requestGuard(extHeartbeatRequestSchema);
export const isNuclearHeartbeatRequest = requestGuard(nuclearHeartbeatRequestSchema);
export const isDeleteDataRequest = requestGuard(deleteDataRequestSchema);
export const isTestClockRequest = requestGuard(testClockRequestSchema);

export const isGuardianErrorBody = responseGuard(errorBodySchema);
export const isHealthResponse = responseGuard(healthResponseSchema);
export const isStateResponse = responseGuard(stateResponseSchema);
export const isDiagnosticsResponse = responseGuard(diagnosticsResponseSchema);
export const isBlock = responseGuard(blockSchema);
export const isSchedule = responseGuard(scheduleSchema);
export const isDailyLimit = responseGuard(limitSchema);
export const isStudySession = responseGuard(studySessionSchema);
export const isPunishment = responseGuard(punishmentSchema);
export const isEmergencyUnlock = responseGuard(emergencySchema);
export const isRewardAllowance = responseGuard(allowanceSchema);
export const isPointsSummary = responseGuard(pointsSummarySchema);
export const isWireEvent = responseGuard(wireEventSchema);
export const isCreateBlockResponse = responseGuard(createBlockResponseSchema);
export const isListBlocksResponse = responseGuard(listBlocksResponseSchema);
export const isGetBlockResponse = responseGuard(getBlockResponseSchema);
export const isExtendBlockResponse = responseGuard(extendBlockResponseSchema);
export const isScheduleResponse = responseGuard(scheduleResponseSchema);
export const isListSchedulesResponse = responseGuard(listSchedulesResponseSchema);
export const isLimitResponse = responseGuard(limitResponseSchema);
export const isListLimitsResponse = responseGuard(listLimitsResponseSchema);
export const isUsageReportResponse = responseGuard(usageReportResponseSchema);
export const isStudySessionResponse = responseGuard(studySessionResponseSchema);
export const isCurrentStudyResponse = responseGuard(currentStudyResponseSchema);
export const isStudySessionDetailResponse = responseGuard(studySessionDetailResponseSchema);
export const isHeartbeatResponse = responseGuard(heartbeatResponseSchema);
export const isStrikeResponse = responseGuard(strikeResponseSchema);
export const isEndStudyResponse = responseGuard(endStudyResponseSchema);
export const isAttemptResponse = responseGuard(attemptResponseSchema);
export const isPointsResponse = responseGuard(pointsResponseSchema);
export const isEventsResponse = responseGuard(eventsResponseSchema);
export const isEmergencyPreviewResponse = responseGuard(emergencyPreviewResponseSchema);
export const isEmergencyResponse = responseGuard(emergencyResponseSchema);
export const isConfirmEmergencyResponse = responseGuard(confirmEmergencyResponseSchema);
export const isRewardsResponse = responseGuard(rewardsResponseSchema);
export const isRedeemRewardResponse = responseGuard(redeemRewardResponseSchema);
export const isSettingsResponse = responseGuard(settingsResponseSchema);
export const isPairingCodeResponse = responseGuard(pairingCodeResponseSchema);
export const isPairingClaimResponse = responseGuard(pairingClaimResponseSchema);
export const isPairedExtensionsResponse = responseGuard(pairedExtensionsResponseSchema);
export const isExtRulesResponse = responseGuard(extRulesResponseSchema);
export const isExtHeartbeatResponse = responseGuard(extHeartbeatResponseSchema);
export const isNuclearHeartbeatResponse = responseGuard(nuclearHeartbeatResponseSchema);
export const isDeleteDataResponse = responseGuard(deleteDataResponseSchema);

// ---------------------------------------------------------------------------------------
// Extension rules signature (ECDSA P-256 + SHA-256, WebCrypto)
// ---------------------------------------------------------------------------------------

const SIGNATURE_PREFIX = 'v1=';
const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh random `nonce` for `GET /v1/ext/rules` (16 bytes, base64url). */
export function newRulesNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * `X-Centrate-Signature` value for a rules body: `v1=` + base64url(ECDSA P-256 / SHA-256
 * signature over the exact body bytes, raw `r‖s`, 64 bytes; Go signs with
 * `ecdsa.Sign` and writes r and s as 32-byte big-endian halves, not ASN.1). The guardian
 * signs with `secret/rules.key`; this is for tests and the dev harness.
 */
export async function computeRulesSignature(body: string, privateKey: CryptoKey): Promise<string> {
  const sig = await globalThis.crypto.subtle.sign(
    ECDSA_SIGN,
    privateKey,
    new TextEncoder().encode(body),
  );
  return SIGNATURE_PREFIX + base64UrlEncode(new Uint8Array(sig));
}

/**
 * Verifies a rules body against its signature header with the rules public key received
 * at pairing (`PairingClaimResponse.rulesPublicKey`, base64url SPKI). Knowing the
 * extension token is not enough to forge it.
 */
export async function verifyRulesSignature(
  body: string,
  header: string | null,
  rulesPublicKey: string,
): Promise<boolean> {
  if (header === null || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const signature = base64UrlDecode(header.slice(SIGNATURE_PREFIX.length));
  if (signature === null || signature.length !== 64) return false;
  const spki = base64UrlDecode(rulesPublicKey);
  if (spki === null || spki.length === 0) return false;
  let key: CryptoKey;
  try {
    key = await globalThis.crypto.subtle.importKey('spki', spki, ECDSA_KEY, false, ['verify']);
  } catch {
    return false;
  }
  return globalThis.crypto.subtle.verify(
    ECDSA_SIGN,
    key,
    signature,
    new TextEncoder().encode(body),
  );
}

/** A rules key pair as the guardian creates one (tests and the dev harness). */
export async function generateRulesKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
}> {
  const pair = await globalThis.crypto.subtle.generateKey(ECDSA_KEY, true, ['sign', 'verify']);
  const spki = await globalThis.crypto.subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: base64UrlEncode(new Uint8Array(spki)) };
}

// ---------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------

export type TokenSource = string | null | (() => string | null | Promise<string | null>);

export interface GuardianClientOptions {
  /** Default `http://127.0.0.1:47600`. */
  baseUrl?: string;
  /**
   * The app token (`client.json`) or the extension token. A function is called before
   * every request and again once after a 401 (the guardian rotates the app token on every
   * start, so the Electron main process re-reads the file).
   */
  token?: TokenSource;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Default `GUARDIAN_LIMITS.requestTimeoutMs`; long polls add their `waitMs`. */
  timeoutMs?: number;
  /** Default `crypto.randomUUID()`. */
  newIdempotencyKey?: () => string;
  /** Extension only: `PairingClaimResponse.rulesPublicKey`, to verify `/v1/ext/rules`. */
  rulesPublicKey?: string;
}

export interface WriteOptions {
  /** Reuse the same key when retrying the same user intention. */
  idempotencyKey?: string;
}

export type StateResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; state: GuardianStateResponse };

export type ExtRulesResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; rules: ExtRulesResponse; body: string };

export interface GuardianClient {
  health(): Promise<HealthResponse>;
  getState(options?: { etag?: string | null }): Promise<StateResult>;
  diagnostics(): Promise<DiagnosticsResponse>;
  createBlock(body: CreateBlockRequest, options?: WriteOptions): Promise<CreateBlockResponse>;
  listBlocks(query?: ListBlocksQuery): Promise<ListBlocksResponse>;
  getBlock(id: BlockId): Promise<GetBlockResponse>;
  extendBlock(
    id: BlockId,
    body: ExtendBlockRequest,
    options?: WriteOptions,
  ): Promise<ExtendBlockResponse>;
  listSchedules(): Promise<ListSchedulesResponse>;
  createSchedule(body: ScheduleInput, options?: WriteOptions): Promise<ScheduleResponse>;
  updateSchedule(id: ScheduleId, body: ScheduleInput): Promise<ScheduleResponse>;
  deleteSchedule(id: ScheduleId): Promise<void>;
  listLimits(): Promise<ListLimitsResponse>;
  createLimit(body: DailyLimitInput, options?: WriteOptions): Promise<LimitResponse>;
  /** Strengthening parts apply at once; the rest waits in `pendingChange` (§5.10). */
  updateLimit(id: LimitId, body: DailyLimitInput): Promise<LimitResponse>;
  /** Never deletes at once: sets a pending deletion (`pendingChange.definition: null`). */
  deleteLimit(id: LimitId): Promise<LimitResponse>;
  /** App: foreground processes; extension: limited hosts (§8.8 «Usage»). */
  reportUsage(body: UsageReportRequest): Promise<UsageReportResponse>;
  startStudy(body: StartStudyRequest, options?: WriteOptions): Promise<StudySessionResponse>;
  currentStudy(): Promise<CurrentStudyResponse>;
  getStudySession(id: StudySessionId): Promise<StudySessionDetailResponse>;
  studyHeartbeat(id: StudySessionId, body: HeartbeatRequest): Promise<HeartbeatResponse>;
  studyStrike(
    id: StudySessionId,
    body: StrikeRequest,
    options?: WriteOptions,
  ): Promise<StrikeResponse>;
  pauseStudy(id: StudySessionId): Promise<StudySessionResponse>;
  resumeStudy(id: StudySessionId): Promise<StudySessionResponse>;
  endStudy(
    id: StudySessionId,
    body: EndStudyRequest,
    options?: WriteOptions,
  ): Promise<EndStudyResponse>;
  setStudyOutcome(id: StudySessionId, body: StudyOutcomeRequest): Promise<StudySessionResponse>;
  reportAttempt(body: AttemptRequest): Promise<AttemptResponse>;
  getPoints(): Promise<PointsResponse>;
  /** Events pages; a known event with invalid data comes back as `MalformedGuardianEvent`. */
  getEvents(query?: EventsQuery): Promise<EventsResponse>;
  emergencyPreview(blockIds?: readonly BlockId[]): Promise<EmergencyPreviewResponse>;
  requestEmergency(body: EmergencyRequest, options?: WriteOptions): Promise<EmergencyResponse>;
  cancelEmergency(id: EmergencyId): Promise<EmergencyResponse>;
  confirmEmergency(
    id: EmergencyId,
    body: ConfirmEmergencyRequest,
    options?: WriteOptions,
  ): Promise<ConfirmEmergencyResponse>;
  listRewards(): Promise<RewardsResponse>;
  redeemReward(body: RedeemRewardRequest, options?: WriteOptions): Promise<RedeemRewardResponse>;
  getSettings(): Promise<SettingsResponse>;
  updateSettings(body: GuardianSettings): Promise<SettingsResponse>;
  createPairingCode(): Promise<PairingCodeResponse>;
  claimPairing(body: PairingClaimRequest): Promise<PairingClaimResponse>;
  listExtensions(): Promise<PairedExtensionsResponse>;
  revokeExtension(id: ExtensionId): Promise<void>;
  /**
   * Extension rules. Sends a fresh `nonce`, verifies `X-Centrate-Signature` with
   * `rulesPublicKey` and the echoed nonce, and throws `invalid_signature` otherwise (never
   * shrink rules on an unsigned or replayed body) or `stale_rules` when the body is older
   * than `waitVersion` (the version the extension already applied).
   */
  getExtRules(options?: {
    etag?: string | null;
    waitVersion?: number;
    waitMs?: number;
    nonce?: string;
  }): Promise<ExtRulesResult>;
  extHeartbeat(body: ExtHeartbeatRequest): Promise<ExtHeartbeatResponse>;
  nuclearHeartbeat(body: NuclearHeartbeatRequest): Promise<NuclearHeartbeatResponse>;
  deleteData(body: DeleteDataRequest, options?: WriteOptions): Promise<DeleteDataResponse>;
}

interface CallSpec<T> {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema: Schema<T> | null;
  idempotencyKey?: string;
  ifNoneMatch?: string | null;
  extraTimeoutMs?: number;
  auth?: boolean;
}

interface CallResult<T> {
  status: number;
  value: T | null;
  headers: Headers;
  text: string;
}

/**
 * Creates a typed client. Every response body is validated (open mode) before it is
 * returned; errors throw `GuardianApiError`.
 */
export function createGuardianClient(options: GuardianClientOptions = {}): GuardianClient {
  const baseUrl = (options.baseUrl ?? guardianBaseUrl()).replace(/\/+$/, '');
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? GUARDIAN_LIMITS.requestTimeoutMs;
  const newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  const tokenSource = options.token ?? null;
  const rulesPublicKey = options.rulesPublicKey ?? null;

  const resolveToken = async (): Promise<string | null> =>
    typeof tokenSource === 'function' ? await tokenSource() : tokenSource;

  async function send<T>(spec: CallSpec<T>, token: string | null): Promise<CallResult<T>> {
    const url = new URL(baseUrl + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (spec.auth !== false && token !== null) {
      headers[GUARDIAN_HEADERS.authorization] = `Bearer ${token}`;
    }
    if (spec.body !== undefined) headers[GUARDIAN_HEADERS.contentType] = 'application/json';
    if (spec.idempotencyKey !== undefined) {
      headers[GUARDIAN_HEADERS.idempotencyKey] = spec.idempotencyKey;
    }
    if (spec.ifNoneMatch) headers[GUARDIAN_HEADERS.ifNoneMatch] = spec.ifNoneMatch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + (spec.extraTimeoutMs ?? 0));
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url.toString(), {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      text = await response.text();
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new GuardianApiError(
        0,
        aborted ? 'timeout' : 'unreachable',
        aborted ? 'guardian did not answer in time' : 'guardian unreachable',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;
    if (status === 204 || status === 304) {
      return { status, value: null, headers: response.headers, text };
    }
    let json: unknown = undefined;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (status < 200 || status >= 300) {
      if (isGuardianErrorBody(json)) {
        throw new GuardianApiError(status, json.error.code, json.error.message, json.error.details);
      }
      throw new GuardianApiError(status, `http_${status}`, `HTTP ${status}`);
    }
    if (spec.schema === null) return { status, value: null, headers: response.headers, text };
    const checked = validateResponse(spec.schema, json);
    if (!checked.ok) {
      throw new GuardianApiError(status, 'invalid_response', checked.issue.message, {
        path: checked.issue.path,
        issue: checked.issue.issue,
      });
    }
    return { status, value: checked.value, headers: response.headers, text };
  }

  async function call<T>(spec: CallSpec<T>): Promise<CallResult<T>> {
    const token = await resolveToken();
    try {
      return await send(spec, token);
    } catch (error) {
      const retry =
        error instanceof GuardianApiError &&
        error.status === 401 &&
        typeof tokenSource === 'function' &&
        spec.auth !== false;
      if (!retry) throw error;
      return send(spec, await resolveToken());
    }
  }

  async function value<T>(spec: CallSpec<T>): Promise<T> {
    const r = await call(spec);
    if (r.value === null) {
      throw new GuardianApiError(r.status, 'invalid_response', 'empty response body');
    }
    return r.value;
  }

  async function noContent(spec: CallSpec<never>): Promise<void> {
    await call(spec);
  }

  const P = GUARDIAN_PATHS;
  const key = (o?: WriteOptions): string => o?.idempotencyKey ?? newKey();

  return {
    health: () => value({ method: 'GET', path: P.health, schema: healthResponseSchema }),

    async getState(o) {
      const r = await call({
        method: 'GET',
        path: P.state,
        schema: stateResponseSchema,
        ifNoneMatch: o?.etag ?? null,
      });
      const etag = r.headers.get(GUARDIAN_HEADERS.etag);
      if (r.status === 304) return { notModified: true, etag: etag ?? o?.etag ?? null };
      if (r.value === null) throw new GuardianApiError(r.status, 'invalid_response', 'no body');
      return { notModified: false, etag, state: r.value };
    },

    diagnostics: () =>
      value({ method: 'GET', path: P.diagnostics, schema: diagnosticsResponseSchema }),

    createBlock: (body, o) =>
      value({
        method: 'POST',
        path: P.blocks,
        body,
        schema: createBlockResponseSchema,
        idempotencyKey: key(o),
      }),

    listBlocks: (q) =>
      value({
        method: 'GET',
        path: P.blocks,
        query: { status: q?.status, cursor: q?.cursor, limit: q?.limit },
        schema: listBlocksResponseSchema,
      }),

    getBlock: (id) => value({ method: 'GET', path: P.block(id), schema: getBlockResponseSchema }),

    extendBlock: (id, body, o) =>
      value({
        method: 'POST',
        path: P.blockExtend(id),
        body,
        schema: extendBlockResponseSchema,
        idempotencyKey: key(o),
      }),

    listSchedules: () =>
      value({ method: 'GET', path: P.schedules, schema: listSchedulesResponseSchema }),

    createSchedule: (body, o) =>
      value({
        method: 'POST',
        path: P.schedules,
        body,
        schema: scheduleResponseSchema,
        idempotencyKey: key(o),
      }),

    updateSchedule: (id, body) =>
      value({ method: 'PUT', path: P.schedule(id), body, schema: scheduleResponseSchema }),

    deleteSchedule: (id) => noContent({ method: 'DELETE', path: P.schedule(id), schema: null }),

    listLimits: () => value({ method: 'GET', path: P.limits, schema: listLimitsResponseSchema }),

    createLimit: (body, o) =>
      value({
        method: 'POST',
        path: P.limits,
        body,
        schema: limitResponseSchema,
        idempotencyKey: key(o),
      }),

    updateLimit: (id, body) =>
      value({ method: 'PUT', path: P.limit(id), body, schema: limitResponseSchema }),

    deleteLimit: (id) =>
      value({ method: 'DELETE', path: P.limit(id), schema: limitResponseSchema }),

    reportUsage: (body) =>
      value({ method: 'POST', path: P.usage, body, schema: usageReportResponseSchema }),

    startStudy: (body, o) =>
      value({
        method: 'POST',
        path: P.studySessions,
        body,
        schema: studySessionResponseSchema,
        idempotencyKey: key(o),
      }),

    currentStudy: () =>
      value({ method: 'GET', path: P.studyCurrent, schema: currentStudyResponseSchema }),

    getStudySession: (id) =>
      value({
        method: 'GET',
        path: P.studySession(id),
        schema: studySessionDetailResponseSchema,
      }),

    studyHeartbeat: (id, body) =>
      value({ method: 'POST', path: P.studyHeartbeat(id), body, schema: heartbeatResponseSchema }),

    studyStrike: (id, body, o) =>
      value({
        method: 'POST',
        path: P.studyStrike(id),
        body,
        schema: strikeResponseSchema,
        idempotencyKey: key(o),
      }),

    pauseStudy: (id) =>
      value({
        method: 'POST',
        path: P.studyPause(id),
        body: {},
        schema: studySessionResponseSchema,
      }),

    resumeStudy: (id) =>
      value({
        method: 'POST',
        path: P.studyResume(id),
        body: {},
        schema: studySessionResponseSchema,
      }),

    endStudy: (id, body, o) =>
      value({
        method: 'POST',
        path: P.studyEnd(id),
        body,
        schema: endStudyResponseSchema,
        idempotencyKey: key(o),
      }),

    setStudyOutcome: (id, body) =>
      value({
        method: 'POST',
        path: P.studyOutcome(id),
        body,
        schema: studySessionResponseSchema,
      }),

    reportAttempt: (body) =>
      value({ method: 'POST', path: P.attempts, body, schema: attemptResponseSchema }),

    getPoints: () => value({ method: 'GET', path: P.points, schema: pointsResponseSchema }),

    async getEvents(q) {
      const page = await value({
        method: 'GET',
        path: P.events,
        query: { epoch: q?.epoch, after: q?.after, limit: q?.limit, waitMs: q?.waitMs },
        schema: eventsResponseSchema,
        extraTimeoutMs: q?.waitMs ?? 0,
      });
      return {
        ...page,
        events: page.events.map((line) =>
          classifyWireEvent(line as EventEnvelopeBase & { type: string; data: unknown }),
        ),
      };
    },

    emergencyPreview: (blockIds) =>
      value({
        method: 'GET',
        path: P.emergencyPreview,
        query: { blockIds: blockIds && blockIds.length > 0 ? blockIds.join(',') : undefined },
        schema: emergencyPreviewResponseSchema,
      }),

    requestEmergency: (body, o) =>
      value({
        method: 'POST',
        path: P.emergency,
        body,
        schema: emergencyResponseSchema,
        idempotencyKey: key(o),
      }),

    cancelEmergency: (id) =>
      value({
        method: 'POST',
        path: P.emergencyCancel(id),
        body: {},
        schema: emergencyResponseSchema,
      }),

    confirmEmergency: (id, body, o) =>
      value({
        method: 'POST',
        path: P.emergencyConfirm(id),
        body,
        schema: confirmEmergencyResponseSchema,
        idempotencyKey: key(o),
      }),

    listRewards: () => value({ method: 'GET', path: P.rewards, schema: rewardsResponseSchema }),

    redeemReward: (body, o) =>
      value({
        method: 'POST',
        path: P.rewardsRedeem,
        body,
        schema: redeemRewardResponseSchema,
        idempotencyKey: key(o),
      }),

    getSettings: () => value({ method: 'GET', path: P.settings, schema: settingsResponseSchema }),

    updateSettings: (body) =>
      value({ method: 'PUT', path: P.settings, body, schema: settingsResponseSchema }),

    createPairingCode: () =>
      value({ method: 'POST', path: P.pairingCode, body: {}, schema: pairingCodeResponseSchema }),

    claimPairing: (body) =>
      value({
        method: 'POST',
        path: P.pairingClaim,
        body,
        schema: pairingClaimResponseSchema,
        auth: false,
      }),

    listExtensions: () =>
      value({ method: 'GET', path: P.pairingExtensions, schema: pairedExtensionsResponseSchema }),

    revokeExtension: (id) =>
      noContent({ method: 'DELETE', path: P.pairingExtension(id), schema: null }),

    async getExtRules(o) {
      const nonce = o?.nonce ?? newRulesNonce();
      const r = await call({
        method: 'GET',
        path: P.extRules,
        query: { waitVersion: o?.waitVersion, waitMs: o?.waitMs, nonce },
        schema: extRulesResponseSchema,
        ifNoneMatch: o?.etag ?? null,
        extraTimeoutMs: o?.waitMs ?? 0,
      });
      const etag = r.headers.get(GUARDIAN_HEADERS.etag);
      if (r.status === 304) return { notModified: true, etag: etag ?? o?.etag ?? null };
      const signed =
        rulesPublicKey !== null &&
        (await verifyRulesSignature(
          r.text,
          r.headers.get(GUARDIAN_HEADERS.signature),
          rulesPublicKey,
        ));
      if (!signed) {
        throw new GuardianApiError(r.status, 'invalid_signature', 'unsigned or forged rules');
      }
      if (r.value === null) throw new GuardianApiError(r.status, 'invalid_response', 'no body');
      if (r.value.nonce !== nonce) {
        throw new GuardianApiError(r.status, 'invalid_signature', 'replayed rules (nonce)');
      }
      if (o?.waitVersion !== undefined && r.value.extRulesVersion < o.waitVersion) {
        throw new GuardianApiError(r.status, 'stale_rules', 'rules older than the applied ones');
      }
      return { notModified: false, etag, rules: r.value, body: r.text };
    },

    extHeartbeat: (body) =>
      value({ method: 'POST', path: P.extHeartbeat, body, schema: extHeartbeatResponseSchema }),

    nuclearHeartbeat: (body) =>
      value({
        method: 'POST',
        path: P.nuclearHeartbeat,
        body,
        schema: nuclearHeartbeatResponseSchema,
      }),

    deleteData: (body, o) =>
      value({
        method: 'POST',
        path: P.dataDelete,
        body,
        schema: deleteDataResponseSchema,
        idempotencyKey: key(o),
      }),
  };
}

// ---------------------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------------------

/**
 * Settings of a fresh install (the guardian embeds them through `apiContractSnapshot`).
 * `timezone: null` is a template value: the guardian replaces it with the OS IANA zone at
 * its first start (see `GuardianSettings.timezone`).
 */
export const DEFAULT_GUARDIAN_SETTINGS: Readonly<GuardianSettings> = Object.freeze({
  timezone: null,
  dailyGoalMinutes: POINT_RULES.dailyGoalDefaultMinutes,
  attemptPenalties: true,
  punishment: Object.freeze({
    level: STUDY_RULES.defaultPunishmentLevel,
    minutes: STUDY_RULES.punishmentMinutes.default,
  }),
  closeBrowsersWithoutExtension: false,
  serverTimeCheck: true,
  studyWhitelist: Object.freeze({ extraDomains: [], extraProcesses: [] }),
});

/** An empty `TargetSpec`. */
export function emptyTargets(): TargetSpec {
  return { serviceIds: [], categoryIds: [], appIds: [], customDomains: [], customProcesses: [] };
}

/** An empty `WhitelistAllow`. */
export function emptyAllow(): WhitelistAllow {
  return { customDomains: [], customProcesses: [] };
}

/** Milliseconds until `endsAt` from the machine's own clock (the countdown). */
export function remainingMs(endsAt: IsoUtc, nowMs: number = Date.now()): number {
  return Math.max(0, Date.parse(endsAt) - nowMs);
}

// ---------------------------------------------------------------------------------------
// Semantic checks shared by the app and the guardian (Go ports them; vectors in
// test/fixtures/catalog-vectors.json)
// ---------------------------------------------------------------------------------------

/**
 * The error code a request-shape `ValidationIssue` maps to (§8.1): `unknown_field` → 400
 * `unknown_field`; `protected_process` → 422 `protected_target`; a `range` issue on
 * `durationMinutes` → 422 `duration_out_of_range` (details `{minMinutes, maxMinutes}`,
 * like `endsAt`); a `pattern`, `rule` or `length` issue on a `timezone` → 422
 * `invalid_timezone`; anything else (type, required, enum, …) → 422 `validation_failed`.
 */
export function validationErrorCode(problem: ValidationIssue): GuardianErrorCode {
  if (problem.issue === 'unknown_field') return 'unknown_field';
  if (problem.issue === 'protected_process') return 'protected_target';
  if (problem.path === 'durationMinutes' && problem.issue === 'range') {
    return 'duration_out_of_range';
  }
  if (
    /(?:^|\.)timezone$/.test(problem.path) &&
    (problem.issue === 'pattern' || problem.issue === 'rule' || problem.issue === 'length')
  ) {
    return 'invalid_timezone';
  }
  return 'validation_failed';
}

/** User text fields and the issue their request validator reports (`null` when valid). */
export function textFieldIssue(
  field: 'reason' | 'task' | 'scheduleName' | 'phrase',
  value: unknown,
): ValidationIssueKind | null {
  const schema =
    field === 'reason'
      ? reasonText
      : field === 'task'
        ? taskText
        : field === 'scheduleName'
          ? scheduleNameText
          : phraseText;
  return schema.check(value, field, { strict: true })?.issue ?? null;
}

/**
 * True for a multi-label public suffix such as `co.uk` or `com.br` (canonical input): the
 * catalog's `MULTI_LABEL_SUFFIXES`, which the guardian embeds too.
 */
export function isPublicSuffixLike(domain: string): boolean {
  return isMultiLabelPublicSuffix(domain);
}

/** Domains of catalog services that belong to at least one category (distractions). */
const DISTRACTION_SERVICE_DOMAINS: ReadonlyArray<{ domain: string; serviceId: string }> =
  SERVICES.filter((service) => service.categories.length > 0).flatMap((service) =>
    service.domains.map((domain) => ({ domain, serviceId: service.id })),
  );

const PLATFORMS: readonly CatalogPlatform[] = ['win', 'mac', 'linux'];

/** Catalog apps blocked by some category: apps of categorized services and category apps. */
const DISTRACTION_APP_KEYS: Readonly<Record<CatalogPlatform, ReadonlyMap<string, string>>> =
  (() => {
    const appIds = new Set<string>();
    for (const service of SERVICES) {
      if (service.categories.length > 0) for (const id of service.appIds ?? []) appIds.add(id);
    }
    for (const category of CATEGORIES) for (const id of category.appIds ?? []) appIds.add(id);
    const build = (platform: CatalogPlatform): Map<string, string> => {
      const map = new Map<string, string>();
      for (const app of APPS) {
        if (!appIds.has(app.id)) continue;
        for (const name of app.processes[platform]) map.set(processNameKey(name, platform), app.id);
      }
      return map;
    };
    return { win: build('win'), mac: build('mac'), linux: build('linux') };
  })();

/** Why an allow entry was refused (`details` of 422 `allow_distraction`). */
export interface AllowDistraction {
  path: string;
  reason: 'service_domain' | 'parent_of_service_domain' | 'public_suffix' | 'distraction_app';
  serviceId: string | null;
  appId: string | null;
}

function domainDistraction(d: string, path: string): AllowDistraction | null {
  if (isPublicSuffixLike(d)) return { path, reason: 'public_suffix', serviceId: null, appId: null };
  const owner = findServiceByDomain(d);
  if (owner && owner.categories.length > 0) {
    return { path, reason: 'service_domain', serviceId: owner.id, appId: null };
  }
  for (const entry of DISTRACTION_SERVICE_DOMAINS) {
    if (entry.domain !== d && isSameOrSubdomain(entry.domain, d)) {
      return { path, reason: 'parent_of_service_domain', serviceId: entry.serviceId, appId: null };
    }
  }
  return null;
}

function processDistraction(
  name: string,
  path: string,
  platforms: readonly CatalogPlatform[],
): AllowDistraction | null {
  for (const platform of platforms) {
    const appId = DISTRACTION_APP_KEYS[platform].get(processNameKey(name, platform));
    if (appId !== undefined) return { path, reason: 'distraction_app', serviceId: null, appId };
  }
  return null;
}

/**
 * The single «no distractions in a whitelist» check, used for block and schedule `allow`
 * and for `settings.studyWhitelist` (422 `allow_distraction`). It rejects a domain that
 * is a multi-label public suffix, equals or is under a domain of a catalog service with
 * at least one category (a service's `excludedSubdomains` stay allowed), or is a parent
 * of one (`googleapis.com` would allow `youtubei.googleapis.com`); and a process name of
 * a catalog app that some category blocks. Processes are checked on every platform
 * unless `platform` is given (the guardian passes its own). The guardian also re-checks
 * whitelist snapshots against its embedded catalog and drops offending entries, since a
 * catalog update can add services.
 */
export function findAllowDistraction(
  entries: { domains: readonly string[]; processes: readonly string[] },
  paths: { domains: string; processes: string },
  platform?: CatalogPlatform,
): AllowDistraction | null {
  for (let i = 0; i < entries.domains.length; i += 1) {
    const found = domainDistraction(entries.domains[i] ?? '', `${paths.domains}[${i}]`);
    if (found) return found;
  }
  const platforms = platform === undefined ? PLATFORMS : [platform];
  for (let i = 0; i < entries.processes.length; i += 1) {
    const found = processDistraction(
      entries.processes[i] ?? '',
      `${paths.processes}[${i}]`,
      platforms,
    );
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Daily limits (§5.10): pure rules shared by the app and the guardian (Go ports them;
// vectors in test/fixtures/limits-vectors.json)
// ---------------------------------------------------------------------------------------

/** Every ISO weekday: the default `days` of a new limit. */
export const ALL_WEEKDAYS: readonly IsoWeekday[] = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

/** Rank for «stricter»: `normal` 0 < `strict` 1 < `hardcore` 2. */
export function limitModeRank(mode: LimitMode): number {
  return LIMIT_MODES.indexOf(mode);
}

const TARGET_LISTS = [
  'serviceIds',
  'categoryIds',
  'appIds',
  'customDomains',
  'customProcesses',
] as const satisfies readonly (keyof TargetSpec)[];

function unionList<T>(first: readonly T[], second: readonly T[]): T[] {
  const out = [...first];
  for (const item of second) if (!out.includes(item)) out.push(item);
  return out;
}

function sortedDays(days: readonly IsoWeekday[]): IsoWeekday[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * True when `next` weakens `prev`: a higher `dailyMinutes`, a target entry or a day of
 * `prev` missing from `next`, a lower mode rank, or `enabled` true → false. `name` and
 * `reason` are neutral.
 */
export function limitDefinitionWeakens(
  next: DailyLimitDefinition,
  prev: DailyLimitDefinition,
): boolean {
  if (next.dailyMinutes > prev.dailyMinutes) return true;
  if (prev.enabled && !next.enabled) return true;
  if (limitModeRank(next.mode) < limitModeRank(prev.mode)) return true;
  if (prev.days.some((d) => !next.days.includes(d))) return true;
  return TARGET_LISTS.some((list) =>
    (prev.targets[list] as readonly string[]).some(
      (entry) => !(next.targets[list] as readonly string[]).includes(entry),
    ),
  );
}

/**
 * How a `PUT /v1/limits/{id}` splits (§5.10). `applied` becomes effective at once: the
 * requested `name` and `reason`, the lower `dailyMinutes`, the union of targets (effective
 * entries first, then the new ones in request order) and of days (sorted), the stricter
 * mode, and `enabled` if either is. `pending` is the requested definition (days sorted)
 * when it still weakens `applied`, else `null` (which also cancels an older pending change).
 */
export function splitLimitChange(
  effective: DailyLimitDefinition,
  requested: DailyLimitDefinition,
): { applied: DailyLimitDefinition; pending: DailyLimitDefinition | null } {
  const targets: TargetSpec = {
    serviceIds: unionList(effective.targets.serviceIds, requested.targets.serviceIds),
    categoryIds: unionList(effective.targets.categoryIds, requested.targets.categoryIds),
    appIds: unionList(effective.targets.appIds, requested.targets.appIds),
    customDomains: unionList(effective.targets.customDomains, requested.targets.customDomains),
    customProcesses: unionList(
      effective.targets.customProcesses,
      requested.targets.customProcesses,
    ),
  };
  const applied: DailyLimitDefinition = {
    name: requested.name,
    enabled: effective.enabled || requested.enabled,
    targets,
    dailyMinutes: Math.min(effective.dailyMinutes, requested.dailyMinutes),
    days: sortedDays([...effective.days, ...requested.days]),
    mode:
      limitModeRank(requested.mode) > limitModeRank(effective.mode)
        ? requested.mode
        : effective.mode,
    reason: requested.reason,
  };
  const normalized: DailyLimitDefinition = { ...requested, days: sortedDays(requested.days) };
  return {
    applied,
    pending: limitDefinitionWeakens(normalized, applied) ? normalized : null,
  };
}

/**
 * Whether replacing the pending change `prev` by `next` keeps the delay already run (else
 * it restarts at `limitWeakeningDelayMs`). `null` is a pending deletion, the weakest of all.
 * The delay is kept when `next` weakens nothing relative to `prev`, so a retried or
 * stricter request never postpones a change.
 */
export function pendingLimitDelayKept(
  prev: DailyLimitDefinition | null,
  next: DailyLimitDefinition | null,
): boolean {
  if (next === null) return prev === null;
  if (prev === null) return true;
  return !limitDefinitionWeakens(next, prev);
}

/**
 * The per-client clamp of a usage report (§10.13): the interval it may cover is at most
 * the boot-clock time since that client's previous accepted report plus `usageSlackMs`
 * (`sinceLastMs` is `null` for its first report since the guardian started).
 */
export function clampUsageInterval(
  intervalMs: number,
  sinceLastMs: number | null,
  slackMs: number = GUARDIAN_LIMITS.usageSlackMs,
): number {
  const bound = sinceLastMs === null ? intervalMs : Math.max(0, sinceLastMs) + slackMs;
  return Math.max(0, Math.min(intervalMs, bound));
}

/**
 * Milliseconds one report adds to one limit (§10.13), all in trusted Unix ms. The report
 * covers `[nowMs − intervalMs, nowMs]` (the interval already clamped per client), cut at
 * the start of the current local day. Only time after the limit's watermark
 * `creditedUntilMs` (minus `slackMs` of jitter tolerance) can be credited, so each trusted
 * millisecond counts at most once per limit whichever clients report it. `reportedMs` is
 * the sum of the report's matching items for this limit (seconds × 1000). The watermark
 * moves to `nowMs` whenever something was credited.
 */
export function limitUsageCredit(input: {
  nowMs: number;
  dayStartMs: number;
  intervalMs: number;
  reportedMs: number;
  creditedUntilMs: number;
  slackMs?: number;
}): { creditMs: number; creditedUntilMs: number } {
  const slack = input.slackMs ?? GUARDIAN_LIMITS.usageSlackMs;
  const windowStart = Math.max(input.nowMs - input.intervalMs, input.dayStartMs);
  const from = Math.max(windowStart, input.creditedUntilMs - slack);
  const free = Math.max(0, input.nowMs - from);
  const creditMs = Math.max(0, Math.min(input.reportedMs, free, input.intervalMs));
  return {
    creditMs,
    creditedUntilMs:
      creditMs > 0 ? Math.max(input.creditedUntilMs, input.nowMs) : input.creditedUntilMs,
  };
}

/** The `DailyLimitInput` that re-sends a limit's effective definition (cancels a pending change). */
export function limitInputFromLimit(
  limit: DailyLimitDefinition,
  acknowledgeNoEmergency: boolean = limit.mode === 'hardcore',
): DailyLimitInput {
  return {
    name: limit.name,
    enabled: limit.enabled,
    targets: {
      serviceIds: [...limit.targets.serviceIds],
      categoryIds: [...limit.targets.categoryIds],
      appIds: [...limit.targets.appIds],
      customDomains: [...limit.targets.customDomains],
      customProcesses: [...limit.targets.customProcesses],
    },
    dailyMinutes: limit.dailyMinutes,
    days: [...limit.days],
    mode: limit.mode,
    reason: limit.reason,
    acknowledgeNoEmergency,
  };
}

/** Dedupe key of an extension detection (`attempt.targetKey`). */
export function domainTargetKey(host: string): string {
  const service = findServiceByDomain(host);
  if (service) return `svc:${service.id}`;
  return `dom:${host.startsWith('www.') ? host.slice(4) : host}`;
}

/** Dedupe key of a window-title detection. */
export function serviceTargetKey(serviceId: string): string {
  return `svc:${serviceId}`;
}

/** Dedupe key of a process detection on `platform`. */
export function processTargetKey(name: string, platform: CatalogPlatform): string {
  const service = findServiceByProcessName(name, platform);
  if (service) return `svc:${service.id}`;
  const app = findAppByProcessName(name, platform);
  if (app) return `app:${app.id}`;
  return `proc:${processNameKey(name, platform)}`;
}

/** Everything about the API the guardian embeds (`guardian/internal/embedded/api.json`). */
export function apiContractSnapshot(): {
  apiVersion: number;
  defaultPort: number;
  limits: typeof GUARDIAN_LIMITS;
  responseLimits: typeof RESPONSE_LIMITS;
  endpoints: EndpointSpec[];
  errors: Record<GuardianErrorCode, number>;
  capabilities: string[];
  problems: string[];
  dataDeleteConfirmWords: string[];
  chromiumExtensionId: string;
  defaultSettings: GuardianSettings;
} {
  return JSON.parse(
    JSON.stringify({
      apiVersion: GUARDIAN_API_VERSION,
      defaultPort: DEFAULT_GUARDIAN_PORT,
      limits: GUARDIAN_LIMITS,
      responseLimits: RESPONSE_LIMITS,
      endpoints: GUARDIAN_ENDPOINTS,
      errors: GUARDIAN_ERROR_STATUS,
      capabilities: GUARDIAN_CAPABILITIES,
      problems: GUARDIAN_PROBLEMS,
      dataDeleteConfirmWords: DATA_DELETE_CONFIRM_WORDS,
      chromiumExtensionId: CHROMIUM_EXTENSION_ID,
      defaultSettings: DEFAULT_GUARDIAN_SETTINGS,
    }),
  ) as ReturnType<typeof apiContractSnapshot>;
}
