/**
 * Céntrate domain model: the entities the guardian owns (blocks, schedules, study
 * sessions, punishments, emergency unlocks, reward allowances, settings, the points
 * summary) and its append-only event log, as they travel over the guardian HTTP API.
 *
 * The guardian (Go) is the single source of truth; these types describe its JSON. See
 * docs/ARCHITECTURE.md for the semantics of every field and event.
 *
 * Wire conventions:
 * - Every timestamp is an `IsoUtc` string (`2026-09-27T16:42:00.000Z`, UTC, `Z` suffix).
 *   In API responses timestamps are **display time**: the instant as the machine's own
 *   clock will read it, so `Date.parse(block.endsAt) - Date.now()` is the countdown even
 *   after someone moved the system clock. Events store **trusted time** in `at` plus the
 *   `wallOffsetMs` that turns it into display time (see `EventEnvelopeBase`).
 * - Absent values are `null`, never omitted. Lists are `[]`, never `null`.
 * - Integers only: minutes, milliseconds and points are whole numbers.
 */
import type { CategoryId } from './catalog';

// ---------------------------------------------------------------------------------------
// Scalars and identifiers
// ---------------------------------------------------------------------------------------

/** ISO 8601 UTC timestamp with a `Z` suffix, e.g. `2026-09-27T16:42:00.000Z`. */
export type IsoUtc = string;

/** A civil date `YYYY-MM-DD` in the guardian's configured time zone. */
export type LocalDay = string;

/** A wall-clock time of day `HH:MM` (24 h, `00:00`–`23:59`). */
export type ClockTime = string;

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Prefixes of guardian-generated identifiers. An id is `<prefix>_<16–40 [0-9A-Za-z]>`,
 * e.g. `blk_7Qm2KxV9pL4sT1aZ0cHfWe`. Ids are opaque: never parse anything but the prefix.
 */
export const ID_PREFIXES = {
  block: 'blk',
  schedule: 'sch',
  study: 'stu',
  punishment: 'pun',
  emergency: 'emg',
  allowance: 'alw',
  attempt: 'att',
  extension: 'ext',
  epoch: 'ep',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export type BlockId = `blk_${string}`;
export type ScheduleId = `sch_${string}`;
export type StudySessionId = `stu_${string}`;
export type PunishmentId = `pun_${string}`;
export type EmergencyId = `emg_${string}`;
export type AllowanceId = `alw_${string}`;
export type AttemptId = `att_${string}`;
export type ExtensionId = `ext_${string}`;
export type EpochId = `ep_${string}`;

const ID_BODY_RE = /^[0-9A-Za-z]{16,40}$/;

/** True when `value` is a well-formed id of the given kind. */
export function isIdOf(kind: IdKind, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ID_BODY_RE.test(value.slice(prefix.length));
}

// ---------------------------------------------------------------------------------------
// Enumerations (each is a const tuple plus its union type)
// ---------------------------------------------------------------------------------------

/**
 * - `normal`: emergency unlock after a 10 min countdown.
 * - `strict`: emergency unlock after a 30 min countdown.
 * - `hardcore`: no emergency unlock at all.
 * - `exam`: whitelist-only and hardcore (no emergency unlock).
 */
export const BLOCK_MODES = ['normal', 'strict', 'hardcore', 'exam'] as const;
export type BlockMode = (typeof BLOCK_MODES)[number];

/**
 * - `manual`: created by the user (phrase, template or advanced form).
 * - `schedule`: materialized from a schedule occurrence.
 * - `punishment`: created by the guardian when Study Mode punishes (never by a client).
 * - `recovered`: rebuilt from the hosts section after the guardian lost its state.
 */
export const BLOCK_KINDS = ['manual', 'schedule', 'punishment', 'recovered'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_STATUSES = ['active', 'completed', 'cancelled_emergency'] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];

/** Browser families the extension reports (Brave, Opera and Vivaldi are Chromium). */
export const BROWSER_FAMILIES = [
  'chrome',
  'edge',
  'brave',
  'opera',
  'vivaldi',
  'chromium',
  'firefox',
  'other',
] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

/** Layer that detected an attempt. `process` is guardian-internal. */
export const ATTEMPT_LAYERS = ['extension', 'process', 'window'] as const;
export type AttemptLayer = (typeof ATTEMPT_LAYERS)[number];

export const STUDY_STATUSES = [
  'active',
  'paused',
  'completed',
  'ended_early',
  'abandoned',
  'punished',
] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];

