/**
 * Profile and consent lookups shared by every route module (owner: CORE; SOCIAL and COACH only
 * call it). Every sharing switch is checked on the server, never trusted from the client.
 */
import type {
  CloudConsent,
  CloudProfile,
  CloudSharing,
  MeResponse,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { profiles, user } from '../db/schema';
import { conflict, consentRequired, unauthorized } from './errors';

export type ProfileRow = typeof profiles.$inferSelect;

// C0 and C1 controls, bidi overrides and zero-width characters: never in names shown to others.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE_GLOBAL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** True when `value` holds a control, bidi-override or zero-width character. */
export function hasControlChars(value: string): boolean {
  return CONTROL_RE.test(value);
}

/**
 * The first word of a name, cleaned, at most `displayNameMax` characters ('' when none). The
 * `user.name` column keeps only this (it seeds the display name), never a full name.
 */
export function firstNameOnly(name: unknown): string {
  if (typeof name !== 'string') return '';
  const word = name.replace(CONTROL_RE_GLOBAL, ' ').trim().split(/\s+/)[0] ?? '';
  return word.slice(0, CLOUD_LIMITS.displayNameMax);
}

/**
 * Creates the profile row if it is missing: every switch off, the display name seeded from the
 * first name better-auth stored (Google), or null (email sign-ups). Idempotent.
 */
export async function ensureProfile(db: Db, userId: string): Promise<void> {
  const rows = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  if (!rows[0]) return;
  const displayName = firstNameOnly(rows[0].name) || null;
  await db.insert(profiles).values({ userId, displayName }).onConflictDoNothing();
}

/**
 * The caller's profile row. Created with the user (better-auth hook); inserted here with the
 * defaults (everything off) if it is somehow missing.
 */
export async function getProfile(db: Db, userId: string): Promise<ProfileRow> {
  const rows = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  await ensureProfile(db, userId);
  const again = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  if (!again[0]) throw unauthorized('The account no longer exists');
  return again[0];
}

export function toCloudProfile(row: ProfileRow): CloudProfile {
  return {
    displayName: row.displayName,
    timeZone: row.timeZone,
    dailyGoalMinutes: row.dailyGoalMinutes,
  };
}

export function toCloudSharing(row: ProfileRow): CloudSharing {
  return {
    syncStats: row.shareSync,
    ranking: row.shareRanking,
    presence: row.sharePresence,
    partnerEmails: row.partnerEmails,
    coach: row.coachEnabled,
  };
}

/** `MeResponse` for a profile row and its user. */
export async function loadMe(db: Db, userId: string, row?: ProfileRow): Promise<MeResponse> {
  const users = await db
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const u = users[0];
  if (!u) throw unauthorized('The account no longer exists');
  const profile = row ?? (await getProfile(db, userId));
  return {
    user: { id: u.id, email: u.email, createdAt: u.createdAt.toISOString() },
    profile: toCloudProfile(profile),
    sharing: toCloudSharing(profile),
    consentUpdatedAt: profile.consentUpdatedAt?.toISOString() ?? null,
  };
}

/** 403 consent_required unless the caller turned `consent` on. */
export function requireConsent(row: ProfileRow, consent: CloudConsent): void {
  const on =
    consent === 'syncStats'
      ? row.shareSync
      : consent === 'ranking'
        ? row.shareRanking
        : consent === 'presence'
          ? row.sharePresence
          : row.coachEnabled;
  if (!on) throw consentRequired(consent);
}

/** 409 profile_incomplete until the caller has a display name (social features). */
export function requireDisplayName(row: ProfileRow): string {
  if (!row.displayName) {
    throw conflict('profile_incomplete', 'Set a display name before using social features');
  }
  return row.displayName;
}
