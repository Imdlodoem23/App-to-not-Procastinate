/**
 * GDPR access and erasure (owner: CORE). docs/API.md §13.
 *
 * - `buildExport` returns every row about the user. Other people appear only as id and display
 *   name; no tokens, code hashes or provider tokens.
 * - `deleteAccount` deletes the user row (every foreign key to `user` cascades) and the
 *   user's sign-in codes, which better-auth keys by email.
 * - `USER_DATA_COVERAGE` names, for every table that holds data about a user, where the export
 *   puts it or why it does not. test/gdpr.test.ts walks the schema: a new table with a user
 *   column fails the test until it is listed here and covered.
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

export const USER_DATA_COVERAGE = Object.freeze({
  user: 'me.user',
  profiles: 'me.profile, me.sharing, me.consentUpdatedAt',
  session: 'sessions (without tokens)',
  account: 'loginMethods (provider and date; provider tokens are never stored)',
  verification: 'not exported: sign-in codes (hashed, 10 min); deleted by email',
  app_auth_codes: 'not exported: desktop login codes (hashed, 60 s)',
  devices: 'devices',
  daily_stats: 'dailyStats',
  friend_invites: 'invites (without codes or hashes)',
  friendships: 'friends',
  user_blocks: 'blocks',
  presence: 'presence',
  partner_links: 'partnerLinks',
  accountability_events: 'accountabilityEvents, approvalDecisions',
  usage_counters: 'usageCounters',
  ai_usage: 'aiUsage',
} as const);

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
    .select({ providerId: account.providerId, createdAt: account.createdAt })
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
    loginMethods: accounts.map((a) => ({ provider: a.providerId, createdAt: iso(a.createdAt) })),
    sessions: sessions.map((s) => ({
      createdAt: iso(s.createdAt),
      expiresAt: iso(s.expiresAt),
      current: s.id === caller.sessionId,
    })),
    devices: deviceRows.map((d) => toCloudDevice(d, caller.deviceId)),
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
 * codes. Returns false when the user no longer exists.
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
