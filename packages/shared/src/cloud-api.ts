/**
 * Céntrate cloud API (apps/api, PROMPT §14): wire types shared by the backend and the
 * desktop app's main process, plus the pure helpers both sides need (ISO weeks, local days).
 *
 * The cloud is an optional mirror that the user switches on. It never controls the machine:
 * nothing here can start, extend or end a block, and the app works 100 % without it.
 * docs/API.md is the prose contract; when it and this file disagree, this file wins.
 *
 * Wire conventions (same as `domain.ts`):
 * - Timestamps are `IsoUtc` strings (`2026-09-27T16:42:00.000Z`).
 * - Days are `LocalDay` (`YYYY-MM-DD`), always the civil date of the user or device that
 *   produced the number, never converted to UTC.
 * - Absent values are `null`, never omitted, in every response and request body. Lists are
 *   `[]`. The only optional fields are the partial-update fields of PATCH bodies and the
 *   extras of an error body.
 * - Integers only for minutes, counters and points.
 * - Text lengths count UTF-16 code units (JavaScript `.length`), see `CLOUD_LIMITS`.
 *
 * The typed HTTP client and the offline outbox helpers live at the end of this file.
 */
import type { IsoUtc, IsoWeekday, LocalDay } from './domain';

// ---------------------------------------------------------------------------------------
// Limits (validated by the server, respected by the client)
// ---------------------------------------------------------------------------------------

export const CLOUD_LIMITS = Object.freeze({
  /** Request body limit for every route, in bytes (sync and coach set their own). */
  bodyBytes: 32 * 1024,
  syncBodyBytes: 256 * 1024,

  displayNameMax: 40,
  deviceNameMax: 40,
  appVersionMax: 32,
  /** installId and clientRef: 16–64 chars of `[A-Za-z0-9_-]`. */
  opaqueIdMin: 16,
  opaqueIdMax: 64,
  dailyGoalMinMinutes: 15,
  dailyGoalMaxMinutes: 600,
  maxDevices: 10,

  /** Rows per `PUT /v1/sync/days`. A first backfill of 400 days takes four requests. */
  syncBatchMax: 100,
  /** Accepted `day` window: [today − 400, today + 1] in the user's time zone. */
  syncPastDays: 400,
  syncFutureDays: 1,
  statsRangeMaxDays: 400,
  dayMinutesMax: 1440,
  counterMax: 10_000,
  pointsMax: 100_000,

  friendsMax: 100,
  activeInvitesMax: 5,
  inviteMaxUses: 10,
  inviteTtlDays: 7,
  /** Invite codes: 10 Crockford base32 characters, shown as `XXXXX-XXXXX`. */
  inviteCodeLength: 10,

  presenceTtlSeconds: 180,
  presenceHeartbeatSeconds: 60,

  partnersMax: 3,
  /** Weakening an accountability setup (removing a partner, approval off) waits this long. */
  partnerCoolingOffHours: 24,
  noteMax: 140,
  /** An approval deadline is clamped to [now + 1 min, now + 30 min] and never after the
   *  local emergency countdown. */
  approvalMinSeconds: 60,
  approvalMaxMinutes: 30,
  approvalPollSeconds: 15,
  /** Accountability events and partner-inbox items are kept this long. */
  accountabilityRetentionDays: 30,

  /** `DELETE /v1/me` needs a session created less than this long ago. */
  freshSessionMinutes: 15,
  appAuthCodeTtlSeconds: 60,

  interpretTextMax: 500,
  coachTaskMax: 300,
  coachContextMax: 500,
  coachStepsMin: 2,
  coachStepsMax: 12,
  coachStepMinMinutes: 5,
  coachStepMaxMinutes: 120,
  studySubjectMax: 80,
  studyTopicsMax: 30,
  studyTopicMax: 80,
  studyPlanMaxDays: 60,
  studyDailyMinMinutes: 15,
  studyDailyMaxMinutes: 600,
});

/** Client-side timeouts. The free Render service sleeps: a cold start takes about a minute. */
export const CLOUD_TIMEOUTS = Object.freeze({
  /** Background calls (sync, heartbeat, polling). The UI never waits on them. */
  backgroundMs: 10_000,
  /** Calls the user started (login, invites, ranking); show «Despertando el servidor…». */
  interactiveMs: 60_000,
  /** Coach calls: a cold start plus a model call. */
  coachMs: 90_000,
});