/** Terminal study statuses (a subset of `StudyStatus`). */
export const STUDY_OUTCOMES = ['completed', 'ended_early', 'abandoned', 'punished'] as const;
export type StudyOutcome = (typeof STUDY_OUTCOMES)[number];

/** Phase computed by the guardian from Pomodoro settings and pauses. */
export const STUDY_PHASES = ['work', 'break', 'paused', 'ended'] as const;
export type StudyPhase = (typeof STUDY_PHASES)[number];

/** What the app's attention model saw; informational only (the guardian computes phases). */
export const HEARTBEAT_STATES = ['focused', 'doubt', 'away', 'break', 'paused'] as const;
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number];

export const STRIKE_CAUSES = ['doubt_timeout', 'no_face', 'phone', 'distraction_app'] as const;
export type StrikeCause = (typeof STRIKE_CAUSES)[number];

/** «¿Lo has conseguido? Sí | En parte | No». */
export const ACHIEVED_VALUES = ['yes', 'partial', 'no'] as const;
export type Achieved = (typeof ACHIEVED_VALUES)[number];

/**
 * Punishment levels (PROMPT.md §8): 1 every distraction category, 2 study whitelist only,
 * 3 «Nuclear» (every distraction plus a full-screen overlay the guardian keeps relaunching).
 */
export const PUNISHMENT_LEVELS = ['distractions', 'whitelist', 'nuclear'] as const;
export type PunishmentLevel = (typeof PUNISHMENT_LEVELS)[number];

export const PUNISHMENT_CAUSES = ['three_strikes', 'abandoned'] as const;
export type PunishmentCause = (typeof PUNISHMENT_CAUSES)[number];

export const PUNISHMENT_STATUSES = ['active', 'completed', 'cancelled_emergency'] as const;
export type PunishmentStatus = (typeof PUNISHMENT_STATUSES)[number];

export const EMERGENCY_STATUSES = [
  'counting',
  'ready',
  'confirmed',
  'cancelled',
  'expired',
] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];

export const EMERGENCY_CANCEL_REASONS = ['user', 'expired', 'blocks_ended', 'reboot'] as const;
export type EmergencyCancelReason = (typeof EMERGENCY_CANCEL_REASONS)[number];

export const ALLOWANCE_STATUSES = ['active', 'expired', 'revoked'] as const;
export type AllowanceStatus = (typeof ALLOWANCE_STATUSES)[number];

/** Why the reward shop is closed right now. */
export const REWARDS_LOCK_REASONS = ['hardcore', 'exam', 'punishment', 'study'] as const;
export type RewardsLockReason = (typeof REWARDS_LOCK_REASONS)[number];

/**
 * - `verified`: a network time check agreed with the trusted clock in this boot.
 * - `unverified`: no successful check since the last reboot (or offline).
 * - `disabled`: the server time check is turned off in settings.
 */
export const CLOCK_TRUST_LEVELS = ['verified', 'unverified', 'disabled'] as const;
export type ClockTrust = (typeof CLOCK_TRUST_LEVELS)[number];

/**
 * - `tick`: the wall clock moved while the guardian was running.
 * - `restore`: it moved while the guardian was stopped (same boot).
 * - `reboot`: after a reboot the wall clock read earlier than the last trusted time.
 * - `calibrate`: a network time check found the trusted clock ahead and moved it back.
 */
export const CLOCK_JUMP_SOURCES = ['tick', 'restore', 'reboot', 'calibrate'] as const;
export type ClockJumpSource = (typeof CLOCK_JUMP_SOURCES)[number];

/**
 * - `normal`: everything works.
 * - `frozen`: `state.json` has a newer schema than this binary (downgrade). Enforcement
 *   continues from the frozen v1 core until each block's end; writes return 503.
 * - `safe`: at least 3 unclean starts within 5 min. Replay stops at the first bad event;
 *   writes return 503 until an administrator runs `repair` or the next clean start.
 */
export const GUARDIAN_MODES = ['normal', 'frozen', 'safe'] as const;
export type GuardianMode = (typeof GUARDIAN_MODES)[number];

// ---------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------

/**
 * What a block or schedule blocks. Clients send catalog ids plus validated custom
 * entries; the guardian resolves them with its embedded catalog (a client can never
 * make the guardian open or block arbitrary hosts through ids).
 */
