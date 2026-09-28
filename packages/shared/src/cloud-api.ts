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
  /** An approval deadline is clamped to [now + 1 min, now + 30 min] and ends at least
   *  `approvalMarginSeconds` before the local emergency countdown. */
  approvalMinSeconds: 60,
  approvalMaxMinutes: 30,
  /** Room between the approval deadline and the end of the local countdown: the request's
   *  travel time plus one approval poll, so the app sees the last answer before it ends. */
  approvalMarginSeconds: 30,
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
  /**
   * Calendar days one study plan covers, from `today`. A later exam gets a plan for the first
   * four weeks (`StudyPlanResponse.truncated`); the app asks again when it runs out.
   */
  studyPlanMaxDays: 28,
  studyDailyMinMinutes: 15,
  studyDailyMaxMinutes: 600,
});

/**
 * Client-side timeouts. The free Render service sleeps after 15 minutes without requests and a
 * cold start takes about a minute, so a coach call never pays for both inside one timeout: the
 * client first wakes a server that has not answered for `awakeMs` (`GET /health`, interactive
 * timeout), then gives the coach request its own `coachMs`.
 */
export const CLOUD_TIMEOUTS = Object.freeze({
  /** Background calls (sync, heartbeat, polling). The UI never waits on them. */
  backgroundMs: 10_000,
  /** Calls the user started (login, invites, ranking); show «Despertando el servidor…». */
  interactiveMs: 60_000,
  /**
   * A coach request to an awake server: the longest server deadline (study-plan, 80 s) plus
   * room for the quota bookkeeping and the network. Waiting less would give up on answers the
   * server still finishes and bills.
   */
  coachMs: 100_000,
  /** How long after its last answer the server counts as awake (it sleeps after 15 min). */
  awakeMs: 10 * 60_000,
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
 * - `budget`: a global daily allowance is spent until 00:00 UTC: the AI budget (`coach`) or
 *   the sign-in emails (`emailLogin`, `SIGNIN_EMAILS_PER_DAY`).
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
   * Random id created with the database. When it changes, the database was replaced (the free
   * Postgres expired) and everything in it is gone: accounts, sessions, devices, sharing
   * choices, stats and social data. The app's token no longer works; it keeps its local data,
   * shows «La nube se ha reiniciado: vuelve a conectar» and, after a new login, re-applies the
   * sharing choices the user confirms and re-uploads (`daysToReupload`). docs/API.md §7.
   *
   * `null` means «unknown», never «changed»: the database is unconfigured, down or did not
   * answer the probe (a free database in its grace period, a brief outage). The app then keeps
   * its token, device id and outbox. Compare with `cloudWasReset`, never with `!==`.
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
  /**
   * When `sharing.ranking` was last turned on (null while off). Friends' rankings count the
   * user's days only from that day, never earlier weeks; turning it off and on restarts it.
   */
  rankingSince: IsoUtc | null;
}

/** PATCH /v1/me. Omitted fields keep their value. */
export interface PatchMeRequest {
  profile?: {
    /**
     * 1–`displayNameMax` characters after trimming, no control characters. Once set it can be
     * changed but not cleared (friends and partners always see some name).
     */
    displayName?: string;
    /** IANA zone. */
    timeZone?: string;
    /** `dailyGoalMinMinutes`–`dailyGoalMaxMinutes`; null removes the goal. */
    dailyGoalMinutes?: number | null;
  };
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
 * A browser (cookie) session: 14 days from sign-in, never extended. Desktop sessions are the
 * devices (`GET /v1/devices`). No IP address or browser name is stored, so there is none to show.
 */
export interface CloudBrowserSession {
  createdAt: IsoUtc;
  expiresAt: IsoUtc;
  /** True for the session making the request. */
  current: boolean;
}

/** GET /v1/sessions. */
export interface SessionsResponse {
  /** Newest first. */
  browser: CloudBrowserSession[];
}

/**
 * POST /v1/sessions/revoke-others: signs out every other browser, and with `includeDevices`
 * every other connected computer too (their devices and uploaded stats stay; each one must
 * sign in again). The calling session always stays. `includeDevices: true` needs a session
 * younger than `CLOUD_LIMITS.freshSessionMinutes` (403 `reauth_required`).
 */
export interface RevokeOtherSessionsRequest {
  includeDevices?: boolean;
}

export interface RevokeOtherSessionsResponse {
  /** Sessions ended, by kind. */
  browser: number;
  devices: number;
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

/** An accountability event as the app records it (and the outbox keeps it). Times are on the
 *  app's own clock, which may be wrong: the server reads them relative to `sentAt`. */
export interface AccountabilityEventInput {
  clientRef: string;
  kind: AccountabilityKind;
  occurredAt: IsoUtc;
  /** For `emergency_requested`: when the local countdown ends. */
  countdownEndsAt: IsoUtc | null;
}

/**
 * POST /v1/accountability/events. Idempotent on `clientRef` (queued offline by the app).
 * `sentAt` is the app's clock when sending (the client sets it on every attempt): the server
 * only uses `occurredAt − sentAt` and `countdownEndsAt − sentAt`, so a computer clock that is
 * minutes or hours off shifts nothing (docs/API.md §9).
 */
export interface PostAccountabilityEventRequest extends AccountabilityEventInput {
  sentAt: IsoUtc;
}

/**
 * `expired` is computed on read (pending past its deadline). The app treats `expired`,
 * errors and being offline as approved: the flow fails open and never blocks the guardian.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalState {
  status: ApprovalStatus;
  /** On the server's clock, for showing partners until when they can answer. The owner's app
   *  never compares it with its own clock: `approvalOutcome` uses the local countdown. */
  deadline: IsoUtc;
  /** Optional note from the partner. */
  note: string | null;
  decidedAt: IsoUtc | null;
}

export interface PostAccountabilityEventResponse {
  /** Null when no partner hears about the event (none, or none accepted before it): the
   *  server kept nothing (200). The outbox drops it like any success. */
  eventId: string | null;
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
  /**
   * Study days from `today` to `coversUntil` (at most `CLOUD_LIMITS.studyPlanMaxDays`
   * calendar days, never the exam day), ascending, each within `dailyMinutes`. Days off and
   * days the model left empty are missing.
   */
  days: StudyPlanDay[];
  advice: string[];
  /**
   * Last calendar day the plan was made for: the day before the exam, or `today +
   * studyPlanMaxDays − 1` when the exam is further away.
   */
  coversUntil: LocalDay;
  /**
   * True when the plan stops before the day before the exam (the exam is more than
   * `studyPlanMaxDays` days away). The app says «Este plan llega hasta el …; pide el resto más
   * adelante» and asks again, with a later `today`, when the plan runs out.
   */
  truncated: boolean;
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

/**
 * Every row about the user. Other people appear only as id and display name. Secrets (tokens,
 * code hashes) are the only stored values left out.
 */
export interface CloudExport {
  schemaVersion: 1;
  exportedAt: IsoUtc;
  me: MeResponse;
  /**
   * Linked sign-in providers (Google), with the user's id there (Google's subject id). Email
   * codes are not a stored login method: they work for whoever reads the mailbox.
   */
  loginMethods: Array<{ provider: string; accountId: string; createdAt: IsoUtc }>;
  sessions: Array<{ createdAt: IsoUtc; expiresAt: IsoUtc; current: boolean }>;
  /** `installId`: the random id the app keeps for that installation. */
  devices: Array<CloudDevice & { installId: string }>;
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
  /** Small daily anti-abuse counters (e.g. partner emails received), kept 7 days. */
  usageCounters: Array<{ day: LocalDay; key: string; count: number }>;
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
// Client and offline outbox (owned by the CLIENT builder, see docs/API.md §14)
// ---------------------------------------------------------------------------------------
//
// Only the desktop main process calls the API. Every call is optional: short timeouts, typed
// errors that say whether a retry makes sense, and an outbox for what must eventually arrive
// (daily totals, accountability events). Pure TypeScript on web-platform globals (`fetch`,
// `AbortController`, `URL`), no Node imports, so it runs in Node, Electron and tests alike.

/**
 * How a call failed:
 * - `offline`: no answer at all (no network, DNS, TLS, refused connection, a redirect).
 * - `timeout`: no answer within the call's timeout (a cold start takes about a minute).
 * - `aborted`: the caller cancelled it through its `signal`.
 * - `http`: the server answered with an error status. `code` is set when the body is our error
 *   envelope; a proxy or gateway page (Render while it deploys) has `code: null`.
 * - `invalid_response`: a 2xx answer that is not the expected JSON (a captive portal, a proxy).
 */
export type CloudErrorKind = 'offline' | 'timeout' | 'aborted' | 'http' | 'invalid_response';

export interface CloudErrorInit {
  kind: CloudErrorKind;
  /** The client method, e.g. `putDays`. Safe to log (never a URL, code or token). */
  operation: string;
  status?: number | null;
  details?: CloudErrorBody['error'] | null;
  retryAfterMs?: number | null;
  cause?: unknown;
}

/**
 * The only error the client throws for a call. `retryable` says whether the app may send the
 * same request again by itself: network errors, timeouts, bad gateways, 429 `rate_limited` and
 * 5xx answers, except `feature_disabled` (a configuration, unless the database is down),
 * `not_implemented` and `coach_incomplete`. Never other 4xx. Coach calls that run the model
 * (`interpret`, `splitTask`, `studyPlan`, `weeklySummary`) are stricter, because a lost answer
 * may still have been billed and counted: only 429 `rate_limited` and `feature_disabled` with
 * `database_down` (both answered before the model) are retryable; after anything else only the
 * user may try again. A failed wake-up before a coach call reports `operation: 'health'` and
 * follows the general rule (nothing reached the model). On 401 the app signs out and keeps
 * every local data (`isUnauthorized`).
 */
export class CloudError extends Error {
  readonly kind: CloudErrorKind;
  readonly operation: string;
  readonly status: number | null;
  readonly code: CloudErrorCode | null;
  /** The error envelope's extras (`feature`, `reason`, `consent`, `issues`, `resetsAt`…). */
  readonly details: CloudErrorBody['error'] | null;
  readonly retryable: boolean;
  /** How long the server asked us to wait (`Retry-After`, or until `resetsAt`). */
  readonly retryAfterMs: number | null;

  constructor(init: CloudErrorInit) {
    const status = init.status ?? null;
    const details = init.details ?? null;
    const what = init.kind === 'http' ? `HTTP ${status ?? '?'} ${details?.code ?? ''}` : init.kind;
    super(`Cloud ${init.operation} failed: ${what.trim()}`, { cause: init.cause });
    this.name = 'CloudError';
    this.kind = init.kind;
    this.operation = init.operation;
    this.status = status;
    this.code = details?.code ?? null;
    this.details = details;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.retryable = COACH_MODEL_OPERATIONS.has(init.operation)
      ? isCoachRetryable(init.kind, status, details)
      : isRetryable(init.kind, status, details);
  }

  /** The session is gone (expired, revoked, account deleted): sign out, keep local data. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function isCloudError(value: unknown): value is CloudError {
  return value instanceof CloudError;
}

function isRetryable(
  kind: CloudErrorKind,
  status: number | null,
  details: CloudErrorBody['error'] | null,
): boolean {
  if (kind === 'offline' || kind === 'timeout' || kind === 'invalid_response') return true;
  if (kind === 'aborted' || status === null) return false;
  const code = details?.code ?? null;
  if (status === 408) return true;
  if (status === 429) return code !== 'quota_exceeded';
  if (status >= 500) {
    if (code === 'feature_disabled') return details?.reason === 'database_down';
    return code !== 'not_implemented' && code !== 'coach_incomplete';
  }
  return false;
}

/** Client methods whose request runs the model (and may be billed once it was sent). */
const COACH_MODEL_OPERATIONS: ReadonlySet<string> = new Set([
  'interpret',
  'splitTask',
  'studyPlan',
  'weeklySummary',
]);

/**
 * A coach request is safe to resend only when the server answered before reserving quota and
 * calling the model: 429 `rate_limited` (another coach call in flight, or the request rate) and
 * the database down at the gate. A timeout, a lost connection, a non-JSON answer or another 5xx
 * (`coach_unavailable`, a proxy page) may come after the model ran: resending would count and
 * bill it again.
 */
function isCoachRetryable(
  kind: CloudErrorKind,
  status: number | null,
  details: CloudErrorBody['error'] | null,
): boolean {
  if (kind !== 'http') return false;
  const code = details?.code ?? null;
  if (status === 429) return code === 'rate_limited';
  if (status === 503 && code === 'feature_disabled') return details?.reason === 'database_down';
  return false;
}

/** Which timeout a call uses by default (see `CLOUD_TIMEOUTS`). */
export type CloudCallClass = 'background' | 'interactive' | 'coach';

export interface CloudCallOptions {
  /** Overrides the call's default timeout, in milliseconds. */
  timeoutMs?: number;
  /** Cancels the call (`CloudError` with kind `aborted`). */
  signal?: AbortSignal;
}

/**
 * Options of the calls that wake a sleeping server first: the coach calls that run the model
 * and `postAccountabilityEvent`. When the server has not answered this client for
 * `CLOUD_TIMEOUTS.awakeMs`, the call first wakes it with `GET /health` (interactive timeout,
 * same `signal`) and only then sends its request, with `timeoutMs` (default: the call's own
 * class, `coachMs` for the coach). A failed wake-up rejects with `operation: 'health'`:
 * nothing was sent, billed or stored.
 */
export interface WakeCallOptions extends CloudCallOptions {
  /** Called just before a wake-up: show «Despertando el servidor…». */
  onWaking?: () => void;
}

/** Options of the coach calls that run the model (see `WakeCallOptions`). */
export type CoachCallOptions = WakeCallOptions;

/** What the client needs from `fetch`. The global `fetch` and Electron's `net.fetch` fit. */
export type CloudFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    credentials: 'omit';
    cache: 'no-store';
    redirect: 'error';
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface CloudClientOptions {
  /** The API origin, e.g. `https://centrate-api.onrender.com`. */
  baseUrl: string;
  /** The bearer token (kept in Electron `safeStorage`), or null when signed out. */
  getToken: () => string | null | Promise<string | null>;
  /** Defaults to the global `fetch`. */
  fetch?: CloudFetch;
  timeouts?: Partial<Record<keyof typeof CLOUD_TIMEOUTS, number>>;
  /** Called when the server answers 401 to a signed-in call: sign out, keep local data. */
  onUnauthorized?: () => void;
  /** Clock for `Retry-After` dates, `resetsAt`, the wake-up rule and an event's `sentAt`
   *  (tests pass a fake one). */
  now?: () => Date;
}

/** One typed method per endpoint of docs/API.md §5. Every method rejects with `CloudError`. */
export interface CloudClient {
  readonly baseUrl: string;

  /**
   * GET /health (public). Also wakes a sleeping server: call it at app start. Coach calls do it
   * themselves when the server has not answered for `awakeMs`.
   */
  health(options?: CloudCallOptions): Promise<HealthResponse>;
  /** POST /v1/app-auth/token (public): trades the loopback code for a bearer token. */
  exchangeLoginCode(body: AppTokenRequest, options?: CloudCallOptions): Promise<AppTokenResponse>;
  /** POST /v1/app-auth/logout: ends this session. The device and its stats stay. */
  logout(options?: CloudCallOptions): Promise<void>;

  getMe(options?: CloudCallOptions): Promise<MeResponse>;
  updateMe(body: PatchMeRequest, options?: CloudCallOptions): Promise<MeResponse>;
  /** GET /v1/me/export: every row about the user (GDPR). */
  exportData(options?: CloudCallOptions): Promise<CloudExport>;
  /** DELETE /v1/me. `reauth_required` (403) when the session is older than 15 minutes. */
  deleteAccount(options?: CloudCallOptions): Promise<void>;
  listDevices(options?: CloudCallOptions): Promise<DevicesResponse>;
  renameDevice(deviceId: string, name: string, options?: CloudCallOptions): Promise<CloudDevice>;
  /** DELETE /v1/devices/:id: the device, its stats and its session. */
  removeDevice(deviceId: string, options?: CloudCallOptions): Promise<void>;

  getSyncState(deviceId: string, options?: CloudCallOptions): Promise<SyncStateResponse>;
  /** PUT /v1/sync/days. Use the outbox (`createOutbox`) rather than calling it directly. */
  putDays(body: PutDaysRequest, options?: CloudCallOptions): Promise<PutDaysResponse>;
  /** DELETE /v1/sync/days: this user's cloud stats (all devices, or one). */
  deleteSyncedDays(deviceId?: string | null, options?: CloudCallOptions): Promise<void>;
  getStats(from: LocalDay, to: LocalDay, options?: CloudCallOptions): Promise<StatsResponse>;

  createInvite(
    body?: CreateInviteRequest,
    options?: CloudCallOptions,
  ): Promise<CreateInviteResponse>;
  listInvites(options?: CloudCallOptions): Promise<InvitesResponse>;
  revokeInvite(inviteId: string, options?: CloudCallOptions): Promise<void>;
  previewInvite(code: string, options?: CloudCallOptions): Promise<InvitePreviewResponse>;
  acceptInvite(code: string, options?: CloudCallOptions): Promise<AcceptInviteResponse>;
  listFriends(options?: CloudCallOptions): Promise<FriendsResponse>;
  removeFriend(userId: string, options?: CloudCallOptions): Promise<void>;
  listBlocks(options?: CloudCallOptions): Promise<BlocksResponse>;
  blockUser(userId: string, options?: CloudCallOptions): Promise<void>;
  unblockUser(userId: string, options?: CloudCallOptions): Promise<void>;
  /** GET /v1/ranking. Without `week`, the current ISO week in the profile's zone. */
  getRanking(week?: IsoWeek | null, options?: CloudCallOptions): Promise<RankingResponse>;
  /** PUT /v1/presence: a heartbeat every 60 s. Never queue it. */
  putPresence(body: PutPresenceRequest, options?: CloudCallOptions): Promise<PutPresenceResponse>;
  clearPresence(options?: CloudCallOptions): Promise<void>;
  getFriendsPresence(options?: CloudCallOptions): Promise<FriendsPresenceResponse>;

  listPartners(options?: CloudCallOptions): Promise<PartnersResponse>;
  proposePartner(body: CreatePartnerRequest, options?: CloudCallOptions): Promise<PartnerLink>;
  acceptPartner(linkId: string, options?: CloudCallOptions): Promise<PartnerLink>;
  updatePartner(
    linkId: string,
    body: PatchPartnerRequest,
    options?: CloudCallOptions,
  ): Promise<PartnerLink>;
  /** DELETE /v1/partners/:id: null when removed now, the link when it ends in 24 h. */
  removePartner(linkId: string, options?: CloudCallOptions): Promise<PartnerLink | null>;
  /**
   * POST /v1/accountability/events: the answer carries the `eventId` and `approval` the app
   * polls. Wakes a server that has not answered lately first (`WakeCallOptions`), so a cold
   * start never eats into the request's own timeout (background 10 s), then sets `sentAt` from
   * `now()`, on every call, so the server reads the times against the moment it really left.
   * A replayed `clientRef` is harmless: the server answers the stored event (200).
   *
   * Do not call it directly for app events: send an `emergency_requested` with
   * `sendAccountabilityEvent` (it falls back to the outbox) and queue the other kinds with
   * `CloudOutbox.addEvent`.
   */
  postAccountabilityEvent(
    body: AccountabilityEventInput,
    options?: WakeCallOptions,
  ): Promise<PostAccountabilityEventResponse>;
  /** The owner polls it every 15 s while an approval is pending (never queue it). */
  getAccountabilityEvent(
    eventId: string,
    options?: CloudCallOptions,
  ): Promise<AccountabilityEventResponse>;
  getInbox(options?: CloudCallOptions): Promise<InboxResponse>;
  decideApproval(
    eventId: string,
    body: ApprovalDecisionRequest,
    options?: CloudCallOptions,
  ): Promise<ApprovalState>;

  getCoachQuota(options?: CloudCallOptions): Promise<CoachQuotaResponse>;
  /**
   * The four model calls wake a sleeping server first (`CoachCallOptions`) and are never
   * resent automatically after a timeout or a 5xx (see `CloudError.retryable`).
   */
  interpret(body: InterpretRequest, options?: CoachCallOptions): Promise<InterpretResponse>;
  splitTask(body: SplitTaskRequest, options?: CoachCallOptions): Promise<SplitTaskResponse>;
  studyPlan(body: StudyPlanRequest, options?: CoachCallOptions): Promise<StudyPlanResponse>;
  weeklySummary(
    body: WeeklySummaryRequest,
    options?: CoachCallOptions,
  ): Promise<WeeklySummaryResponse>;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallSpec {
  operation: string;
  method: HttpMethod;
  /** Path with its parameters already encoded (`seg`). */
  path: string;
  query?: Record<string, string | null | undefined>;
  body?: unknown;
  /** Sends the bearer token. Public routes: /health and the login code exchange. */
  auth: boolean;
  timeout: CloudCallClass;
}

interface CallResult {
  status: number;
  /** Parsed JSON, or null for an empty answer (204). */
  data: unknown;
}

/** Longest wait a `Retry-After` or `resetsAt` may ask for (a day). */
const RETRY_AFTER_CAP_MS = 86_400_000;

/** A path segment from a caller value (ids, invite codes). */
const seg = (value: string): string => encodeURIComponent(value);

function defaultFetch(): CloudFetch {
  if (typeof fetch !== 'function') {
    throw new TypeError('createCloudClient: no fetch implementation available');
  }
  return (url, init) => fetch(url, init);
}

function normalizeBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('createCloudClient: baseUrl must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('createCloudClient: baseUrl must be an absolute http(s) URL');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new TypeError('createCloudClient: baseUrl cannot carry a query, fragment or login');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function parseRetryAfter(header: string | null, now: Date): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now.getTime()), RETRY_AFTER_CAP_MS);
}

function errorEnvelope(data: unknown): CloudErrorBody['error'] | null {
  if (typeof data !== 'object' || data === null) return null;
  const error = (data as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !(CLOUD_ERROR_CODES as readonly string[]).includes(code)) {
    return null;
  }
  return {
    ...(error as CloudErrorBody['error']),
    message: typeof message === 'string' ? message : '',
  };
}

function retryAfterOf(
  headers: { get(name: string): string | null },
  details: CloudErrorBody['error'] | null,
  now: Date,
): number | null {
  const fromHeader = parseRetryAfter(headers.get('retry-after'), now);
  if (fromHeader !== null) return fromHeader;
  if (details?.retryAfterSeconds !== undefined && Number.isFinite(details.retryAfterSeconds)) {
    return Math.min(Math.max(0, details.retryAfterSeconds * 1000), RETRY_AFTER_CAP_MS);
  }
  if (details?.resetsAt) {
    const at = Date.parse(details.resetsAt);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - now.getTime()), RETRY_AFTER_CAP_MS);
  }
  return null;
}

/**
 * The typed client of the Céntrate API (docs/API.md §5 and §14). One method per endpoint; each
 * uses the timeout of its class (background 10 s, interactive 60 s, coach 100 s) unless the
 * call passes `timeoutMs`. Coach model calls and `postAccountabilityEvent` first wake a server
 * that has not answered for 10 minutes. It never retries by itself: background work goes
 * through the outbox.
 */
export function createCloudClient(options: CloudClientOptions): CloudClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const doFetch: CloudFetch = options.fetch ?? defaultFetch();
  const timeouts = {
    background: options.timeouts?.backgroundMs ?? CLOUD_TIMEOUTS.backgroundMs,
    interactive: options.timeouts?.interactiveMs ?? CLOUD_TIMEOUTS.interactiveMs,
    coach: options.timeouts?.coachMs ?? CLOUD_TIMEOUTS.coachMs,
  };
  const awakeMs = options.timeouts?.awakeMs ?? CLOUD_TIMEOUTS.awakeMs;
  const now = options.now ?? (() => new Date());
  /** When our server last answered (a JSON answer of ours, success or error envelope). */
  let lastAnswerAt: number | null = null;
  const markAwake = (): void => {
    lastAnswerAt = now().getTime();
  };
  const isAwake = (): boolean => {
    if (lastAnswerAt === null) return false;
    const elapsed = now().getTime() - lastAnswerAt;
    // A clock set back counts as asleep: waking costs one small request.
    return elapsed >= 0 && elapsed < awakeMs;
  };

  async function call(spec: CallSpec, callOptions: CloudCallOptions = {}): Promise<CallResult> {
    const { operation } = spec;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (spec.auth) {
      const token = await options.getToken();
      if (!token) {
        throw new CloudError({
          kind: 'http',
          operation,
          status: 401,
          details: { code: 'unauthorized', message: 'Not signed in' },
        });
      }
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (spec.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }
    let url = `${baseUrl}${spec.path}`;
    const query = Object.entries(spec.query ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    if (query.length > 0) url += `?${new URLSearchParams(query).toString()}`;

    const signal = callOptions.signal;
    if (signal?.aborted) throw new CloudError({ kind: 'aborted', operation });
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = callOptions.timeoutMs ?? timeouts[spec.timeout];
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    // Settles on abort even if a fetch implementation ignores its signal.
    const abandoned = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });

    let status: number;
    let responseHeaders: { get(name: string): string | null };
    let text: string;
    try {
      const exchange = (async () => {
        const res = await doFetch(url, {
          method: spec.method,
          headers,
          body,
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
        });
        return { status: res.status, headers: res.headers, text: await res.text() };
      })();
      const answer = await Promise.race([exchange, abandoned]);
      status = answer.status;
      responseHeaders = answer.headers;
      text = answer.text;
    } catch (cause) {
      if (timedOut) throw new CloudError({ kind: 'timeout', operation, cause });
      if (signal?.aborted) throw new CloudError({ kind: 'aborted', operation, cause });
      throw new CloudError({ kind: 'offline', operation, cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
      abandoned.catch(() => undefined);
    }

    let data: unknown = null;
    let parsed = true;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        parsed = false;
      }
    }
    if (status >= 200 && status < 300) {
      const empty = status === 204 || text.length === 0;
      if (!parsed || (!empty && (typeof data !== 'object' || data === null))) {
        throw new CloudError({ kind: 'invalid_response', operation, status });
      }
      markAwake();
      return { status, data: empty ? null : data };
    }
    const details = parsed ? errorEnvelope(data) : null;
    // Our error envelope means the service itself answered; a proxy page does not.
    if (details) markAwake();
    const error = new CloudError({
      kind: 'http',
      operation,
      status,
      details,
      retryAfterMs: retryAfterOf(responseHeaders, details, now()),
    });
    if (status === 401 && spec.auth && options.onUnauthorized) {
      try {
        options.onUnauthorized();
      } catch {
        // The app's handler must not turn one failed call into another error.
      }
    }
    throw error;
  }

  /** A call whose success carries a JSON body of type T. */
  async function json<T>(spec: CallSpec, callOptions?: CloudCallOptions): Promise<T> {
    const { status, data } = await call(spec, callOptions);
    if (data === null) {
      throw new CloudError({ kind: 'invalid_response', operation: spec.operation, status });
    }
    return data as T;
  }

  /** A call whose success carries nothing we need (204). */
  async function empty(spec: CallSpec, callOptions?: CloudCallOptions): Promise<void> {
    await call(spec, callOptions);
  }

  const healthSpec: CallSpec = {
    operation: 'health',
    method: 'GET',
    path: '/health',
    auth: false,
    timeout: 'background',
  };

  /**
   * Wakes a server that has not answered lately with `GET /health` (interactive timeout), so a
   * cold start never eats into the timeout of the request that follows.
   */
  async function wakeIfAsleep(callOptions: WakeCallOptions): Promise<void> {
    const { onWaking, signal } = callOptions;
    if (isAwake()) return;
    if (onWaking && !signal?.aborted) {
      try {
        onWaking();
      } catch {
        // A UI callback must not fail the call.
      }
    }
    await json<HealthResponse>(healthSpec, { timeoutMs: timeouts.interactive, signal });
  }

  /** A coach model call: wakes the server if needed, then sends with the coach timeout. */
  async function coach<T>(spec: CallSpec, callOptions: CoachCallOptions = {}): Promise<T> {
    const { timeoutMs, signal } = callOptions;
    await wakeIfAsleep(callOptions);
    return json<T>(spec, { timeoutMs, signal });
  }

  const get = (operation: string, path: string, timeout: CloudCallClass): CallSpec => ({
    operation,
    method: 'GET',
    path,
    auth: true,
    timeout,
  });
  const send = (
    operation: string,
    method: HttpMethod,
    path: string,
    body: unknown,
    timeout: CloudCallClass,
  ): CallSpec => ({ operation, method, path, body, auth: true, timeout });

  return {
    baseUrl,

    health: (o) => json(healthSpec, o),
    exchangeLoginCode: (body, o) =>
      json(
        {
          operation: 'exchangeLoginCode',
          method: 'POST',
          path: '/v1/app-auth/token',
          body,
          auth: false,
          timeout: 'interactive',
        },
        o,
      ),
    logout: (o) => empty(send('logout', 'POST', '/v1/app-auth/logout', undefined, 'background'), o),

    getMe: (o) => json(get('getMe', '/v1/me', 'interactive'), o),
    updateMe: (body, o) => json(send('updateMe', 'PATCH', '/v1/me', body, 'interactive'), o),
    exportData: (o) => json(get('exportData', '/v1/me/export', 'interactive'), o),
    deleteAccount: (o) => {
      const body: DeleteAccountRequest = { confirm: 'BORRAR' };
      return empty(send('deleteAccount', 'DELETE', '/v1/me', body, 'interactive'), o);
    },
    listDevices: (o) => json(get('listDevices', '/v1/devices', 'interactive'), o),
    renameDevice: (deviceId, name, o) => {
      const body: PatchDeviceRequest = { name };
      return json(
        send('renameDevice', 'PATCH', `/v1/devices/${seg(deviceId)}`, body, 'interactive'),
        o,
      );
    },
    removeDevice: (deviceId, o) =>
      empty(
        send('removeDevice', 'DELETE', `/v1/devices/${seg(deviceId)}`, undefined, 'interactive'),
        o,
      ),

    getSyncState: (deviceId, o) =>
      json({ ...get('getSyncState', '/v1/sync/state', 'background'), query: { deviceId } }, o),
    putDays: (body, o) => json(send('putDays', 'PUT', '/v1/sync/days', body, 'background'), o),
    deleteSyncedDays: (deviceId, o) =>
      empty(
        {
          ...send('deleteSyncedDays', 'DELETE', '/v1/sync/days', undefined, 'interactive'),
          query: { deviceId },
        },
        o,
      ),
    getStats: (from, to, o) =>
      json({ ...get('getStats', '/v1/stats', 'interactive'), query: { from, to } }, o),

    createInvite: (body, o) =>
      json(send('createInvite', 'POST', '/v1/friends/invites', body ?? {}, 'interactive'), o),
    listInvites: (o) => json(get('listInvites', '/v1/friends/invites', 'interactive'), o),
    revokeInvite: (inviteId, o) =>
      empty(
        send(
          'revokeInvite',
          'DELETE',
          `/v1/friends/invites/${seg(inviteId)}`,
          undefined,
          'interactive',
        ),
        o,
      ),
    previewInvite: (code, o) =>
      json(get('previewInvite', `/v1/friends/invites/${seg(code)}`, 'interactive'), o),
    acceptInvite: (code, o) =>
      json(
        send('acceptInvite', 'POST', `/v1/friends/invites/${seg(code)}/accept`, {}, 'interactive'),
        o,
      ),
    listFriends: (o) => json(get('listFriends', '/v1/friends', 'interactive'), o),
    removeFriend: (userId, o) =>
      empty(
        send('removeFriend', 'DELETE', `/v1/friends/${seg(userId)}`, undefined, 'interactive'),
        o,
      ),
    listBlocks: (o) => json(get('listBlocks', '/v1/blocks', 'interactive'), o),
    blockUser: (userId, o) => {
      const body: BlockUserRequest = { userId };
      return empty(send('blockUser', 'POST', '/v1/blocks', body, 'interactive'), o);
    },
    unblockUser: (userId, o) =>
      empty(
        send('unblockUser', 'DELETE', `/v1/blocks/${seg(userId)}`, undefined, 'interactive'),
        o,
      ),
    getRanking: (week, o) =>
      json({ ...get('getRanking', '/v1/ranking', 'interactive'), query: { week } }, o),
    putPresence: (body, o) =>
      json(send('putPresence', 'PUT', '/v1/presence', body, 'background'), o),
    clearPresence: (o) =>
      empty(send('clearPresence', 'DELETE', '/v1/presence', undefined, 'background'), o),
    getFriendsPresence: (o) =>
      json(get('getFriendsPresence', '/v1/friends/presence', 'background'), o),

    listPartners: (o) => json(get('listPartners', '/v1/partners', 'interactive'), o),
    proposePartner: (body, o) =>
      json(send('proposePartner', 'POST', '/v1/partners', body, 'interactive'), o),
    acceptPartner: (linkId, o) =>
      json(
        send('acceptPartner', 'POST', `/v1/partners/${seg(linkId)}/accept`, {}, 'interactive'),
        o,
      ),
    updatePartner: (linkId, body, o) =>
      json(send('updatePartner', 'PATCH', `/v1/partners/${seg(linkId)}`, body, 'interactive'), o),
    removePartner: async (linkId, o) => {
      const { data } = await call(
        send('removePartner', 'DELETE', `/v1/partners/${seg(linkId)}`, undefined, 'interactive'),
        o,
      );
      return data === null ? null : (data as PartnerLink);
    },
    postAccountabilityEvent: async (body, o = {}) => {
      const { timeoutMs, signal } = o;
      await wakeIfAsleep(o);
      // Stamped after the wake-up: `countdownEndsAt − sentAt` is what is really left.
      const request: PostAccountabilityEventRequest = {
        clientRef: body.clientRef,
        kind: body.kind,
        occurredAt: body.occurredAt,
        countdownEndsAt: body.countdownEndsAt,
        sentAt: now().toISOString(),
      };
      return json(
        send('postAccountabilityEvent', 'POST', '/v1/accountability/events', request, 'background'),
        { timeoutMs, signal },
      );
    },
    getAccountabilityEvent: (eventId, o) =>
      json(
        get('getAccountabilityEvent', `/v1/accountability/events/${seg(eventId)}`, 'background'),
        o,
      ),
    getInbox: (o) => json(get('getInbox', '/v1/accountability/inbox', 'background'), o),
    decideApproval: (eventId, body, o) =>
      json(
        send(
          'decideApproval',
          'POST',
          `/v1/accountability/events/${seg(eventId)}/decision`,
          body,
          'interactive',
        ),
        o,
      ),

    getCoachQuota: (o) => json(get('getCoachQuota', '/v1/coach/quota', 'interactive'), o),
    interpret: (body, o) =>
      coach(send('interpret', 'POST', '/v1/coach/interpret', body, 'coach'), o),
    splitTask: (body, o) =>
      coach(send('splitTask', 'POST', '/v1/coach/split-task', body, 'coach'), o),
    studyPlan: (body, o) =>
      coach(send('studyPlan', 'POST', '/v1/coach/study-plan', body, 'coach'), o),
    weeklySummary: (body, o) =>
      coach(send('weeklySummary', 'POST', '/v1/coach/weekly-summary', body, 'coach'), o),
  };
}

// ---------------------------------------------------------------------------------------
// Accountability approvals and re-uploads (pure)
// ---------------------------------------------------------------------------------------

/**
 * What the app does with an emergency request's approval (docs/API.md §9):
 * - `wait` while the last answer is `pending` and the local countdown runs (the guardian's
 *   countdown keeps running anyway);
 * - `denied` only after an explicit «no»: the app cancels this request, the block stays;
 * - `approved` for everything else: approved, no approval needed (`null`), or the deadline
 *   passed without an answer (`expired`).
 *
 * `countdownEndsAt` is the one sent with the request, on the app's clock like `now`; the
 * server's `approval.deadline` is on another clock and is never compared with `now`. The
 * server ends its deadline `approvalMarginSeconds` before that countdown, so an app polling
 * every 15 s reads the last answer before its countdown ends, whatever either clock says.
 * The flow fails open: when polling fails (offline, timeout, 5xx) the app keeps the last state
 * it knew, and a `pending` state turns into `approved` when the local countdown ends.
 */
export function approvalOutcome(
  approval: ApprovalState | null,
  now: Date,
  countdownEndsAt: Date | IsoUtc,
): 'wait' | 'approved' | 'denied' {
  if (approval === null) return 'approved';
  if (approval.status === 'denied') return 'denied';
  if (approval.status !== 'pending') return 'approved';
  const end =
    countdownEndsAt instanceof Date ? countdownEndsAt.getTime() : Date.parse(countdownEndsAt);
  return Number.isNaN(end) || end <= now.getTime() ? 'approved' : 'wait';
}

/**
 * Whether `/health` proves the cloud was reset since the app last saw it: only when the
 * database answers (`db: 'up'`) with an epoch that differs from the remembered one. A `null`
 * epoch (database unconfigured, down, or its probe failed: a free database in its grace
 * period, a brief outage) or nothing remembered yet means «unknown»: keep the token, the
 * device id and the outbox. The app remembers `health.serverEpoch` whenever it is a string and
 * never overwrites it with `null`. docs/API.md §7.
 */
export function cloudWasReset(
  rememberedEpoch: string | null,
  health: Pick<HealthResponse, 'db' | 'serverEpoch'>,
): boolean {
  return (
    health.db === 'up' &&
    typeof rememberedEpoch === 'string' &&
    rememberedEpoch !== '' &&
    typeof health.serverEpoch === 'string' &&
    health.serverEpoch !== '' &&
    health.serverEpoch !== rememberedEpoch
  );
}

/**
 * The local days to send again after a sign-in: those the server is missing or holds at the
 * same or a lower `rev`. An equal `rev` goes too: a running block grows a day's minutes without
 * a new guardian event, so the server may hold older numbers under the same `rev` (the outbox
 * was cleared by a sign-out or a 401 before the last snapshot went out), and it lets an equal
 * `rev` overwrite. Cheap: the whole accepted window (`syncPastDays`) is a few requests of 100.
 *
 * Use it on every sign-in with a device id (`GET /v1/sync/state` for it), and after the
 * database was replaced (`cloudWasReset`). A replaced database has no accounts either: the old
 * token gets 401, so the app first logs in again (a new account and device, every sharing
 * switch off), re-applies the sharing choices the user confirms (at least `syncStats`), then
 * passes `GET /v1/sync/state` for the new device. docs/API.md §7.
 */
export function daysToReupload(
  local: readonly CloudDayStats[],
  server: Pick<SyncStateResponse, 'revs'>,
): CloudDayStats[] {
  const revs = new Map(server.revs.map((r) => [r.day, r.rev]));
  return local.filter((d) => {
    const rev = revs.get(d.day);
    return rev === undefined || rev <= d.rev;
  });
}

/** A random `clientRef` for an accountability event (36 hex characters). */
export function newClientRef(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------
// Offline outbox
// ---------------------------------------------------------------------------------------

export const CLOUD_OUTBOX = Object.freeze({
  /** Backoff after a failed flush: 30 s, growing with jitter up to 30 min. */
  retryMinMs: 30_000,
  retryMaxMs: 30 * 60_000,
  /** Longest server-requested wait honoured (`Retry-After` of the hourly sync limit). */
  retryAfterMaxMs: 6 * 3_600_000,
  /** The server rejects events older than this (`occurredAt`), so the outbox drops them. */
  eventMaxAgeMs: 7 * 86_400_000,
  /** Safety bound on requests per flush. */
  maxRequestsPerFlush: 200,
});

const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Absolute totals of one local day of one device (collapsed by device and day). */
export interface OutboxDayItem {
  type: 'day';
  deviceId: string;
  stats: CloudDayStats;
}

/** An accountability event, kept with its `clientRef` until the server has it. */
export interface OutboxEventItem {
  type: 'event';
  event: AccountabilityEventInput;
}

export type OutboxItem = OutboxDayItem | OutboxEventItem;

/** What the app persists (in its SQLite). Presence heartbeats and polls are never queued. */
export interface OutboxState {
  version: 1;
  items: OutboxItem[];
  /** Consecutive failed flushes; drives the backoff. */
  failures: number;
  /** No flush before this instant (backoff or `Retry-After`) unless forced. */
  notBefore: IsoUtc | null;
}

export interface OutboxStorage {
  /** The saved state, or null the first time. Anything malformed is ignored item by item. */
  load(): OutboxState | null | Promise<OutboxState | null>;
  save(state: OutboxState): void | Promise<void>;
}

export const emptyOutboxState = (): OutboxState => ({
  version: 1,
  items: [],
  failures: 0,
  notBefore: null,
});

/** Keeps the items that are well formed (a hand-edited or older database cannot poison it). */
export function normalizeOutboxState(raw: unknown): OutboxState {
  if (typeof raw !== 'object' || raw === null) return emptyOutboxState();
  const r = raw as Partial<Record<keyof OutboxState, unknown>>;
  const items = Array.isArray(r.items) ? r.items.filter(isOutboxItem) : [];
  const failures =
    typeof r.failures === 'number' && Number.isInteger(r.failures) && r.failures > 0
      ? Math.min(r.failures, 1000)
      : 0;
  const notBefore =
    typeof r.notBefore === 'string' && !Number.isNaN(Date.parse(r.notBefore)) ? r.notBefore : null;
  return { version: 1, items: coalesceOutbox(items), failures, notBefore };
}

function isDayStats(value: unknown): value is CloudDayStats {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  if (!isLocalDay(d.day)) return false;
  return DAY_NUMBER_KEYS.every((k) => typeof d[k] === 'number' && Number.isInteger(d[k]));
}

const DAY_NUMBER_KEYS = [
  'rev',
  'focusMinutes',
  'studyMinutes',
  'blocksCompleted',
  'studySessions',
  'attempts',
  'emergencyUnlocks',
  'punishments',
  'pointsEarned',
  'pointsLost',
] as const satisfies ReadonlyArray<keyof CloudDayStats>;

function isEvent(value: unknown): value is AccountabilityEventInput {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.clientRef === 'string' &&
    OPAQUE_ID_RE.test(e.clientRef) &&
    typeof e.kind === 'string' &&
    (ACCOUNTABILITY_KINDS as readonly string[]).includes(e.kind) &&
    typeof e.occurredAt === 'string' &&
    !Number.isNaN(Date.parse(e.occurredAt)) &&
    (e.countdownEndsAt === null ||
      (typeof e.countdownEndsAt === 'string' && !Number.isNaN(Date.parse(e.countdownEndsAt))))
  );
}

function isOutboxItem(value: unknown): value is OutboxItem {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item.type === 'day') {
    return typeof item.deviceId === 'string' && item.deviceId !== '' && isDayStats(item.stats);
  }
  return item.type === 'event' && isEvent(item.event);
}

/**
 * Collapses a queue: day items by `(deviceId, day)` keeping the highest `rev` (the later one on
 * a tie, as the server lets an equal `rev` overwrite); events by `clientRef`, keeping the first
 * (the same event queued twice). Events come first, in queue order (a partner is waiting for
 * them); then days by device and ascending day.
 */
export function coalesceOutbox(items: readonly OutboxItem[]): OutboxItem[] {
  const events: OutboxEventItem[] = [];
  const refs = new Set<string>();
  const days = new Map<string, OutboxDayItem>();
  for (const item of items) {
    if (item.type === 'event') {
      if (refs.has(item.event.clientRef)) continue;
      refs.add(item.event.clientRef);
      events.push(item);
    } else {
      const key = `${item.deviceId}\u0000${item.stats.day}`;
      const kept = days.get(key);
      if (!kept || item.stats.rev >= kept.stats.rev) days.set(key, item);
    }
  }
  const sortedDays = [...days.values()].sort((a, b) =>
    a.deviceId === b.deviceId
      ? a.stats.day < b.stats.day
        ? -1
        : a.stats.day > b.stats.day
          ? 1
          : 0
      : a.deviceId < b.deviceId
        ? -1
        : 1,
  );
  return [...events, ...sortedDays];
}

/**
 * Wait before the next flush after `failures` consecutive failures (≥ 1): exponential from
 * 30 s, capped at 30 min, with «equal jitter» (between half and all of the step), never under
 * 30 s. A server `Retry-After` (capped at 6 h) wins when it is longer.
 */
export function nextRetryDelay(
  failures: number,
  random: () => number = Math.random,
  retryAfterMs: number | null = null,
): number {
  const { retryMinMs, retryMaxMs, retryAfterMaxMs } = CLOUD_OUTBOX;
  const n = Math.min(Math.max(1, Math.floor(failures)), 30);
  const step = Math.min(retryMaxMs, retryMinMs * 2 ** (n - 1));
  const r = Math.min(Math.max(random(), 0), 1);
  const delay = Math.max(retryMinMs, Math.round(step / 2 + (r * step) / 2));
  if (retryAfterMs !== null && retryAfterMs > delay) return Math.min(retryAfterMs, retryAfterMaxMs);
  return delay;
}

export interface OutboxFlushResult {
  /**
   * - `empty`: nothing was queued.
   * - `waiting`: backing off; nothing sent (see `nextFlushAt`).
   * - `done`: everything that was queued went out or was dropped.
   * - `retry_later`: the server or the network failed; the rest waits until `nextFlushAt`.
   * - `signed_out`: the server answered 401; the queue was emptied (local data stays).
   */
  status: 'empty' | 'waiting' | 'done' | 'retry_later' | 'signed_out';
  /** Items the server now has. */
  sent: number;
  /** Items dropped because the server can never accept them (old, invalid, sync turned off). */
  dropped: number;
  remaining: number;
  nextFlushAt: Date | null;
  error: CloudError | null;
}

export interface CloudOutbox {
  /** Queues absolute day totals (a newer `rev` of a queued day replaces it). */
  addDays(deviceId: string, days: readonly CloudDayStats[]): Promise<void>;
  /**
   * Queues an accountability event (create its `clientRef` with `newClientRef`). The server's
   * answer arrives through `OutboxOptions.onEventSent`. An `emergency_requested` goes through
   * `sendAccountabilityEvent` instead, which queues it here only when it cannot go out now.
   */
  addEvent(event: AccountabilityEventInput): Promise<void>;
  /**
   * Sends what is queued: events one by one, then days in batches of 100 per device. Runs
   * one at a time (a second call joins the running one). `force` ignores the backoff (the user
   * pressed «Sincronizar ahora», or the network just came back).
   */
  flush(options?: { force?: boolean }): Promise<OutboxFlushResult>;
  pending(): Promise<number>;
  /** When the backoff ends; null when a flush may run now. */
  nextFlushAt(): Promise<Date | null>;
  /** Empties the queue (sign-out, or the user turned sync off). */
  clear(): Promise<void>;
}

export interface OutboxOptions {
  storage: OutboxStorage;
  client: Pick<CloudClient, 'putDays' | 'postAccountabilityEvent'>;
  now?: () => Date;
  random?: () => number;
  /**
   * Called once the server has a queued event (201, or 200 for a replay of one it already
   * stored), with its answer, after the event left the queue. This is how the app learns the
   * `eventId` and `approval` of an `emergency_requested` that could not go out directly: when
   * `approval` is `pending` and the local countdown still runs, it starts polling
   * `getAccountabilityEvent` every 15 s. Not awaited; whatever it throws is ignored.
   */
  onEventSent?: (
    event: AccountabilityEventInput,
    response: PostAccountabilityEventResponse,
  ) => void | Promise<void>;
}

/** An in-memory `OutboxStorage` (tests, or before the app's database is open). */
export function memoryOutboxStorage(initial: OutboxState | null = null): OutboxStorage & {
  readonly state: OutboxState | null;
} {
  let state = initial ? structuredClone(initial) : null;
  return {
    get state() {
      return state;
    },
    load: () => (state ? structuredClone(state) : null),
    save: (next) => {
      state = structuredClone(next);
    },
  };
}

/** Days of a batch that a `validation_failed` answer points at (`body.days.<i>.…`). */
function rejectedDayIndexes(error: CloudError, batchSize: number): Set<number> {
  const out = new Set<number>();
  for (const issue of error.details?.issues ?? []) {
    const m = /^body\.days\.(\d+)(?:\.|$)/.exec(issue.path);
    if (m && Number(m[1]) < batchSize) out.add(Number(m[1]));
  }
  return out;
}

/** Errors that will not go away by resending the same item: drop it. */
function isPermanent(error: CloudError): boolean {
  if (error.retryable || error.status === 401) return false;
  if (error.kind !== 'http' || error.status === null) return false;
  // A server without the feature (missing key) may get it later: keep the items and wait.
  if (error.code === 'feature_disabled' || error.code === 'not_implemented') return false;
  return error.status >= 400 && error.status < 500;
}

/**
 * The offline outbox (docs/API.md §14). What must eventually reach the server waits here,
 * persisted through `storage`, and survives restarts: day totals (collapsed per device and
 * day) and accountability events (never merged away, idempotent on `clientRef`; the server's
 * answer goes to `onEventSent`). Presence heartbeats and approval polls are never queued: an
 * old one means nothing.
 */
export function createOutbox(options: OutboxOptions): CloudOutbox {
  const { storage, client, onEventSent } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  let lock: Promise<unknown> = Promise.resolve();
  let running: Promise<OutboxFlushResult> | null = null;

  /** Hands the server's answer to the app; its handler can never break a flush. */
  function reportSent(
    event: AccountabilityEventInput,
    response: PostAccountabilityEventResponse,
  ): void {
    if (!onEventSent) return;
    try {
      Promise.resolve(onEventSent(event, response)).catch(() => undefined);
    } catch {
      // The app's handler threw synchronously: the event is still sent.
    }
  }

  /** Runs `fn` on the saved state under a lock and saves what it leaves. */
  function mutate<T>(fn: (state: OutboxState) => T): Promise<T> {
    const next = lock.then(async () => {
      const state = normalizeOutboxState(await storage.load());
      const result = fn(state);
      state.items = coalesceOutbox(state.items);
      await storage.save(state);
      return result;
    });
    lock = next.catch(() => undefined);
    return next;
  }

  function read(): Promise<OutboxState> {
    const next = lock.then(async () => normalizeOutboxState(await storage.load()));
    lock = next.catch(() => undefined);
    return next;
  }

  const until = (state: OutboxState): Date | null => {
    if (!state.notBefore) return null;
    const at = new Date(state.notBefore);
    return at.getTime() > now().getTime() ? at : null;
  };

  async function flushOnce(force: boolean): Promise<OutboxFlushResult> {
    let sent = 0;
    let dropped = 0;
    const result = (
      status: OutboxFlushResult['status'],
      state: OutboxState,
      error: CloudError | null = null,
    ): OutboxFlushResult => ({
      status,
      sent,
      dropped,
      remaining: state.items.length,
      nextFlushAt: until(state),
      error,
    });

    const start = await read();
    if (start.items.length === 0) return result('empty', start);
    if (!force && until(start)) return result('waiting', start);

    // Events the server would reject as too old.
    const oldest = now().getTime() - CLOUD_OUTBOX.eventMaxAgeMs;
    let state = await mutate((s) => {
      const before = s.items.length;
      s.items = s.items.filter(
        (i) => i.type !== 'event' || Date.parse(i.event.occurredAt) >= oldest,
      );
      dropped += before - s.items.length;
      return s;
    });

    for (let requests = 0; requests < CLOUD_OUTBOX.maxRequestsPerFlush; requests += 1) {
      const event = state.items.find((i): i is OutboxEventItem => i.type === 'event');
      const deviceId = state.items.find((i): i is OutboxDayItem => i.type === 'day')?.deviceId;
      if (!event && deviceId === undefined) break;
      const batch = event
        ? []
        : state.items
            .filter((i): i is OutboxDayItem => i.type === 'day' && i.deviceId === deviceId)
            .slice(0, CLOUD_LIMITS.syncBatchMax);
      try {
        if (event) {
          const answer = await client.postAccountabilityEvent(event.event);
          state = await mutate((s) => {
            s.items = s.items.filter(
              (i) => i.type !== 'event' || i.event.clientRef !== event.event.clientRef,
            );
            sent += 1;
            return s;
          });
          reportSent(event.event, answer);
        } else {
          const answer = await client.putDays({
            deviceId: deviceId ?? '',
            days: batch.map((i) => i.stats),
          });
          const stale = new Set(Array.isArray(answer.stale) ? answer.stale : []);
          // The sent snapshots leave the queue; so does anything the server now holds a higher
          // rev of. A snapshot queued meanwhile stays, even with the same rev: a running block
          // grows the minutes without a new guardian event, and the server lets an equal rev
          // overwrite for exactly that.
          state = await mutate((s) => {
            s.items = s.items.filter((i) => !batch.some((b) => supersededBy(i, b, stale)));
            sent += batch.length;
            return s;
          });
        }
      } catch (error) {
        if (!isCloudError(error)) throw error;
        if (error.status === 401) {
          state = await mutate((s) => {
            s.items = [];
            s.failures = 0;
            s.notBefore = null;
            return s;
          });
          return result('signed_out', state, error);
        }
        if (!isPermanent(error)) {
          state = await mutate((s) => {
            s.failures += 1;
            const wait = nextRetryDelay(s.failures, random, error.retryAfterMs);
            s.notBefore = new Date(now().getTime() + wait).toISOString();
            return s;
          });
          return result('retry_later', state, error);
        }
        // Permanent: drop what the server will never take (only the rejected days when the
        // answer says which ones).
        const rejected = event ? new Set<number>() : rejectedDayIndexes(error, batch.length);
        const drop: OutboxItem[] = event
          ? [event]
          : rejected.size > 0 && error.code === 'validation_failed'
            ? batch.filter((_item, index) => rejected.has(index))
            : batch;
        state = await mutate((s) => {
          s.items = s.items.filter((i) => !drop.some((d) => sameItem(i, d)));
          dropped += drop.length;
          return s;
        });
      }
    }

    state = await mutate((s) => {
      s.failures = 0;
      s.notBefore = null;
      return s;
    });
    return result('done', state);
  }

  return {
    addDays: async (deviceId, days) => {
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw new RangeError('addDays: deviceId is required');
      }
      for (const d of days) {
        if (!isDayStats(d)) throw new RangeError('addDays: malformed day stats');
      }
      if (days.length === 0) return;
      await mutate((s) => {
        for (const stats of days) s.items.push({ type: 'day', deviceId, stats: { ...stats } });
      });
    },
    addEvent: async (event) => {
      if (!isEvent(event)) throw new RangeError('addEvent: malformed accountability event');
      await mutate((s) => {
        const { clientRef, kind, occurredAt, countdownEndsAt } = event;
        s.items.push({ type: 'event', event: { clientRef, kind, occurredAt, countdownEndsAt } });
      });
    },
    flush: (flushOptions) => {
      if (!running) {
        running = flushOnce(flushOptions?.force === true).finally(() => {
          running = null;
        });
      }
      return running;
    },
    pending: async () => (await read()).items.length,
    nextFlushAt: async () => until(await read()),
    clear: async () => {
      await mutate((s) => {
        s.items = [];
        s.failures = 0;
        s.notBefore = null;
      });
    },
  };
}

function sameDeviceDay(item: OutboxItem, other: OutboxDayItem): item is OutboxDayItem {
  return (
    item.type === 'day' && item.deviceId === other.deviceId && item.stats.day === other.stats.day
  );
}

/** Every field equal: the very snapshot that was sent (a same-rev update differs somewhere). */
function sameSnapshot(a: CloudDayStats, b: CloudDayStats): boolean {
  return a.day === b.day && DAY_NUMBER_KEYS.every((k) => a[k] === b[k]);
}

/**
 * After the server took `sent` (or answered it `stale`), whether `item` has nothing left to
 * tell it: the same snapshot, a lower rev, or up to the same rev of a day the server holds at
 * a higher one. A same-rev snapshot with other numbers still has to go.
 */
function supersededBy(item: OutboxItem, sent: OutboxDayItem, stale: ReadonlySet<string>): boolean {
  if (!sameDeviceDay(item, sent)) return false;
  if (item.stats.rev < sent.stats.rev) return true;
  if (item.stats.rev > sent.stats.rev) return false;
  return stale.has(sent.stats.day) || sameSnapshot(item.stats, sent.stats);
}

/** The exact item that was sent (for drops): an event by `clientRef`, a day by snapshot. */
function sameItem(item: OutboxItem, other: OutboxItem): boolean {
  if (item.type === 'event' || other.type === 'event') {
    return (
      item.type === 'event' &&
      other.type === 'event' &&
      item.event.clientRef === other.event.clientRef
    );
  }
  return sameDeviceDay(item, other) && sameSnapshot(item.stats, other.stats);
}

// ---------------------------------------------------------------------------------------
// Sending an accountability event now
// ---------------------------------------------------------------------------------------

export interface SendEventResult {
  /**
   * - `sent`: the server has it; `response` carries `eventId` and `approval` (poll it every
   *   15 s while `pending`, see `approvalOutcome`).
   * - `queued`: it could not go out now (offline, a timeout, a server waking up or failing,
   *   the feature off, the call aborted) and waits in the outbox, which replays the same
   *   `clientRef` and reports the answer through `OutboxOptions.onEventSent`. Until then the
   *   app has no approval to wait for: the flow fails open.
   * - `dropped`: the server refused it for good (400, 404…): nothing to wait for.
   * - `signed_out`: 401. The client's `onUnauthorized` hook ran; nothing was queued.
   */
  status: 'sent' | 'queued' | 'dropped' | 'signed_out';
  response: PostAccountabilityEventResponse | null;
  error: CloudError | null;
}

/**
 * Sends an accountability event straight away and falls back to the outbox. This is the path
 * for `emergency_requested`, whose answer the app needs at once: the outbox keeps no answers
 * but hands them to `onEventSent`, and its first POST to a sleeping server would time out.
 * `postAccountabilityEvent` wakes the server first (`options.onWaking`: «Despertando el
 * servidor…»), so the event arrives with an accurate `sentAt`. Only a failure that resending can
 * fix queues it; the outbox then replays the same `clientRef`, and a replay of an event the
 * server already stored answers that event (200), so the `eventId` is never lost. The other
 * kinds can go straight to `CloudOutbox.addEvent`. docs/API.md §9 and §14.
 */
export async function sendAccountabilityEvent(
  client: Pick<CloudClient, 'postAccountabilityEvent'>,
  outbox: Pick<CloudOutbox, 'addEvent'>,
  event: AccountabilityEventInput,
  options: WakeCallOptions = {},
): Promise<SendEventResult> {
  if (!isEvent(event)) throw new RangeError('sendAccountabilityEvent: malformed event');
  try {
    const response = await client.postAccountabilityEvent(event, options);
    return { status: 'sent', response, error: null };
  } catch (error) {
    if (!isCloudError(error)) throw error;
    if (error.status === 401) return { status: 'signed_out', response: null, error };
    if (isPermanent(error)) return { status: 'dropped', response: null, error };
    const { clientRef, kind, occurredAt, countdownEndsAt } = event;
    await outbox.addEvent({ clientRef, kind, occurredAt, countdownEndsAt });
    return { status: 'queued', response: null, error };
  }
}