// ---------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------

/** ISO 8601 week `YYYY-Www`, e.g. `2026-W40`. Weeks run Monday to Sunday. */
export type IsoWeek = string;

/** Platform of a connected computer. */
export const CLOUD_PLATFORMS = ['win', 'mac', 'linux'] as const;
export type CloudPlatform = (typeof CLOUD_PLATFORMS)[number];

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export const CLOUD_ERROR_CODES = [
  'validation_failed', // 400
  'unauthorized', // 401: no session, expired or revoked. The app logs out, keeping local data.
  'forbidden', // 403
  'reauth_required', // 403: the action needs a fresh session (sign in again)
  'consent_required', // 403: the matching sharing switch is off (`consent` says which)
  'not_found', // 404 (also for things hidden by a block, identical on purpose)
  'conflict', // 409
  'profile_incomplete', // 409: set a display name before using social features
  'limit_reached', // 409: devices, friends, invites or partners at their maximum
  'deadline_passed', // 409: approval decision after the deadline
  'already_decided', // 409
  'payload_too_large', // 413
  'coach_refused', // 422: the model declined the request
  'rate_limited', // 429 (`retryAfterSeconds`)
  'quota_exceeded', // 429: daily AI quota (`resetsAt`)
  'internal_error', // 500
  'not_implemented', // 501
  'coach_incomplete', // 502: the model hit its output limit
  'feature_disabled', // 503 (`feature`, `reason`)
  'database_unavailable', // 503
  'coach_unavailable', // 503: Anthropic unreachable or overloaded
] as const;
export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

/** Features that can be switched off by configuration (see `CloudCapabilities`). */
export const CLOUD_FEATURES = [
  'accounts',
  'googleLogin',
  'emailLogin',
  'sync',
  'social',
  'partnerEmails',
  'coach',
] as const;
export type CloudFeature = (typeof CLOUD_FEATURES)[number];

/**
 * - `missing_key`: an environment variable the feature needs is not set.
 * - `kill_switch`: `AI_ENABLED=false`.
 * - `budget`: the global daily AI budget is spent (resets at 00:00 UTC).
 * - `database_down`: Postgres does not answer (free databases expire, see docs/API.md).
 */
export type CloudDisabledReason = 'missing_key' | 'kill_switch' | 'budget' | 'database_down';

/** Sharing switches a `consent_required` error can name. */
export type CloudConsent = 'syncStats' | 'ranking' | 'presence' | 'coach';

export interface CloudValidationIssue {
  /** Dotted path into the body or query, e.g. `days.3.focusMinutes`. */
  path: string;
  message: string;
}

/**
 * Every non-2xx response. `message` is English for developers and logs; the app maps
 * `code` to its own Spanish copy. Extras appear only when they apply.
 */
export interface CloudErrorBody {
  error: {
    code: CloudErrorCode;
    message: string;
    feature?: CloudFeature;
    reason?: CloudDisabledReason;
    consent?: CloudConsent;
    issues?: CloudValidationIssue[];
    retryAfterSeconds?: number;
    resetsAt?: IsoUtc;
  };
}

// ---------------------------------------------------------------------------------------
// Health (GET /health, public)
// ---------------------------------------------------------------------------------------

export interface CloudCapability {
  enabled: boolean;
  reason: CloudDisabledReason | null;
}

export type CloudCapabilities = Record<CloudFeature, CloudCapability>;

export interface HealthResponse {
  ok: true;
  version: string;
  now: IsoUtc;
  db: 'up' | 'down' | 'unconfigured';
  /**
   * Random id created with the database. When it changes the cloud copy was reset (the free
   * Postgres expired): the app re-uploads its history and tells the user.
   */
  serverEpoch: string | null;
  capabilities: CloudCapabilities;
}

// ---------------------------------------------------------------------------------------
// Account (/v1/me, /v1/devices, /v1/app-auth)
// ---------------------------------------------------------------------------------------