export interface TargetSpec {
  /** Catalog service ids (`youtube`, `x-twitter`…). */
  serviceIds: string[];
  /** Catalog category ids; each adds every service in it plus category-wide apps. */
  categoryIds: CategoryId[];
  /** Catalog app ids that are not tied to a service (`popular-pc-games`…). */
  appIds: string[];
  /** Canonical custom domains (see `normalizeDomain`); the guardian adds `www.` variants. */
  customDomains: string[];
  /** Custom executable base names; protected processes are rejected. */
  customProcesses: string[];
}

/**
 * Extra entries allowed by a whitelist-only block, on top of the study whitelist
 * (catalog defaults plus `settings.studyWhitelist`). Domains of catalog distraction
 * services are rejected (`allow_distraction`).
 */
export interface WhitelistAllow {
  customDomains: string[];
  customProcesses: string[];
}

// ---------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------

export interface Block {
  id: BlockId;
  kind: BlockKind;
  mode: BlockMode;
  status: BlockStatus;
  /** Empty (all lists `[]`) for whitelist-only blocks. */
  targets: TargetSpec;
  /** Block everything except the study whitelist and `allow` (exam mode forces it). */
  whitelistOnly: boolean;
  /** Empty unless `whitelistOnly`. */
  allow: WhitelistAllow;
  /** «Tu motivo», shown on blocked.html; `""` when none. */
  reason: string;
  createdAt: IsoUtc;
  startsAt: IsoUtc;
  /** Current end (display time). Only ever moves later (extensions, clock corrections). */
  endsAt: IsoUtc;
  /** End as first confirmed, before any extension. */
  originalEndsAt: IsoUtc;
  endedAt: IsoUtc | null;
  /** Sum of all extensions, in minutes. */
  extendedMinutes: number;
  scheduleId: ScheduleId | null;
  punishmentId: PunishmentId | null;
  /** Counted attempts (after dedupe) against this block so far. */
  attemptsCounted: number;
  /** False for hardcore, exam and blocks already covered by a pending emergency. */
  emergencyEligible: boolean;
  /** Points granted at completion (or `0` when cancelled); `null` while active. */
  pointsDelta: number | null;
}

export interface Schedule {
  id: ScheduleId;
  name: string;
  enabled: boolean;
  /** Sorted, unique, non-empty. */
  days: IsoWeekday[];
  start: ClockTime;
  /** `end <= start` means the window ends the next day (overnight). */
  end: ClockTime;
  /** IANA zone (`Europe/Madrid`); evaluated with the guardian's embedded tzdata. */
  timezone: string;
  targets: TargetSpec;
  whitelistOnly: boolean;
  allow: WhitelistAllow;
  mode: BlockMode;
  reason: string;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
  /** Next occurrence that has not started yet (display time). */
  nextOccurrence: { startsAt: IsoUtc; endsAt: IsoUtc } | null;
  /** The block of the occurrence in progress, if any. */
  activeBlockId: BlockId | null;
}

export interface PomodoroSpec {
  workMinutes: number;
  breakMinutes: number;
}

/** Punishment settings snapshotted when a study session starts. */
export interface PunishmentPolicy {
  level: PunishmentLevel;
  minutes: number;
}

export interface StudySession {
  id: StudySessionId;
  /** «historia»; `""` when none. */
  task: string;
  plannedMinutes: number;
  pomodoro: PomodoroSpec | null;
  camera: boolean;
  status: StudyStatus;
  phase: StudyPhase;
  /** Next phase change (end of work, end of break, pause auto-resume); display time. */
  phaseEndsAt: IsoUtc | null;
  startedAt: IsoUtc;
  /** Estimate: now + remaining active (non-paused, awake) time. */
  plannedEndsAt: IsoUtc;
  endedAt: IsoUtc | null;
  /** Active (not paused, machine awake) minutes so far, breaks included. */
  activeMinutes: number;
  /** Focused minutes accepted by the guardian so far. */
  focusedMinutes: number;
  strikes: number;
  attempts: number;
  /** A new strike does not count before this instant; `null` when no cooldown runs. */
  cooldownUntil: IsoUtc | null;
  pausesLeft: number;
  /** When `pausesLeft` is 0: when the next pause becomes available. */
  nextPauseAvailableAt: IsoUtc | null;
  lastHeartbeatAt: IsoUtc | null;
  lastHeartbeatSeq: number;
  policy: PunishmentPolicy;
  achieved: Achieved | null;
}

