/**
 * Postgres schema (Drizzle). docs/API.md §6 explains every table.
 *
 * - Every timestamp is `timestamptz`; `day` columns are the civil date of whoever produced
 *   the number (never converted to UTC).
 * - Every foreign key to `user` cascades: deleting the user row erases everything about them
 *   (GDPR). The one exception is `accountability_events.decided_by` (set null), a partner's
 *   decision on someone else's event.
 * - The four better-auth tables follow better-auth 1.7's core schema (the drizzle adapter maps
 *   the camelCase keys). Our own data lives in our own tables so better-auth stays vanilla; the
 *   one exception is the nullable `session.authenticated_at`, which better-auth never writes.
 * - Nothing here stores free text written by the user except `display_name`, device names and
 *   the ≤140-char partner note. No domains, reasons, tasks, phrases or AI prompts/answers.
 *
 * Changing this file: run `npm run db:generate -w apps/api` and commit the new SQL in
 * `apps/api/drizzle/`. Before the first deploy the coordinator squashes to one migration.
 */
import { ACCOUNTABILITY_KINDS } from '@centrate/shared/cloud-api';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const created = () => tstz('created_at').notNull().defaultNow();

// ---------------------------------------------------------------------------------------
// better-auth core tables (user, session, account, verification)
// ---------------------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  /**
   * better-auth requires it. '' once the account exists: the Google first name only seeds the
   * display name (`ensureProfile`), and later updates are blanked (auth hooks).
   */
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** Always null: the Google picture is not stored (see auth config). */
  image: text('image'),
  createdAt: created(),
  updatedAt: tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: tstz('expires_at').notNull(),
    /** Also the desktop app's bearer token (better-auth `bearer` plugin). */
    token: text('token').notNull().unique(),
    createdAt: created(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Always null: IP tracking is disabled. */
    ipAddress: text('ip_address'),
    /** Always null: user agents are not stored. */
    userAgent: text('user_agent'),
    /**
     * Ours, not better-auth's (it leaves it null). When the person behind the session last
     * proved who they are, for the fresh-session rule (docs/API.md §4.3): null for a browser
     * session (its `created_at` is the sign-in); for a desktop session, the sign-in time of the
     * browser session that connected it (`app_auth_codes.authenticated_at`), so connecting a
     * computer never makes a session fresher than the sign-in behind it.
     */
    authenticatedAt: tstz('authenticated_at'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: created(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: created(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// ---------------------------------------------------------------------------------------
// Account: profile and consent, devices, loopback login codes
// ---------------------------------------------------------------------------------------

/** One row per user, created with the user. Every sharing switch starts off. */
export const profiles = pgTable(
  'profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    timeZone: text('time_zone').notNull().default('Europe/Madrid'),
    dailyGoalMinutes: smallint('daily_goal_minutes'),
    shareSync: boolean('share_sync').notNull().default(false),
    shareRanking: boolean('share_ranking').notNull().default(false),
    sharePresence: boolean('share_presence').notNull().default(false),
    partnerEmails: boolean('partner_emails').notNull().default(false),
    coachEnabled: boolean('coach_enabled').notNull().default(false),
    consentUpdatedAt: tstz('consent_updated_at'),
    /**
     * When `share_ranking` was last turned on (null while off). Friends' rankings count this
     * person's days only from then (docs/API.md §8.2), never retroactively.
     */
    rankingSince: tstz('ranking_since'),
    createdAt: created(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'profiles_goal_range',
      sql`${t.dailyGoalMinutes} IS NULL OR ${t.dailyGoalMinutes} BETWEEN 15 AND 600`,
    ),
    check('profiles_ranking_needs_sync', sql`NOT ${t.shareRanking} OR ${t.shareSync}`),
    check('profiles_ranking_since', sql`${t.shareRanking} = (${t.rankingSince} IS NOT NULL)`),
  ],
);

/** A connected computer. Logging in again with the same installId reuses the row. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    installId: text('install_id').notNull(),
    /** The bearer session this device holds; revoked with the device. */
    sessionId: text('session_id').references(() => session.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    platform: text('platform', { enum: ['win', 'mac', 'linux'] }).notNull(),
    appVersion: text('app_version').notNull(),
    createdAt: created(),
    lastSyncAt: tstz('last_sync_at'),
  },
  (t) => [
    uniqueIndex('devices_user_install_uq').on(t.userId, t.installId),
    index('devices_session_id_idx').on(t.sessionId),
    check('devices_platform', sql`${t.platform} IN ('win', 'mac', 'linux')`),
  ],
);

/** One-time codes of the desktop loopback login (RFC 8252 + PKCE). Valid 60 s, used once. */
export const appAuthCodes = pgTable(
  'app_auth_codes',
  {
    /** SHA-256 (hex) of the code; the code itself is never stored. */
    codeHash: text('code_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** PKCE S256 challenge (base64url). */
    challenge: text('challenge').notNull(),
    port: integer('port').notNull(),
    /** Sign-in time of the browser session that clicked «Conectar»; the desktop session gets it. */
    authenticatedAt: tstz('authenticated_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    index('app_auth_codes_expires_idx').on(t.expiresAt),
    check('app_auth_codes_port', sql`${t.port} BETWEEN 1024 AND 65535`),
  ],
);

// ---------------------------------------------------------------------------------------
// Stats: numbers only
// ---------------------------------------------------------------------------------------

/** Absolute daily totals per (device, local day). Only the owning device writes its rows. */
export const dailyStats = pgTable(
  'daily_stats',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    rev: bigint('rev', { mode: 'number' }).notNull(),
    focusMinutes: integer('focus_minutes').notNull(),
    studyMinutes: integer('study_minutes').notNull(),
    blocksCompleted: integer('blocks_completed').notNull(),
    studySessions: integer('study_sessions').notNull(),
    attempts: integer('attempts').notNull(),
    emergencyUnlocks: integer('emergency_unlocks').notNull(),
    punishments: integer('punishments').notNull(),
    pointsEarned: integer('points_earned').notNull(),
    pointsLost: integer('points_lost').notNull(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'daily_stats_pk', columns: [t.deviceId, t.day] }),
    index('daily_stats_user_day_idx').on(t.userId, t.day),
    check('daily_stats_rev', sql`${t.rev} >= 0`),
    check('daily_stats_focus', sql`${t.focusMinutes} BETWEEN 0 AND 1440`),
    check('daily_stats_study', sql`${t.studyMinutes} BETWEEN 0 AND ${t.focusMinutes}`),
    check('daily_stats_blocks', sql`${t.blocksCompleted} BETWEEN 0 AND 10000`),
    check('daily_stats_sessions', sql`${t.studySessions} BETWEEN 0 AND 10000`),
    check('daily_stats_attempts', sql`${t.attempts} BETWEEN 0 AND 10000`),
    check('daily_stats_emergencies', sql`${t.emergencyUnlocks} BETWEEN 0 AND 10000`),
    check('daily_stats_punishments', sql`${t.punishments} BETWEEN 0 AND 10000`),
    check('daily_stats_points_earned', sql`${t.pointsEarned} BETWEEN 0 AND 100000`),
    check('daily_stats_points_lost', sql`${t.pointsLost} BETWEEN 0 AND 100000`),
  ],
);

// ---------------------------------------------------------------------------------------
// Social: invites, friendships, blocks, presence
// ---------------------------------------------------------------------------------------

export const friendInvites = pgTable(
  'friend_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the normalized code (10 chars, no dash, upper case). */
    codeHash: text('code_hash').notNull().unique(),
    maxUses: smallint('max_uses').notNull().default(1),
    uses: smallint('uses').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [
    index('friend_invites_inviter_idx').on(t.inviterId),
    index('friend_invites_expires_idx').on(t.expiresAt),
    check(
      'friend_invites_uses',
      sql`${t.maxUses} BETWEEN 1 AND 10 AND ${t.uses} BETWEEN 0 AND ${t.maxUses}`,
    ),
  ],
);

/** Two symmetric rows per friendship, written in one transaction. */
export const friendships = pgTable(
  'friendships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    friendId: text('friend_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ name: 'friendships_pk', columns: [t.userId, t.friendId] }),
    index('friendships_friend_idx').on(t.friendId),
    check('friendships_not_self', sql`${t.userId} <> ${t.friendId}`),
  ],
);