export interface CloudProfile {
  /** Shown to friends. `null` until set; social features need it. */
  displayName: string | null;
  /** IANA zone. Decides «today» for sync windows and the current ranking week. */
  timeZone: string;
  dailyGoalMinutes: number | null;
}

/** Every switch is off until the user turns it on. */
export interface CloudSharing {
  /** Upload daily totals (numbers only) to the cloud. */
  syncStats: boolean;
  /** Show my weekly totals to friends in the ranking (needs `syncStats`). */
  ranking: boolean;
  /** Show friends when I am focusing or studying right now. */
  presence: boolean;
  /** As someone's accountability partner, also receive alerts by email. */
  partnerEmails: boolean;
  /** Allow the coach to send my text to Anthropic's Claude API when I ask it to. */
  coach: boolean;
}

export interface CloudUser {
  id: string;
  email: string;
  createdAt: IsoUtc;
}

export interface MeResponse {
  user: CloudUser;
  profile: CloudProfile;
  sharing: CloudSharing;
  /** Last change of any sharing switch. */
  consentUpdatedAt: IsoUtc | null;
}

/** PATCH /v1/me. Omitted fields keep their value. */
export interface PatchMeRequest {
  profile?: Partial<CloudProfile>;
  sharing?: Partial<CloudSharing>;
}

/** DELETE /v1/me. Needs a session younger than `CLOUD_LIMITS.freshSessionMinutes`. */
export interface DeleteAccountRequest {
  confirm: 'BORRAR';
}

export interface CloudDevice {
  id: string;
  name: string;
  platform: CloudPlatform;
  appVersion: string;
  createdAt: IsoUtc;
  lastSyncAt: IsoUtc | null;
  /** True for the device of the session making the request. */
  current: boolean;
}

export interface DevicesResponse {
  devices: CloudDevice[];
}

export interface PatchDeviceRequest {
  name: string;
}

/**
 * POST /v1/app-auth/token: the desktop app trades the one-time loopback code for a bearer
 * token (RFC 8252 + PKCE S256, see docs/API.md §4).
 */
export interface AppTokenRequest {
  code: string;
  /** 43–128 chars of `[A-Za-z0-9-._~]` (RFC 7636). */
  codeVerifier: string;
  /** Random id the app keeps for this installation; logging in again reuses the device. */
  installId: string;
  device: {
    name: string;
    platform: CloudPlatform;
    appVersion: string;
  };
}

export interface AppTokenResponse {
  token: string;
  expiresAt: IsoUtc;
  deviceId: string;
  me: MeResponse;
}

// ---------------------------------------------------------------------------------------
// Sync and stats (/v1/sync, /v1/stats)
// ---------------------------------------------------------------------------------------

/**
 * One device's absolute totals for one local day, computed from its own guardian event log.
 * Only that device writes the row, so devices never conflict.
 */
export interface CloudDayStats {
  day: LocalDay;
  /**
   * Monotonic per (device, day): the guardian event `seq` of the last event counted into the
   * day. A row with a lower `rev` than the stored one is ignored and reported as stale. If the
   * source resets (guardian data lost), the app rotates its installId (a new device).
   */
  rev: number;
  /** Minutes under an active block or study session, 0–1440. */
  focusMinutes: number;
  /** Minutes of Study Mode, 0–`focusMinutes`. */
  studyMinutes: number;
  blocksCompleted: number;
  studySessions: number;
  /** Attempts to open something blocked. */
  attempts: number;
  emergencyUnlocks: number;
  punishments: number;
  /** Points won that day (≥ 0). */
  pointsEarned: number;
  /** Points lost that day, as a positive number (≥ 0). */
  pointsLost: number;
}

/** PUT /v1/sync/days (needs `sharing.syncStats`). */
export interface PutDaysRequest {
  deviceId: string;
  days: CloudDayStats[];
}

export interface PutDaysResponse {
  accepted: number;
  /** Days whose stored `rev` is higher than the one sent. */
  stale: LocalDay[];
}

/** GET /v1/sync/state?deviceId=…: what the server holds for this device. */
export interface SyncStateResponse {
  serverEpoch: string;
  deviceId: string;
  revs: Array<{ day: LocalDay; rev: number }>;
}

