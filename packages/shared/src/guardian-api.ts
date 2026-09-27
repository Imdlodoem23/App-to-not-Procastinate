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
import type { CategoryId } from './catalog';
import { CATEGORY_IDS, isProtectedProcessName, isValidDomain, isValidProcessName } from './catalog';
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
  EmergencyId,
  EmergencyUnlock,
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
  PendingSettingChange,
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
  GUARDIAN_MODES,
  HEARTBEAT_STATES,
  ID_PREFIXES,
  PUNISHMENT_CAUSES,
  PUNISHMENT_LEVELS,
  PUNISHMENT_STATUSES,
  REWARDS_LOCK_REASONS,
  STRIKE_CAUSES,
  STUDY_OUTCOMES,
  STUDY_PHASES,
  STUDY_STATUSES,
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
  blocksPageMax: 100,
  heartbeatMaxFocusMs: 600_000,
  idempotencyTtlMs: 600_000,
  idempotencyKeyMaxLength: 128,
  pairingCodeTtlMs: 300_000,
  pairingMaxFailures: 5,
  pairingClaimsPerWindow: 20,
  pairingClaimWindowMs: 600_000,
  extRulesAlarmMs: 30_000,
  extHeartbeatIntervalMs: 30_000,
  /** An extension is "connected" if it sent a heartbeat within this window. */
  extConnectedWindowMs: 90_000,
  /** A browser running this long without a connected extension is reported (or closed). */
  browserWithoutExtensionGraceMs: 60_000,
  /** `/v1/state.recent.endedBlocks` keeps blocks that ended within this window. */
  recentEndedBlocksMs: 120_000,
  emergencyMaxBlocks: 50,
  phraseMaxLength: 400,
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
] as const;
export type GuardianCapability = (typeof GUARDIAN_CAPABILITIES)[number];

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
  studySessions: '/v1/study/sessions',
  studyCurrent: '/v1/study/sessions/current',
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
  ep('startStudy', 'POST', '/v1/study/sessions', 'app', { idem: true }),
  ep('currentStudy', 'GET', '/v1/study/sessions/current', 'app'),
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

/** Errors produced by the client itself (no HTTP response, or an unusable one). */
export type GuardianClientErrorCode =
  'unreachable' | 'timeout' | 'invalid_response' | 'invalid_signature';

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
  browser: BrowserFamily;
  extVersion: string;
  connected: boolean;
  lastSeenAt: IsoUtc | null;
  incognitoAllowed: boolean;
  hostPermission: boolean;
  appliedRulesVersion: number;
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
  points: PointsSummary;
  pendingSettings: PendingSettingChange[];
  recent: { endedBlocks: EndedBlockNotice[] };
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
  /** For `ended`: return blocks that ended before this instant (pagination cursor). */
  before?: IsoUtc;
  limit?: number;
}

export interface ListBlocksResponse {
  blocks: Block[];
  nextBefore: IsoUtc | null;
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
  cameraOn: boolean;
}

export interface HeartbeatResponse {
  duplicate: boolean;
  /** min(focusedMsSinceLast, work-phase awake time since the previous heartbeat). */
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
  pointsDelta: number;
  cooldownUntil: IsoUtc | null;
  /** Set when this strike triggered the punishment (3rd strike). */
  punishment: Punishment | null;
  session: StudySession;
}

export interface EndStudyRequest {
  reason: 'user';
}

export interface StudySummary {
  outcome: 'completed' | 'ended_early' | 'abandoned' | 'punished';
  activeMinutes: number;
  focusedMinutes: number;
  /** round(100 × focused / active work minutes), 0 when there was no work time. */
  focusPct: number;
  strikes: number;
  attempts: number;
  /** Net points of the session (focus + bonus − strikes − punishment). */
  pointsTotal: number;
  cleanBonus: number;
}

export interface EndStudyResponse {
  session: StudySession;
  summary: StudySummary;
}

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
  block: { id: BlockId; kind: BlockKind; mode: BlockMode; endsAt: IsoUtc; reason: string } | null;
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

