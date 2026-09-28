/**
 * GDPR access and erasure (owner: CORE). docs/API.md §13.
 *
 * - `buildExport` returns every stored value about the user. Other people appear only as id
 *   and display name; no tokens, code hashes or provider tokens.
 * - `deleteAccount` deletes the user row (every foreign key to `user` cascades) and the
 *   user's sign-in codes, which better-auth keys by email.
 * - `USER_DATA_COVERAGE` classifies every column of every table that holds data about a user:
 *   either where the export puts it, or `not exported: <why>`. test/gdpr.test.ts walks the
 *   schema: a new table with a user column, or a new column in one of these tables, fails the
 *   test until it is classified here (and, when exported, found in the export).
 */
import type { CloudDevice, CloudExport } from '@centrate/shared/cloud-api';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  account,
  aiUsage,
  dailyStats,
  devices,
  session,
  usageCounters,
  user,
  verification,
} from '../db/schema';
import { exportSocialData } from '../social/export';
import { loadMe } from './profile';

/** Marks a column the export leaves out; the text after it says why. */
export const NOT_EXPORTED = 'not exported:';

const SAME_USER = 'the user (me.user.id)';
const TECHNICAL_UPDATED_AT = `${NOT_EXPORTED} technical timestamp of the last write`;
const ALWAYS_NULL = `${NOT_EXPORTED} always null (never stored)`;