/** A block hides both people from each other everywhere and stops future invites. */
export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ name: 'user_blocks_pk', columns: [t.blockerId, t.blockedId] }),
    index('user_blocks_blocked_idx').on(t.blockedId),
    check('user_blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

/** «Estudiando ahora». Readers only see rows with `expires_at > now()`. */
export const presence = pgTable(
  'presence',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['focus', 'study'] }).notNull(),
    since: tstz('since').notNull(),
    endsAt: tstz('ends_at'),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    index('presence_expires_idx').on(t.expiresAt),
    check('presence_state', sql`${t.state} IN ('focus', 'study')`),
  ],
);

// ---------------------------------------------------------------------------------------
// Accountability partner
// ---------------------------------------------------------------------------------------

export const partnerLinks = pgTable(
  'partner_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The person held accountable. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    partnerId: text('partner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['pending', 'active'] }).notNull(),
    requireApproval: boolean('require_approval').notNull().default(false),
    /** A requested «approval off» takes effect at this time (24 h cooling-off). */
    approvalOffAt: tstz('approval_off_at'),
    /** An owner-requested removal takes effect at this time (24 h cooling-off). */
    endsAt: tstz('ends_at'),
    createdAt: created(),
    acceptedAt: tstz('accepted_at'),
  },
  (t) => [
    uniqueIndex('partner_links_owner_partner_uq').on(t.ownerId, t.partnerId),
    index('partner_links_partner_idx').on(t.partnerId),
    check('partner_links_not_self', sql`${t.ownerId} <> ${t.partnerId}`),
    check('partner_links_status', sql`${t.status} IN ('pending', 'active')`),
  ],
);