/** A day summed across devices. `focusMinutes` is capped at 1440. */
export interface CloudMergedDay extends Omit<CloudDayStats, 'rev'> {
  /** `null` when the profile has no daily goal. */
  goalMet: boolean | null;
}

/** GET /v1/stats?from=…&to=… (at most `statsRangeMaxDays` days, inclusive). */
export interface StatsResponse {
  from: LocalDay;
  to: LocalDay;
  dailyGoalMinutes: number | null;
  /** Only days with data, ascending. */
  days: CloudMergedDay[];
  /** The raw rows, so one computer can show «tus otros ordenadores». */
  deviceDays: Array<CloudDayStats & { deviceId: string }>;
  devices: CloudDevice[];
}

// ---------------------------------------------------------------------------------------
// Friends, blocks, ranking, presence
// ---------------------------------------------------------------------------------------

/** Other people are only ever shown by id and display name. Never an email. */
export interface CloudPerson {
  userId: string;
  displayName: string;
}

export interface CloudFriend extends CloudPerson {
  since: IsoUtc;
}

export interface FriendsResponse {
  friends: CloudFriend[];
}

export interface CreateInviteRequest {
  /** 1–`inviteMaxUses`, default 1. */
  maxUses?: number;
}

export interface CreateInviteResponse {
  id: string;
  /** Shown once, as `XXXXX-XXXXX`; the server keeps only its hash. */
  code: string;
  /** `{API}/i/{code}`: the landing page that opens the app or shows the code. */
  url: string;
  expiresAt: IsoUtc;
  maxUses: number;
}

export interface CloudInvite {
  id: string;
  createdAt: IsoUtc;
  expiresAt: IsoUtc;
  maxUses: number;
  uses: number;
}

export interface InvitesResponse {
  invites: CloudInvite[];
}

/** GET /v1/friends/invites/:code. Expired, used up, blocked and unknown are the same 404. */
export interface InvitePreviewResponse {
  inviter: { displayName: string };
}

export interface AcceptInviteResponse {
  friend: CloudFriend;
}

export interface BlockUserRequest {
  userId: string;
}

export interface CloudBlock extends CloudPerson {
  createdAt: IsoUtc;
}

export interface BlocksResponse {
  blocks: CloudBlock[];
}

export interface RankingEntry extends CloudPerson {
  /** Competition ranking: equal minutes and active days share a rank (1, 2, 2, 4). */
  rank: number;
  focusMinutes: number;
  studyMinutes: number;
  /** Days of the week with focus minutes > 0. */
  activeDays: number;
  /** Days that met that person's own daily goal (0 without a goal). */
  goalDays: number;
  isMe: boolean;
}

/** GET /v1/ranking?week=YYYY-Www (needs `sharing.ranking`). */
export interface RankingResponse {
  week: IsoWeek;
  from: LocalDay;
  to: LocalDay;
  entries: RankingEntry[];
}

export type PresenceState = 'focus' | 'study';

/** PUT /v1/presence (needs `sharing.presence`). Heartbeat every 60 s, never queued. */
export interface PutPresenceRequest {
  state: PresenceState;
  /** End of the current block or session, if known. */
  endsAt: IsoUtc | null;
}

export interface PutPresenceResponse {
  expiresAt: IsoUtc;
}

export interface FriendPresence extends CloudPerson {
  state: PresenceState;
  since: IsoUtc;
  endsAt: IsoUtc | null;
}

/** GET /v1/friends/presence (needs `sharing.presence`). */
export interface FriendsPresenceResponse {
  friends: FriendPresence[];
}

// ---------------------------------------------------------------------------------------
// Accountability partner
// ---------------------------------------------------------------------------------------

export interface PartnerLink {
  id: string;
  /** The caller's side of the link. */
  role: 'owner' | 'partner';
  /** The person held accountable. */
  owner: CloudPerson;
  partner: CloudPerson;
  status: 'pending' | 'active';
  /** Effective now (a pending switch-off only counts after `approvalOffAt`). */
  requireApproval: boolean;
  /** When a requested «approval off» takes effect (24 h cooling-off), else `null`. */
  approvalOffAt: IsoUtc | null;
  /** When an owner-requested removal takes effect (24 h cooling-off), else `null`. */
  endsAt: IsoUtc | null;
  createdAt: IsoUtc;
  acceptedAt: IsoUtc | null;
}