export const USER_DATA_COVERAGE: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    user: {
      id: 'me.user.id',
      name: `${NOT_EXPORTED} always '' (the Google first name moves to me.profile.displayName at sign-up)`,
      email: 'me.user.email',
      email_verified: `${NOT_EXPORTED} technical flag set by the sign-in method`,
      image: ALWAYS_NULL,
      created_at: 'me.user.createdAt',
      updated_at: TECHNICAL_UPDATED_AT,
    },
    session: {
      id: `${NOT_EXPORTED} internal id (sessions.current marks the caller's)`,
      expires_at: 'sessions.expiresAt',
      token: `${NOT_EXPORTED} secret (the bearer token)`,
      created_at: 'sessions.createdAt',
      updated_at: TECHNICAL_UPDATED_AT,
      ip_address: ALWAYS_NULL,
      user_agent: ALWAYS_NULL,
      authenticated_at: `${NOT_EXPORTED} technical: for a connected computer, when the browser sign-in that connected it happened (fresh-session rule)`,
      user_id: SAME_USER,
    },
    account: {
      id: `${NOT_EXPORTED} internal id`,
      account_id: 'loginMethods.accountId',
      provider_id: 'loginMethods.provider',
      user_id: SAME_USER,
      access_token: `${NOT_EXPORTED} always null (provider tokens are dropped before storage)`,
      refresh_token: `${NOT_EXPORTED} always null (provider tokens are dropped before storage)`,
      id_token: `${NOT_EXPORTED} always null (provider tokens are dropped before storage)`,
      access_token_expires_at: ALWAYS_NULL,
      refresh_token_expires_at: ALWAYS_NULL,
      scope: `${NOT_EXPORTED} the fixed OAuth scopes we ask for (openid email profile)`,
      password: `${NOT_EXPORTED} always null (no passwords)`,
      created_at: 'loginMethods.createdAt',
      updated_at: TECHNICAL_UPDATED_AT,
    },
    verification: {
      id: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
      identifier: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
      value: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
      expires_at: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
      created_at: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
      updated_at: `${NOT_EXPORTED} sign-in code (hashed, 10 min); deleted by email`,
    },
    rate_counters: {
      key: `${NOT_EXPORTED} anti-abuse counter keyed by an HMAC of an address, not linked to the account; kept one day`,
      window_start: `${NOT_EXPORTED} see key`,
      count: `${NOT_EXPORTED} see key`,
      expires_at: `${NOT_EXPORTED} see key`,
    },
    profiles: {
      user_id: SAME_USER,
      display_name: 'me.profile.displayName',
      time_zone: 'me.profile.timeZone',
      daily_goal_minutes: 'me.profile.dailyGoalMinutes',
      share_sync: 'me.sharing.syncStats',
      share_ranking: 'me.sharing.ranking',
      share_presence: 'me.sharing.presence',
      partner_emails: 'me.sharing.partnerEmails',
      coach_enabled: 'me.sharing.coach',
      consent_updated_at: 'me.consentUpdatedAt',
      ranking_since: 'me.rankingSince',
      created_at: `${NOT_EXPORTED} written with the account (me.user.createdAt)`,
      updated_at: TECHNICAL_UPDATED_AT,
    },
    app_auth_codes: {
      code_hash: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      user_id: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      challenge: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      port: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      authenticated_at: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      expires_at: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
      created_at: `${NOT_EXPORTED} desktop login code (hashed, 60 s)`,
    },
    devices: {
      id: 'devices.id',
      user_id: SAME_USER,
      install_id: 'devices.installId',
      session_id: `${NOT_EXPORTED} internal link to a session (devices.current marks the caller's)`,
      name: 'devices.name',
      platform: 'devices.platform',
      app_version: 'devices.appVersion',
      created_at: 'devices.createdAt',
      last_sync_at: 'devices.lastSyncAt',
    },
    daily_stats: {
      device_id: 'dailyStats.deviceId',
      user_id: SAME_USER,
      day: 'dailyStats.day',
      rev: 'dailyStats.rev',
      focus_minutes: 'dailyStats.focusMinutes',
      study_minutes: 'dailyStats.studyMinutes',
      blocks_completed: 'dailyStats.blocksCompleted',
      study_sessions: 'dailyStats.studySessions',
      attempts: 'dailyStats.attempts',
      emergency_unlocks: 'dailyStats.emergencyUnlocks',
      punishments: 'dailyStats.punishments',
      points_earned: 'dailyStats.pointsEarned',
      points_lost: 'dailyStats.pointsLost',
      updated_at: TECHNICAL_UPDATED_AT,
    },
    friend_invites: {
      id: 'invites.id',
      inviter_id: SAME_USER,
      code_hash: `${NOT_EXPORTED} secret (hash of the invite code)`,
      max_uses: 'invites.maxUses',
      uses: 'invites.uses',
      expires_at: 'invites.expiresAt',
      created_at: 'invites.createdAt',
    },
    friendships: {
      user_id: SAME_USER,
      friend_id: 'friends.userId',
      created_at: 'friends.since',
    },
    user_blocks: {
      blocker_id: SAME_USER,
      blocked_id: 'blocks.userId',
      created_at: 'blocks.createdAt',
    },
    presence: {
      user_id: SAME_USER,
      state: 'presence.state',
      since: 'presence.since',
      ends_at: 'presence.endsAt',
      expires_at: `${NOT_EXPORTED} technical expiry (three minutes after the last heartbeat)`,
    },
    partner_links: {
      id: 'partnerLinks.id',
      owner_id: 'partnerLinks.owner.userId',
      partner_id: 'partnerLinks.partner.userId',
      status: 'partnerLinks.status',
      require_approval: 'partnerLinks.requireApproval',
      approval_off_at: 'partnerLinks.approvalOffAt',
      ends_at: 'partnerLinks.endsAt',
      created_at: 'partnerLinks.createdAt',
      accepted_at: 'partnerLinks.acceptedAt',
    },
    accountability_events: {
      id: 'accountabilityEvents.eventId, approvalDecisions.eventId',
      owner_id: 'the user (own events), approvalDecisions.owner.userId',
      client_ref: `${NOT_EXPORTED} random idempotency id the app generated`,
      kind: 'accountabilityEvents.kind',
      occurred_at: 'accountabilityEvents.occurredAt',
      created_at: `${NOT_EXPORTED} server receipt time (≈ occurredAt)`,
      approval_status: 'accountabilityEvents.approval.status, approvalDecisions.decision',
      approval_deadline: 'accountabilityEvents.approval.deadline',
      decided_by: `the user as decider (approvalDecisions); owners see the outcome, not who decided, as in the app`,
      decided_at: 'accountabilityEvents.approval.decidedAt, approvalDecisions.decidedAt',
      note: 'accountabilityEvents.approval.note, approvalDecisions.note',
    },
    usage_counters: {
      user_id: SAME_USER,
      day: 'usageCounters.day',
      key: 'usageCounters.key',
      count: 'usageCounters.count',
    },
    ai_usage: {
      user_id: SAME_USER,
      day: 'aiUsage.day',
      feature: 'aiUsage.feature',
      requests: 'aiUsage.requests',
      input_tokens: 'aiUsage.inputTokens',
      output_tokens: 'aiUsage.outputTokens',
      reserved_tokens: `${NOT_EXPORTED} held only while a call is in flight`,
      reserved_micro_usd: `${NOT_EXPORTED} held only while a call is in flight`,
      reserved_until: `${NOT_EXPORTED} held only while a call is in flight`,
      cache_read_tokens: `${NOT_EXPORTED} billing detail of the same requests`,
      cache_write_tokens: `${NOT_EXPORTED} billing detail of the same requests`,
      cost_micro_usd: `${NOT_EXPORTED} billing detail of the same requests`,
    },
    ai_identity_daily: {
      day: `${NOT_EXPORTED} anti-abuse counter of the same AI requests as aiUsage, keyed by an HMAC of the normalised address and not linked to the account (it outlives a deletion on purpose); deleted when its UTC day ends`,
      identity_hmac: `${NOT_EXPORTED} see day`,
      feature: `${NOT_EXPORTED} see day`,
      requests: `${NOT_EXPORTED} see day`,
      tokens: `${NOT_EXPORTED} see day`,
      cost_micro_usd: `${NOT_EXPORTED} see day`,
    },
  });

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