export interface Punishment {
  id: PunishmentId;
  /** The strict block that enforces it (kind `punishment`). */
  blockId: BlockId;
  sessionId: StudySessionId | null;
  cause: PunishmentCause;
  level: PunishmentLevel;
  minutes: number;
  startsAt: IsoUtc;
  endsAt: IsoUtc;
  status: PunishmentStatus;
  endedAt: IsoUtc | null;
}

export interface EmergencyUnlock {
  id: EmergencyId;
  /** Blocks the unlock will cancel (hardcore and exam blocks can never be listed). */
  blockIds: BlockId[];
  status: EmergencyStatus;
  /** 10 (normal) or 30 (any strict block, punishments included). */
  countdownMinutes: number;
  requestedAt: IsoUtc;
  /** When confirming becomes possible (measured on the boot clock). */
  readyAt: IsoUtc;
  /** Deadline to confirm once ready; `null` while counting. */
  confirmBy: IsoUtc | null;
  /** Penalty if confirmed now: max(200, floor(balance / 2)). */
  penaltyPreview: number;
  streakDaysAtRisk: number;
  resolvedAt: IsoUtc | null;
  cancelReason: EmergencyCancelReason | null;
}

export interface RewardAllowance {
  id: AllowanceId;
  offerId: string;
  serviceId: string;
  /** Total purchased minutes (redeeming the same service again extends it). */
  minutes: number;
  /** Total points paid. */
  cost: number;
  startedAt: IsoUtc;
  endsAt: IsoUtc;
  status: AllowanceStatus;
  endedAt: IsoUtc | null;
  /** Points refunded when revoked (pro rata); 0 otherwise. */
  refund: number;
}

/** Attempt escalation state carried across a data deletion. */
export interface EscalationState {
  lastCountedAt: IsoUtc | null;
  index: number;
}

export interface GuardianSettings {
  /** IANA zone for local days and default schedule zone; `null` = the OS local zone. */
  timezone: string | null;
  /** Daily goal of focused minutes for the streak. */
  dailyGoalMinutes: number;
  /** «Penalizaciones»: attempts cost points. */
  attemptPenalties: boolean;
  punishment: PunishmentPolicy;
  /** During a block, close browsers whose extension is not connected. */
  closeBrowsersWithoutExtension: boolean;
  /** Check the trusted clock against network time (anti clock-cheat). */
  serverTimeCheck: boolean;
  /** Additions to the catalog study whitelist. */
  studyWhitelist: { extraDomains: string[]; extraProcesses: string[] };
}

export type SettingsField = keyof GuardianSettings;

/**
 * A weakening settings change waiting for its delay (24 h) to pass. Strengthening changes
 * apply at once and never appear here.
 */
export type PendingSettingChange = {
  [K in SettingsField]: { field: K; value: GuardianSettings[K]; effectiveAt: IsoUtc };
}[SettingsField];

/** What the Progress section shows. Derived by `summarizeLedger` (points.ts). */
export interface PointsSummary {
  /** «Dinero»: can be negative («números rojos»). */
  balance: number;
  /** Only goes up (focused minutes). */
  xp: number;
  level: number;
  /** XP at which the current level started. */
  levelFloorXp: number;
  /** XP needed for the next level. */
  nextLevelXp: number;
  streakDays: number;
  bestStreakDays: number;
  today: { day: LocalDay; focusMinutes: number; goalMinutes: number; goalMet: boolean };
}

// ---------------------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------------------

/**
 * Fields shared by every event line. The guardian also writes `prevMac` and `mac` (HMAC
 * chain) to disk; they are stripped from API responses.
 */
export interface EventEnvelopeBase {
  /** Envelope version. Additive changes only; a breaking change bumps it. */
  v: 1;
  epoch: EpochId;
  /** 1, 2, 3… within the epoch, without gaps. */
  seq: number;
  /** Trusted time of the event (UTC). */
  at: IsoUtc;
  /** Display time of the event is `at + wallOffsetMs`. */
  wallOffsetMs: number;
  /** Local day (guardian time zone) at emission. */
  day: LocalDay;
  /**
   * Balance delta recorded at emission (0 when none); history never changes. For
   * `epoch_started` it is the carried-over balance (the ledger resets at an epoch start).
   */
  points: number;
  /** XP delta recorded at emission (always ≥ 0: XP only goes up within an epoch). */
  xp: number;
  /** True on the last event of an atomic batch; recovery drops a trailing partial batch. */
  txEnd: boolean;
  /** Hex fingerprint of the idempotency key of the request that caused it, or `null`. */
  req: string | null;
}

