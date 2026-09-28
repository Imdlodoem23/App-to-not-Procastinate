/**
 * Who can see whom (docs/API.md §8): friendships, blocks, display names and the id formats the
 * social routes accept. Other people are only ever shown as `{ userId, displayName }`.
 */
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import type { CloudPerson } from '@centrate/shared/cloud-api';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { friendships, partnerLinks, profiles, userBlocks } from '../db/schema';
import { notFound } from '../lib/errors';

/** A transaction handle; every helper here works with it or with the plain database. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** better-auth ids (and the UUIDs of test users). */
export const UserIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a user id');

/** The id of an invite, partner link or event in a path. Anything malformed is a plain 404. */
export function parseUuidParam(value: unknown): string {
  const parsed = z.guid().safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data.toLowerCase();
}

/** A user id in a path. Anything malformed is a plain 404 (it cannot name anyone). */
export function parseUserIdParam(value: unknown): string {
  const parsed = UserIdSchema.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** Display names by user id; people without one are left out. */
export async function displayNames(db: DbOrTx, userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ userId: profiles.userId, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.userId, unique));
  const out = new Map<string, string>();
  for (const row of rows) if (row.displayName) out.set(row.userId, row.displayName);
  return out;
}

/**
 * `{ userId, displayName }` for someone the caller is allowed to see. A person who removed
 * their display name still shows up (as an empty name) where a relation already exists.
 */
export function person(userId: string, names: Map<string, string>): CloudPerson {
  return { userId, displayName: names.get(userId) ?? '' };
}

/** True when either person blocked the other. */
export async function isBlockedEitherWay(db: DbOrTx, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)),
        and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * SQL condition: no block between `userId` and the person in `other` (a column of the outer
 * query), in either direction.
 */
export function notBlockedWith(userId: string, other: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE (${userBlocks.blockerId} = ${userId} AND ${userBlocks.blockedId} = ${other}) OR (${userBlocks.blockerId} = ${other} AND ${userBlocks.blockedId} = ${userId}))`;
}

export async function areFriends(db: DbOrTx, a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ userId: friendships.userId })
    .from(friendships)
    .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)))
    .limit(1);
  return rows.length > 0;
}

/** The caller's friends' ids, blocks excluded. */
export async function friendIds(db: DbOrTx, userId: string): Promise<string[]> {
  const rows = await db
    .select({ friendId: friendships.friendId })
    .from(friendships)
    .where(and(eq(friendships.userId, userId), notBlockedWith(userId, friendships.friendId)));
  return rows.map((r) => r.friendId);
}

export const coolingOffMs = CLOUD_LIMITS.partnerCoolingOffHours * 3_600_000;

/**
 * Ends the relationship between `callerId` and `otherId` (unfriend or block), in a transaction:
 * - both friendship rows go;
 * - partner links between the two go now, except an active link where the caller is the
 *   owner: that one ends in 24 hours (a person cannot shortcut their own cooling-off by
 *   unfriending or blocking their partner, docs/API.md §9).
 */
export async function endRelationship(
  tx: Tx,
  callerId: string,
  otherId: string,
  now: Date,
): Promise<void> {
  await tx
    .delete(friendships)
    .where(
      or(
        and(eq(friendships.userId, callerId), eq(friendships.friendId, otherId)),
        and(eq(friendships.userId, otherId), eq(friendships.friendId, callerId)),
      ),
    );
  // The caller is the partner (they may leave at once), or the link is pending or already over.
  await tx
    .delete(partnerLinks)
    .where(
      or(
        and(eq(partnerLinks.ownerId, otherId), eq(partnerLinks.partnerId, callerId)),
        and(
          eq(partnerLinks.ownerId, callerId),
          eq(partnerLinks.partnerId, otherId),
          or(eq(partnerLinks.status, 'pending'), lte(partnerLinks.endsAt, now)),
        ),
      ),
    );
  // The caller is the owner of an active link: it keeps working for 24 hours.
  await tx
    .update(partnerLinks)
    .set({ endsAt: new Date(now.getTime() + coolingOffMs) })
    .where(
      and(
        eq(partnerLinks.ownerId, callerId),
        eq(partnerLinks.partnerId, otherId),
        eq(partnerLinks.status, 'active'),
        isNull(partnerLinks.endsAt),
      ),
    );
}