/** Minimal event reports for partners (kind + time, never a reason, domain or task). */
export const accountabilityEvents = pgTable(
  'accountability_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Random id from the app's offline queue; makes the POST idempotent. */
    clientRef: text('client_ref').notNull(),
    kind: text('kind', { enum: ACCOUNTABILITY_KINDS }).notNull(),
    occurredAt: tstz('occurred_at').notNull(),
    createdAt: created(),
    /** Null when no approval was asked; `expired` is computed on read. */
    approvalStatus: text('approval_status', { enum: ['pending', 'approved', 'denied'] }),
    approvalDeadline: tstz('approval_deadline'),
    decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: tstz('decided_at'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('accountability_events_owner_ref_uq').on(t.ownerId, t.clientRef),
    index('accountability_events_owner_created_idx').on(t.ownerId, t.createdAt),
    index('accountability_events_created_idx').on(t.createdAt),
    check(
      'accountability_events_kind',
      sql.raw(`kind IN (${ACCOUNTABILITY_KINDS.map((k) => `'${k}'`).join(', ')})`),
    ),
    check(
      'accountability_events_approval',
      sql`(${t.approvalStatus} IS NULL) = (${t.approvalDeadline} IS NULL)`,
    ),
    check(
      'accountability_events_status',
      sql`${t.approvalStatus} IS NULL OR ${t.approvalStatus} IN ('pending', 'approved', 'denied')`,
    ),
    check('accountability_events_note', sql`${t.note} IS NULL OR char_length(${t.note}) <= 140`),
  ],
);

// ---------------------------------------------------------------------------------------
// Counters and AI usage (no prompt or answer text is ever stored)
// ---------------------------------------------------------------------------------------

/** Small per-user daily counters, e.g. `partner_email` (emails received as a partner). */
export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    key: text('key').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ name: 'usage_counters_pk', columns: [t.userId, t.day, t.key] })],
);

/**
 * Durable anti-abuse counters that are not tied to an account (src/lib/counters.ts): the global
 * daily cap on sign-in emails and the per-address sign-in email limits. Per-address keys hold
 * an HMAC of the normalised address, never the address itself. Deleted once `expires_at` passes.
 */
export const rateCounters = pgTable(
  'rate_counters',
  {
    key: text('key').notNull(),
    windowStart: tstz('window_start').notNull(),
    count: integer('count').notNull().default(0),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'rate_counters_pk', columns: [t.key, t.windowStart] }),
    index('rate_counters_expires_idx').on(t.expiresAt),
  ],
);

/** Per-user AI use per UTC day and feature. Requests are reserved before the call. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    feature: text('feature', { enum: ['interpret', 'coach'] }).notNull(),
    requests: integer('requests').notNull().default(0),
    /** Worst-case tokens held by calls in flight; released when they settle. */
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    /** Worst-case cost held by calls in flight (per-user daily spend cap, COACH). */
    reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
    /**
     * When the call in flight must have settled (one per user and feature); null when none.
     * A past value is a call whose process died: the janitor frees its amounts (jobs/janitor.ts).
     */
    reservedUntil: tstz('reserved_until'),
  },
  (t) => [
    primaryKey({ name: 'ai_usage_pk', columns: [t.userId, t.day, t.feature] }),
    index('ai_usage_day_idx').on(t.day),
    check('ai_usage_feature', sql`${t.feature} IN ('interpret', 'coach')`),
  ],
);

/**
 * AI use per UTC day of a mailbox rather than an account (COACH, docs/API.md §10.2), so that
 * deleting and recreating the account, or a second account on `ana+1@…`, does not reset the
 * day's AI limits. Keyed by an HMAC of the normalised address (never the address), with no
 * foreign key to `user`: it must outlive a deleted account. Deleted once its UTC day is over.
 */
export const aiIdentityDaily = pgTable(
  'ai_identity_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    identityHmac: text('identity_hmac').notNull(),
    feature: text('feature', { enum: ['interpret', 'coach'] }).notNull(),
    requests: integer('requests').notNull().default(0),
    /** Input + output + cache tokens of settled calls. */
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'ai_identity_daily_pk', columns: [t.day, t.identityHmac, t.feature] }),
    check('ai_identity_daily_feature', sql`${t.feature} IN ('interpret', 'coach')`),
  ],
);

/** Global AI spend per UTC day, for the budget cap. Not personal data. */
export const aiGlobalDaily = pgTable('ai_global_daily', {
  day: date('day', { mode: 'string' }).primaryKey(),
  requests: integer('requests').notNull().default(0),
  costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
  /** Worst-case cost held by calls in flight. */
  reservedMicroUsd: bigint('reserved_micro_usd', { mode: 'number' }).notNull().default(0),
});

// ---------------------------------------------------------------------------------------
// Server metadata
// ---------------------------------------------------------------------------------------

/** `server_epoch` (random, set once per database) and `janitor_last_run`. */
export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** The tables better-auth's drizzle adapter needs. */
export const authSchema = { user, session, account, verification };