export type RecoveryKind =
  'none' | 'replayed' | 'backup_snapshot' | 'rebuilt' | 'partial' | 'hosts_section' | 'empty';

export type TamperKind =
  'hosts' | 'hosts_locked' | 'hosts_path_overridden' | 'state_mac' | 'ledger_rollback';

export type ProcessClosedReason =
  'running_at_block_start' | 'logon_grace' | 'browser_without_extension';

export type BlockCreatedSource = 'user' | 'schedule' | 'punishment';

export type EpochStartReason = 'install' | 'data_deleted' | 'log_unreadable';

/**
 * State carried into a new epoch, so the epoch can be rebuilt from its own events without
 * re-emitting (and re-charging) `punishment_started` or `reward_redeemed`.
 */
export interface EpochKeptState {
  /** Active blocks (punishment and recovered blocks included). */
  blocks: Block[];
  punishments: Punishment[];
  allowances: RewardAllowance[];
  /** Schedules in progress or inside the pre-start freeze (data deletion), or all of them. */
  schedules: Schedule[];
  settings: GuardianSettings;
  pendingSettings: PendingSettingChange[];
}

/** Payload of each event type. Adding a type or an optional field is non-breaking. */
export interface EventDataMap {
  guardian_started: {
    version: string;
    schemaVersion: number;
    catalogVersion: number;
    rulesVersion: number;
    mode: GuardianMode;
    sameBoot: boolean;
    /** Real time the guardian was down (same boot only). */
    downtimeMs: number | null;
    uncleanShutdown: boolean;
    recovery: RecoveryKind;
  };
  epoch_started: {
    reason: EpochStartReason;
    previousEpoch: EpochId | null;
    /** min(0, previous balance): a negative balance survives data deletion. */
    carryOverBalance: number;
    escalation: EscalationState;
    kept: EpochKeptState;
  };
  clock_jump: {
    source: ClockJumpSource;
    /** Signed wall-clock change relative to real time (+2 h when moved forward). */
    deltaMs: number;
    wallOffsetMs: number;
    trust: ClockTrust;
    /** Blocks brought back by a `calibrate` correction. */
    reactivatedBlockIds: BlockId[];
  };
  day_closed: {
    /** The local day that ended. */
    day: LocalDay;
    /** Goal in force for that day (settings snapshot). */
    goalMinutes: number;
  };
  block_created: { block: Block; source: BlockCreatedSource };
  block_extended: { blockId: BlockId; addMinutes: number; endsAt: IsoUtc };
  block_completed: {
    blockId: BlockId;
    kind: BlockKind;
    mode: BlockMode;
    /** Awake minutes credited to this block only (union across overlapping blocks). */
    creditedMinutes: number;
    attemptsCounted: number;
    /** Time the guardian was not running while the block was active. */
    downtimeMs: number;
    clockTrust: ClockTrust;
  };
  block_cancelled: { blockId: BlockId; emergencyId: EmergencyId; forfeitedMinutes: number };
  block_reactivated: {
    blockId: BlockId;
    /** `seq` of the `block_completed` it reverts. */
    revertsSeq: number;
    /** Points that completion granted; this event subtracts them. */
    revertPoints: number;
    endsAt: IsoUtc;
    reason: 'clock_correction';
  };
  attempt: {
    attemptId: AttemptId;
    layer: AttemptLayer;
    /** Dedupe key: `svc:<serviceId>`, `app:<appId>`, `dom:<domain>` or `proc:<name>`. */
    targetKey: string;
    targetType: 'service' | 'app' | 'domain' | 'process';
    serviceId: string | null;
    blockIds: BlockId[];
    browser: BrowserFamily | null;
    incognito: boolean;
    escalationIndex: number;
    /** `settings.attemptPenalties` when it happened. */
    penalized: boolean;
  };
  process_closed: {
    reason: ProcessClosedReason;
    serviceId: string | null;
    appId: string | null;
    browser: BrowserFamily | null;
    blockIds: BlockId[];
  };
  study_started: { session: StudySession };
  study_paused: { sessionId: StudySessionId; pauseEndsAt: IsoUtc };
  study_resumed: { sessionId: StudySessionId; auto: boolean };
  focus_minutes: { sessionId: StudySessionId; minutes: number };
  strike: { sessionId: StudySessionId; strikeNumber: number; cause: StrikeCause };
  study_ended: {
    sessionId: StudySessionId;
    outcome: StudyOutcome;
    plannedMinutes: number;
    activeMinutes: number;
    focusedMinutes: number;
    strikes: number;
    attempts: number;
  };
  study_outcome: { sessionId: StudySessionId; achieved: Achieved };
  punishment_started: { punishment: Punishment };
  punishment_ended: {
    punishmentId: PunishmentId;
    blockId: BlockId;
    outcome: 'completed' | 'emergency';
  };
  emergency_requested: { emergency: EmergencyUnlock };
  emergency_cancelled: { emergencyId: EmergencyId; reason: EmergencyCancelReason };
  emergency_confirmed: {
    emergencyId: EmergencyId;
    blockIds: BlockId[];
    balanceBefore: number;
    penalty: number;
    streakDaysLost: number;
    /** Daily goal in force (needed to derive today's streak contribution). */
    goalMinutes: number;
  };
  reward_redeemed: {
    allowanceId: AllowanceId;
    offerId: string;
    serviceId: string;
    minutes: number;
    cost: number;
    endsAt: IsoUtc;
    extendedExisting: boolean;
  };
  reward_ended: {
    allowanceId: AllowanceId;
    serviceId: string;
    reason: 'expired' | 'revoked';
    revokedByBlockId: BlockId | null;
    /** Total cost, total span and remaining span: inputs of the pro-rata refund. */
    cost: number;
    totalMs: number;
    remainingMs: number;
    refund: number;
  };
  schedule_created: { schedule: Schedule };
  schedule_updated: { schedule: Schedule };
  schedule_deleted: { scheduleId: ScheduleId };
  settings_changed: { settings: GuardianSettings; pending: PendingSettingChange[] };
  extension_paired: {
    extensionId: ExtensionId;
    browser: BrowserFamily;
    boundOrigin: string | null;
  };
  extension_revoked: { extensionId: ExtensionId };
  tamper_detected: {
    kind: TamperKind;
    /** ≤ 0. Only `ledger_rollback` corrects the balance by default. */
    balanceCorrection: number;
  };
  ledger_repaired: {
    droppedFromSeq: number;
    droppedCount: number;
    archivedAs: string;
    balanceCorrection: number;
  };
}