export interface EventsResponse {
  epoch: EpochId;
  reset: boolean;
  events: WireEvent[];
  lastSeq: number;
  hasMore: boolean;
}

export interface EmergencyPreviewResponse {
  eligible: boolean;
  reason: 'hardcore' | 'exam' | 'no_active_blocks' | 'emergency_in_progress' | null;
  blockIds: BlockId[];
  /** Hardcore and exam blocks that stay active regardless. */
  excludedBlockIds: BlockId[];
  countdownMinutes: number | null;
  penaltyPoints: number;
  balance: number;
  streakDays: number;
  phrase: string;
}

export interface EmergencyRequest {
  blockIds: BlockId[];
  phrase: string;
  language: 'es' | 'en';
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
  unavailableReason: 'not_blocked' | 'insufficient_points' | 'locked' | null;
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
  kind: BlockKind;
  mode: BlockMode;
  endsAt: IsoUtc;
  reason: string;
  /** Catalog services it blocks (categories expanded), for «YouTube: bloqueado». */
  serviceIds: string[];
  /** Resolved hosts; `[]` for whitelist-only blocks. */
  domains: string[];
  whitelistOnly: boolean;
}

export interface ExtWhitelistRules {
  /** Allowed hosts; each also allows its subdomains. */
  allowDomains: string[];
  /** RE2 sources matched against the whole host (`^…$`), from catalog `hostPatterns`. */
  allowHostPatterns: string[];
}

export interface ExtRulesResponse {
  rulesVersion: number;
  serverNow: IsoUtc;
  /** Effective set: every block's domains − allowances − whitelist allow set. */
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
  punishment: { endsAt: IsoUtc; level: PunishmentLevel } | null;
  /** Earliest end among blocks and allowances (the extension sets an alarm). */
  nextChangeAt: IsoUtc | null;
  penaltiesEnabled: boolean;
}

export interface ExtHeartbeatRequest {
  extVersion: string;
  browser: BrowserFamily;
  browserVersion: string;
  incognitoAllowed: boolean;
  hostPermission: boolean;
  appliedRulesVersion: number;
}