export interface PartnersResponse {
  links: PartnerLink[];
}

export interface CreatePartnerRequest {
  /** Must already be a friend. */
  friendId: string;
  requireApproval: boolean;
}

export interface PatchPartnerRequest {
  requireApproval: boolean;
}

export const ACCOUNTABILITY_KINDS = [
  'emergency_requested',
  'emergency_confirmed',
  'emergency_cancelled',
  'study_abandoned',
  'punishment_started',
] as const;
export type AccountabilityKind = (typeof ACCOUNTABILITY_KINDS)[number];

/** POST /v1/accountability/events. Idempotent on `clientRef` (queued offline by the app). */
export interface PostAccountabilityEventRequest {
  clientRef: string;
  kind: AccountabilityKind;
  occurredAt: IsoUtc;
  /** For `emergency_requested`: when the local countdown ends. */
  countdownEndsAt: IsoUtc | null;
}

/**
 * `expired` is computed on read (pending past its deadline). The app treats `expired`,
 * errors and being offline as approved: the flow fails open and never blocks the guardian.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalState {
  status: ApprovalStatus;
  deadline: IsoUtc;
  /** Optional note from the partner. */
  note: string | null;
  decidedAt: IsoUtc | null;
}

export interface PostAccountabilityEventResponse {
  eventId: string;
  /** Present only for an `emergency_requested` that needs a partner's approval. */
  approval: ApprovalState | null;
}

/** GET /v1/accountability/events/:id (owner only). */
export interface AccountabilityEventResponse {
  eventId: string;
  kind: AccountabilityKind;
  occurredAt: IsoUtc;
  approval: ApprovalState | null;
}

export interface InboxItem {
  eventId: string;
  kind: AccountabilityKind;
  owner: CloudPerson;
  occurredAt: IsoUtc;
  approval: ApprovalState | null;
  /** True when the caller is the partner who decided. */
  decidedByMe: boolean;
}

/** GET /v1/accountability/inbox: the caller's partners' events, newest first. */
export interface InboxResponse {
  items: InboxItem[];
}

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'deny';
  note: string | null;
}

// ---------------------------------------------------------------------------------------
// Coach (Claude API through the backend; needs `sharing.coach`)
// ---------------------------------------------------------------------------------------

export interface SplitTaskRequest {
  task: string;
  context: string | null;
  /** Time the user has, 5–600 min. */
  minutesAvailable: number | null;
}

export interface SplitTaskStep {
  title: string;
  minutes: number;
  /**
   * A phrase the local parser understands completely («estudiar mates 25 minutos»), for a
   * one-tap «Empezar». The server drops phrases that do not parse.
   */
  suggestedPhrase: string | null;
}

export interface SplitTaskResponse {
  steps: SplitTaskStep[];
  firstStepTip: string;
}

export type StudyItemKind = 'learn' | 'review' | 'practice' | 'mock';

export interface StudyPlanRequest {
  subject: string;
  examDate: LocalDay;
  today: LocalDay;
  dailyMinutes: number;
  topics: string[];
  level: 'starting' | 'intermediate' | 'reviewing' | null;
  /** Weekdays without study. */
  daysOff: IsoWeekday[];
}

export interface StudyPlanDay {
  day: LocalDay;
  items: Array<{ topic: string; kind: StudyItemKind; minutes: number }>;
}

export interface StudyPlanResponse {
  /** Between `today` and the day before the exam; each day within `dailyMinutes`. */
  days: StudyPlanDay[];
  advice: string[];
}

/**
 * POST /v1/coach/interpret: only when the user asks («Preguntar al coach» under «No he
 * entendido»). The model rewrites the phrase into the local grammar; the app re-parses
 * `canonicalText` locally and always shows the confirmation card.
 */
export interface InterpretRequest {
  text: string;
  timeZone: string;
  now: IsoUtc;
}

export interface InterpretResponse {
  /** Parses locally with nothing unparsed, or `null` when the model could not rewrite it. */
  canonicalText: string | null;
  /** A short question or hint in Spanish when `canonicalText` is `null`. */
  clarification: string | null;
}