export type EventType = keyof EventDataMap;

/** Every known event type, in documentation order. */
export const EVENT_TYPES = [
  'guardian_started',
  'epoch_started',
  'clock_jump',
  'day_closed',
  'block_created',
  'block_extended',
  'block_completed',
  'block_cancelled',
  'block_reactivated',
  'attempt',
  'process_closed',
  'study_started',
  'study_paused',
  'study_resumed',
  'focus_minutes',
  'strike',
  'study_ended',
  'study_outcome',
  'punishment_started',
  'punishment_ended',
  'emergency_requested',
  'emergency_cancelled',
  'emergency_confirmed',
  'reward_redeemed',
  'reward_ended',
  'schedule_created',
  'schedule_updated',
  'schedule_deleted',
  'settings_changed',
  'extension_paired',
  'extension_revoked',
  'tamper_detected',
  'ledger_repaired',
] as const satisfies readonly EventType[];

/** One event of a known type (discriminated on `type`). */
export type GuardianEvent = {
  [K in EventType]: EventEnvelopeBase & { type: K; data: EventDataMap[K] };
}[EventType];

/** The event of type `K`. */
export type GuardianEventOf<K extends EventType> = Extract<GuardianEvent, { type: K }>;

/**
 * An event written by a newer guardian with a type this build does not know. Clients
 * store it raw, keep advancing their cursor and ignore it; `points`/`xp` still apply.
 */
export interface UnknownGuardianEvent extends EventEnvelopeBase {
  type: string;
  data: Record<string, unknown>;
}

export type WireEvent = GuardianEvent | UnknownGuardianEvent;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** True when `type` is a known event type. */
export function isEventType(type: unknown): type is EventType {
  return typeof type === 'string' && EVENT_TYPE_SET.has(type);
}

/** Narrows a wire event to the known union (use before switching on `type`). */
export function isKnownEvent(event: WireEvent): event is GuardianEvent {
  return isEventType(event.type);
}