type DeviceRow = typeof devices.$inferSelect;

export function toCloudDevice(row: DeviceRow, currentDeviceId: string | null): CloudDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: iso(row.createdAt),
    lastSyncAt: isoOrNull(row.lastSyncAt),
    current: row.id === currentDeviceId,
  };
}

export interface ExportCaller {
  userId: string;
  sessionId: string;
  deviceId: string | null;
}

export async function buildExport(db: Db, caller: ExportCaller, now: Date): Promise<CloudExport> {
  const me = caller.userId;
  const meResponse = await loadMe(db, me);
  const accounts = await db
    .select({
      providerId: account.providerId,
      accountId: account.accountId,
      createdAt: account.createdAt,
    })
    .from(account)
    .where(eq(account.userId, me))
    .orderBy(asc(account.createdAt));
  const sessions = await db
    .select({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt })
    .from(session)
    .where(eq(session.userId, me))
    .orderBy(asc(session.createdAt));
  const deviceRows = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, me))
    .orderBy(asc(devices.createdAt));
  const statRows = await db
    .select()
    .from(dailyStats)
    .where(eq(dailyStats.userId, me))
    .orderBy(asc(dailyStats.day), asc(dailyStats.deviceId));
  const aiRows = await db
    .select()
    .from(aiUsage)
    .where(eq(aiUsage.userId, me))
    .orderBy(asc(aiUsage.day), asc(aiUsage.feature));
  const counterRows = await db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.userId, me))
    .orderBy(asc(usageCounters.day), asc(usageCounters.key));
  // Friends, invites, blocks, presence, partner links and events: SOCIAL's mapping, so the
  // export shows them exactly as the social endpoints do.
  const social = await exportSocialData(db, me, now);

  return {
    schemaVersion: 1,
    exportedAt: iso(now),
    me: meResponse,
    loginMethods: accounts.map((a) => ({
      provider: a.providerId,
      accountId: a.accountId,
      createdAt: iso(a.createdAt),
    })),
    sessions: sessions.map((s) => ({
      createdAt: iso(s.createdAt),
      expiresAt: iso(s.expiresAt),
      current: s.id === caller.sessionId,
    })),
    // The export adds the installation id, which /v1/devices never shows.
    devices: deviceRows.map((d) => ({
      ...toCloudDevice(d, caller.deviceId),
      installId: d.installId,
    })),
    dailyStats: statRows.map((r) => ({
      deviceId: r.deviceId,
      day: r.day,
      rev: r.rev,
      focusMinutes: r.focusMinutes,
      studyMinutes: r.studyMinutes,
      blocksCompleted: r.blocksCompleted,
      studySessions: r.studySessions,
      attempts: r.attempts,
      emergencyUnlocks: r.emergencyUnlocks,
      punishments: r.punishments,
      pointsEarned: r.pointsEarned,
      pointsLost: r.pointsLost,
    })),
    ...social,
    aiUsage: aiRows.map((r) => ({
      day: r.day,
      feature: r.feature,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    })),
    usageCounters: counterRows.map((r) => ({ day: r.day, key: r.key, count: r.count })),
  };
}

/** better-auth's email-code identifiers (`<type>-otp-<email>`, email-otp plugin). */
export function otpIdentifiers(email: string): string[] {
  const lower = email.toLowerCase();
  return ['sign-in', 'email-verification', 'forget-password', 'change-email'].map(
    (type) => `${type}-otp-${lower}`,
  );
}

/**
 * Hard-deletes the account: the user row (every foreign key cascades; a partner decision on
 * someone else's event keeps the event with `decided_by` set null) and the user's sign-in
 * codes. Returns false when the user no longer exists. The day's per-mailbox AI counters
 * (`ai_identity_daily`, HMAC keys, gone when the UTC day ends) stay on purpose: signing up again
 * with the same address must not reset the day's AI limits.
 */
export async function deleteAccount(db: Db, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const email = rows[0]?.email;
    if (email === undefined) return false;
    await tx.delete(verification).where(inArray(verification.identifier, otpIdentifiers(email)));
    await tx.delete(user).where(eq(user.id, userId));
    return true;
  });
}