/** Numbers the app sends when stats sync is off (processed, never stored). */
export interface WeekStats {
  days: Array<Omit<CloudDayStats, 'rev'>>;
  dailyGoalMinutes: number | null;
}

export interface WeeklySummaryRequest {
  week: IsoWeek;
  /** Required when `sharing.syncStats` is off; ignored when it is on. */
  stats: WeekStats | null;
}

export interface WeeklySummaryResponse {
  headline: string;
  highlights: string[];
  suggestion: string;
}

export interface CoachQuotaResponse {
  interpret: { requestsLeft: number };
  coach: { requestsLeft: number; tokensLeft: number };
  /** Next 00:00 UTC. */
  resetsAt: IsoUtc;
}

// ---------------------------------------------------------------------------------------
// GDPR export (GET /v1/me/export)
// ---------------------------------------------------------------------------------------

/** Every row about the user. Other people appear only as id and display name. */
export interface CloudExport {
  schemaVersion: 1;
  exportedAt: IsoUtc;
  me: MeResponse;
  loginMethods: Array<{ provider: string; createdAt: IsoUtc }>;
  sessions: Array<{ createdAt: IsoUtc; expiresAt: IsoUtc; current: boolean }>;
  devices: CloudDevice[];
  dailyStats: Array<CloudDayStats & { deviceId: string }>;
  friends: CloudFriend[];
  invites: CloudInvite[];
  blocks: CloudBlock[];
  presence: { state: PresenceState; since: IsoUtc; endsAt: IsoUtc | null } | null;
  partnerLinks: PartnerLink[];
  accountabilityEvents: AccountabilityEventResponse[];
  /** Decisions the user took as someone's partner. */
  approvalDecisions: Array<{
    eventId: string;
    owner: CloudPerson;
    decision: 'approved' | 'denied';
    note: string | null;
    decidedAt: IsoUtc;
  }>;
  aiUsage: Array<{
    day: LocalDay;
    feature: 'interpret' | 'coach';
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// ---------------------------------------------------------------------------------------
// Days and ISO weeks (pure; the server and the app must agree on them)
// ---------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const LOCAL_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WEEK_RE = /^(\d{4})-W(\d{2})$/;

function dayToUtcMs(day: LocalDay): number | null {
  const m = LOCAL_DAY_RE.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function utcMsToDay(ms: number): LocalDay {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a real calendar date `YYYY-MM-DD`. */
export function isLocalDay(value: unknown): value is LocalDay {
  return typeof value === 'string' && dayToUtcMs(value) !== null;
}

/** `day` plus `n` days (n may be negative). Throws on an invalid day. */
export function addDays(day: LocalDay, n: number): LocalDay {
  const ms = dayToUtcMs(day);
  if (ms === null) throw new RangeError(`addDays: invalid day ${day}`);
  return utcMsToDay(ms + n * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDay, to: LocalDay): number {
  const a = dayToUtcMs(from);
  const b = dayToUtcMs(to);
  if (a === null || b === null) throw new RangeError(`daysBetween: invalid day`);
  return Math.round((b - a) / DAY_MS);
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The civil date at instant `at` in `timeZone`. */
export function localDayIn(timeZone: string, at: Date): LocalDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** ISO week of a day: `2027-01-03` → `2026-W53`. Throws on an invalid day. */
export function isoWeekOf(day: LocalDay): IsoWeek {
  const ms = dayToUtcMs(day);
  if (ms === null) throw new RangeError(`isoWeekOf: invalid day ${day}`);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Monday and Sunday of an ISO week: `2026-W53` → 2026-12-28 … 2027-01-03. `null` for a
 * malformed week or one the year does not have (W53 only exists in long years).
 */
export function isoWeekRange(week: IsoWeek): { from: LocalDay; to: LocalDay } | null {
  const m = ISO_WEEK_RE.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > 53) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
  const monday = jan4 - jan4Weekday * DAY_MS + (n - 1) * 7 * DAY_MS;
  const from = utcMsToDay(monday);
  if (isoWeekOf(from) !== week) return null;
  return { from, to: utcMsToDay(monday + 6 * DAY_MS) };
}

// ---------------------------------------------------------------------------------------
// Client and offline outbox (owned by the CLIENT builder, see docs/API.md §13)
// ---------------------------------------------------------------------------------------