export interface ExtHeartbeatResponse {
  rulesVersion: number;
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

function str(opts: {
  min?: number;
  max: number;
  pattern?: RegExp;
  text?: boolean;
}): Schema<string> {
  const min = opts.min ?? 0;
  return make((v, p) => {
    if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
    if (v.length < min || v.length > opts.max) {
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
}

function idOf<K extends IdKind>(kind: K): Schema<IdTypes[K]> {
  return make((v, p) =>
    isIdOf(kind, v)
      ? null
      : issue(p, v === undefined ? 'required' : 'pattern', `${ID_PREFIXES[kind]}_ id`),
  );
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const iso: Schema<IsoUtc> = make((v, p) => {
  if (typeof v !== 'string') return issue(p, v === undefined ? 'required' : 'type', 'string');
  return ISO_RE.test(v) && Number.isFinite(Date.parse(v))
    ? null
    : issue(p, 'pattern', 'ISO 8601 UTC timestamp');
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

function targetSpecSchema(process: Schema<string>): Schema<TargetSpec> {
  return obj<TargetSpec>({
    serviceIds: arr(catalogId, { max: L.maxIdsPerList, unique: true }),
    categoryIds: arr(categoryId, { max: CATEGORY_IDS.length, unique: true }),
    appIds: arr(catalogId, { max: L.maxIdsPerList, unique: true }),
    customDomains: arr(domain, { max: L.maxCustomDomains, unique: true }),
    customProcesses: arr(process, { max: L.maxCustomProcesses, unique: true }),
  });
}

function whitelistAllowSchema(process: Schema<string>): Schema<WhitelistAllow> {
  return obj<WhitelistAllow>({
    customDomains: arr(domain, { max: L.maxCustomDomains, unique: true }),
    customProcesses: arr(process, { max: L.maxCustomProcesses, unique: true }),
  });
}

const targetSpecIn = targetSpecSchema(processName);
const targetSpecOut = targetSpecSchema(anyProcessName);
const allowIn = whitelistAllowSchema(processName);
const allowOut = whitelistAllowSchema(anyProcessName);

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
  policy: punishmentPolicySchema,
  achieved: nullable(oneOf(ACHIEVED_VALUES)),
});

export const punishmentSchema: Schema<Punishment> = obj<Punishment>({
  id: idOf('punishment'),
  blockId: idOf('block'),
  sessionId: nullable(idOf('study')),
  cause: oneOf(PUNISHMENT_CAUSES),
  level: punishmentLevel,
  minutes: int(1, 1440),
  startsAt: iso,
  endsAt: iso,
  status: oneOf(PUNISHMENT_STATUSES),
  endedAt: nullable(iso),
});

export const emergencySchema: Schema<EmergencyUnlock> = obj<EmergencyUnlock>({
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
});

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

function pendingField<K extends keyof GuardianSettings>(
  field: K,
  value: Schema<GuardianSettings[K]>,
): Schema<{ field: K; value: GuardianSettings[K]; effectiveAt: IsoUtc }> {
  return obj<{ field: K; value: GuardianSettings[K]; effectiveAt: IsoUtc }>({
    field: literal(field),
    value,
    effectiveAt: iso,
  });
}

export const pendingSettingSchema: Schema<PendingSettingChange> = tagged('field', {
  timezone: pendingField('timezone', timezoneOrNull),
  dailyGoalMinutes: pendingField('dailyGoalMinutes', dailyGoal),
  attemptPenalties: pendingField('attemptPenalties', bool),
  punishment: pendingField('punishment', punishmentPolicySchema),
  closeBrowsersWithoutExtension: pendingField('closeBrowsersWithoutExtension', bool),
  serverTimeCheck: pendingField('serverTimeCheck', bool),
  studyWhitelist: pendingField('studyWhitelist', studyWhitelistSchema(anyProcessName)),
});

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

const blockIdList = arr(idOf('block'), { max: 10_000, unique: true });
const targetKey = str({ min: 5, max: 300, pattern: /^(?:svc|app|dom|proc):\S+$/ });

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
    reason: oneOf(['install', 'data_deleted', 'log_unreadable'] as const),
    previousEpoch: nullable(idOf('epoch')),
    carryOverBalance: int(-SAFE, 0),
    escalation: escalationSchema,
    kept: obj<EpochKeptState>({
      blocks: arr(blockSchema, { max: 10_000 }),
      punishments: arr(punishmentSchema, { max: 1000 }),
      allowances: arr(allowanceSchema, { max: 1000 }),
      schedules: arr(scheduleSchema, { max: 1000 }),
      settings: settingsOut,
      pendingSettings: arr(pendingSettingSchema, { max: 16 }),
    }),
  }),
  clock_jump: obj<Data<'clock_jump'>>({
    source: oneOf(CLOCK_JUMP_SOURCES),
    deltaMs: signed,
    wallOffsetMs: signed,
    trust: oneOf(CLOCK_TRUST_LEVELS),
    reactivatedBlockIds: blockIdList,
  }),
  day_closed: obj<Data<'day_closed'>>({ day: localDay, goalMinutes: dailyGoal }),
  block_created: obj<Data<'block_created'>>({
    block: blockSchema,
    source: oneOf(['user', 'schedule', 'punishment'] as const),
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
    focusedMinutes: count,
    strikes: count,
    attempts: count,
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
    penalty: count,
    streakDaysLost: count,
    goalMinutes: dailyGoal,
  }),
  reward_redeemed: obj<Data<'reward_redeemed'>>({
    allowanceId: idOf('allowance'),
    offerId: catalogId,
    serviceId: catalogId,
    minutes: int(1, 1440),
    cost: count,
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
  settings_changed: obj<Data<'settings_changed'>>({
    settings: settingsOut,
    pending: arr(pendingSettingSchema, { max: 16 }),
  }),
  extension_paired: obj<Data<'extension_paired'>>({
    extensionId: idOf('extension'),
    browser: browserFamily,
    boundOrigin: nullable(str({ min: 1, max: 200 })),
  }),
  extension_revoked: obj<Data<'extension_revoked'>>({ extensionId: idOf('extension') }),
  tamper_detected: obj<Data<'tamper_detected'>>({
    kind: oneOf([
      'hosts',
      'hosts_locked',
      'hosts_path_overridden',
      'state_mac',
      'ledger_rollback',
    ] as const),
    balanceCorrection: int(-SAFE, 0),
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

/**
 * One event line as served by `/v1/events`: the envelope is always checked; the payload
 * is checked for known types and must be an object for unknown (newer) ones.
 */
export const wireEventSchema: Schema<WireEvent> = make((v, p, ctx) => {
  const r = envelopeSchema.check(v, p, { strict: false });
  if (r) return r;
  const record = v as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
    return issue(child(p, 'type'), type === undefined ? 'required' : 'pattern', 'event type');
  }
  const data = record['data'];
  if (isEventType(type)) {
    return (eventDataSchemas[type] as Schema<unknown>).check(data, child(p, 'data'), ctx);
  }
  return isRecord(data) ? null : issue(child(p, 'data'), 'type', 'object');
});

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
    name: str({ min: 1, max: L.scheduleNameMaxLength, text: true }),
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

export const startStudyRequestSchema: Schema<StartStudyRequest> = obj<StartStudyRequest>({
  task: str({ max: L.taskMaxLength, text: true }),
  plannedMinutes: int(STUDY_RULES.plannedMinutes.min, STUDY_RULES.plannedMinutes.max),
  pomodoro: nullable(pomodoroSchema),
  camera: bool,
});

export const heartbeatRequestSchema: Schema<HeartbeatRequest> = obj<HeartbeatRequest>({
  seq: int(1, I32),
  state: oneOf(HEARTBEAT_STATES),
  focusScore: nullable(int(0, 100)),
  focusedMsSinceLast: int(0, L.heartbeatMaxFocusMs),
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

export const emergencyRequestSchema: Schema<EmergencyRequest> = obj<EmergencyRequest>({
  blockIds: arr(idOf('block'), { min: 1, max: L.emergencyMaxBlocks, unique: true }),
  phrase: str({ min: 1, max: L.phraseMaxLength }),
  language: oneOf(['es', 'en'] as const),
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
  appliedRulesVersion: count,
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
});

const extensionStatusSchema: Schema<ExtensionStatus> = obj<ExtensionStatus>({
  id: idOf('extension'),
  browser: browserFamily,
  extVersion: versionString,
  connected: bool,
  lastSeenAt: nullable(iso),
  incognitoAllowed: bool,
  hostPermission: bool,
  appliedRulesVersion: count,
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

const manyBlocks = arr(blockSchema, { max: 10_000 });

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
  punishments: arr(punishmentSchema, { max: 1000 }),
  nuclearActive: bool,
  study: nullable(studySessionSchema),
  emergency: nullable(emergencySchema),
  allowances: arr(allowanceSchema, { max: 1000 }),
  rewardsLock: nullable(oneOf(REWARDS_LOCK_REASONS)),
  nextSchedule: nullable(
    obj<NextScheduleInfo>({
      scheduleId: idOf('schedule'),
      name: str({ min: 1, max: L.scheduleNameMaxLength }),
      startsAt: iso,
      endsAt: iso,
    }),
  ),
  points: pointsSummarySchema,
  pendingSettings: arr(pendingSettingSchema, { max: 16 }),
  recent: obj<GuardianStateResponse['recent']>({
    endedBlocks: arr(endedBlockSchema, { max: 1000 }),
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

export const listBlocksResponseSchema: Schema<ListBlocksResponse> = obj<ListBlocksResponse>({
  blocks: manyBlocks,
  nextBefore: nullable(iso),
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
    schedules: arr(scheduleSchema, { max: 1000 }),
  });

export const studySessionResponseSchema: Schema<StudySessionResponse> = obj<StudySessionResponse>({
  session: studySessionSchema,
});

export const currentStudyResponseSchema: Schema<CurrentStudyResponse> = obj<CurrentStudyResponse>({
  session: nullable(studySessionSchema),
});

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
  cooldownUntil: nullable(iso),
  punishment: nullable(punishmentSchema),
  session: studySessionSchema,
});

export const endStudyResponseSchema: Schema<EndStudyResponse> = obj<EndStudyResponse>({
  session: studySessionSchema,
  summary: obj<StudySummary>({
    outcome: oneOf(STUDY_OUTCOMES),
    activeMinutes: count,
    focusedMinutes: count,
    focusPct: int(0, 100),
    strikes: count,
    attempts: count,
    pointsTotal: signed,
    cleanBonus: count,
  }),
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
    }),
  ),
  reason: nullable(oneOf(['not_blocked', 'allowance_active'] as const)),
});

export const pointsResponseSchema: Schema<PointsResponse> = obj<PointsResponse>({
  points: pointsSummarySchema,
});

export const eventsResponseSchema: Schema<EventsResponse> = obj<EventsResponse>({
  epoch: idOf('epoch'),
  reset: bool,
  events: arr(wireEventSchema, { max: L.eventsPageMax }),
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
    streakDays: count,
    phrase: str({ min: 1, max: L.phraseMaxLength }),
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
      unavailableReason: nullable(oneOf(['not_blocked', 'insufficient_points', 'locked'] as const)),
    }),
    { max: 1000 },
  ),
  allowances: arr(allowanceSchema, { max: 1000 }),
});

export const redeemRewardResponseSchema: Schema<RedeemRewardResponse> = obj<RedeemRewardResponse>({
  allowance: allowanceSchema,
  pointsDelta: int(-SAFE, 0),
  balanceAfter: signed,
});

export const settingsResponseSchema: Schema<SettingsResponse> = obj<SettingsResponse>({
  settings: settingsOut,
  pending: arr(pendingSettingSchema, { max: 16 }),
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

export const extRulesResponseSchema: Schema<ExtRulesResponse> = obj<ExtRulesResponse>({
  rulesVersion: count,
  serverNow: iso,
  blockDomains: arr(domain, { max: 100_000 }),
  excludedDomains: arr(domain, { max: 100_000 }),
  whitelist: nullable(
    obj<ExtWhitelistRules>({
      allowDomains: arr(domain, { max: 100_000 }),
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
      serviceIds: arr(catalogId, { max: 10_000 }),
      domains: arr(domain, { max: 100_000 }),
      whitelistOnly: bool,
    }),
    { max: 10_000 },
  ),
  allowances: arr(
    obj<{ serviceId: string; endsAt: IsoUtc }>({ serviceId: catalogId, endsAt: iso }),
    { max: 1000 },
  ),
  punishment: nullable(
    obj<{ endsAt: IsoUtc; level: PunishmentLevel }>({ endsAt: iso, level: punishmentLevel }),
  ),
  nextChangeAt: nullable(iso),
  penaltiesEnabled: bool,
});

export const extHeartbeatResponseSchema: Schema<ExtHeartbeatResponse> = obj<ExtHeartbeatResponse>({
  rulesVersion: count,
  serverNow: iso,
});

export const deleteDataResponseSchema: Schema<DeleteDataResponse> = obj<DeleteDataResponse>({
  epoch: idOf('epoch'),
  carryOverBalance: int(-SAFE, 0),
  keptBlockIds: blockIdList,
  keptPunishmentIds: arr(idOf('punishment'), { max: 10_000, unique: true }),
  keptScheduleIds: arr(idOf('schedule'), { max: 10_000, unique: true }),
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
export const isDeleteDataRequest = requestGuard(deleteDataRequestSchema);
export const isTestClockRequest = requestGuard(testClockRequestSchema);

export const isGuardianErrorBody = responseGuard(errorBodySchema);
export const isHealthResponse = responseGuard(healthResponseSchema);
export const isStateResponse = responseGuard(stateResponseSchema);
export const isDiagnosticsResponse = responseGuard(diagnosticsResponseSchema);
export const isBlock = responseGuard(blockSchema);
export const isSchedule = responseGuard(scheduleSchema);
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
export const isStudySessionResponse = responseGuard(studySessionResponseSchema);
export const isCurrentStudyResponse = responseGuard(currentStudyResponseSchema);
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
export const isDeleteDataResponse = responseGuard(deleteDataResponseSchema);

// ---------------------------------------------------------------------------------------
// Extension rules signature (HMAC-SHA256, WebCrypto)
// ---------------------------------------------------------------------------------------

const SIGNATURE_PREFIX = 'v1=';

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

async function hmacKey(token: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/**
 * `X-Centrate-Signature` value for a rules body: `v1=` + base64url(HMAC-SHA256(key =
 * UTF-8 token, message = the exact body bytes)). The guardian computes it in Go; this is
 * for tests and the dev harness.
 */
export async function computeRulesSignature(body: string, token: string): Promise<string> {
  const key = await hmacKey(token, 'sign');
  const mac = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return SIGNATURE_PREFIX + base64UrlEncode(new Uint8Array(mac));
}

/** Verifies a rules body against its signature header (constant-time via WebCrypto). */
export async function verifyRulesSignature(
  body: string,
  header: string | null,
  token: string,
): Promise<boolean> {
  if (header === null || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const signature = base64UrlDecode(header.slice(SIGNATURE_PREFIX.length));
  if (signature === null || signature.length !== 32) return false;
  const key = await hmacKey(token, 'verify');
  return globalThis.crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(body));
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
  startStudy(body: StartStudyRequest, options?: WriteOptions): Promise<StudySessionResponse>;
  currentStudy(): Promise<CurrentStudyResponse>;
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
   * Extension rules. Verifies `X-Centrate-Signature` with the client token and throws
   * `invalid_signature` when it does not match: never shrink rules on an unsigned body.
   */
  getExtRules(options?: {
    etag?: string | null;
    waitVersion?: number;
    waitMs?: number;
  }): Promise<ExtRulesResult>;
  extHeartbeat(body: ExtHeartbeatRequest): Promise<ExtHeartbeatResponse>;
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
        query: { status: q?.status, before: q?.before, limit: q?.limit },
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

    getEvents: (q) =>
      value({
        method: 'GET',
        path: P.events,
        query: { epoch: q?.epoch, after: q?.after, limit: q?.limit, waitMs: q?.waitMs },
        schema: eventsResponseSchema,
        extraTimeoutMs: q?.waitMs ?? 0,
      }),

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
      const r = await call({
        method: 'GET',
        path: P.extRules,
        query: { waitVersion: o?.waitVersion, waitMs: o?.waitMs },
        schema: extRulesResponseSchema,
        ifNoneMatch: o?.etag ?? null,
        extraTimeoutMs: o?.waitMs ?? 0,
      });
      const etag = r.headers.get(GUARDIAN_HEADERS.etag);
      if (r.status === 304) return { notModified: true, etag: etag ?? o?.etag ?? null };
      const token = await resolveToken();
      const signed =
        token !== null &&
        (await verifyRulesSignature(r.text, r.headers.get(GUARDIAN_HEADERS.signature), token));
      if (!signed) {
        throw new GuardianApiError(r.status, 'invalid_signature', 'unsigned or forged rules');
      }
      if (r.value === null) throw new GuardianApiError(r.status, 'invalid_response', 'no body');
      return { notModified: false, etag, rules: r.value, body: r.text };
    },

    extHeartbeat: (body) =>
      value({ method: 'POST', path: P.extHeartbeat, body, schema: extHeartbeatResponseSchema }),

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

/** Settings of a fresh install (the guardian embeds them through `apiContractSnapshot`). */
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

/** Everything about the API the guardian embeds (`guardian/internal/embedded/api.json`). */
export function apiContractSnapshot(): {
  apiVersion: number;
  defaultPort: number;
  limits: typeof GUARDIAN_LIMITS;
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
