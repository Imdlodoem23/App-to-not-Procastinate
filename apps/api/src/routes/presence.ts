/**
 * «Estudiando ahora» (owner: SOCIAL). docs/API.md §8.3.
 *
 * - The app sends a heartbeat every 60 s during a block or study session and DELETE when it
 *   ends; a row lives 180 s past its last heartbeat, so a crash disappears within 3 minutes.
 * - Readers see only live rows (`expires_at > now`, no dependence on the janitor) of friends
 *   who share presence, and only if they share theirs too. Friends see the state and times,
 *   never what is blocked or the task.
 */
import type {
  FriendPresence,
  FriendsPresenceResponse,
  PutPresenceRequest,
  PutPresenceResponse,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { friendships, presence, profiles } from '../db/schema';
import { validationFailed } from '../lib/errors';
import { parseBody, requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireConsent } from '../lib/profile';
import { notBlockedWith } from '../social/people';

const MAX_ENDS_AHEAD_MS = 24 * 3_600_000;

const PutSchema = z
  .object({
    state: z.enum(['focus', 'study']),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict() satisfies z.ZodType<PutPresenceRequest>;

const collator = new Intl.Collator('es', { sensitivity: 'base' });

export const presenceRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.put<{ Body: PutPresenceRequest; Reply: PutPresenceResponse }>(
    '/presence',
    { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } },
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const body = parseBody(PutSchema, request);
      requireConsent(await getProfile(db, me.userId), 'presence');

      const now = ctx.now();
      const endsAt = body.endsAt === null ? null : new Date(body.endsAt);
      if (
        endsAt &&
        (endsAt.getTime() <= now.getTime() || endsAt.getTime() > now.getTime() + MAX_ENDS_AHEAD_MS)
      ) {
        throw validationFailed([
          { path: 'body.endsAt', message: 'Must be in the next 24 hours, or null' },
        ]);
      }
      const expiresAt = new Date(now.getTime() + CLOUD_LIMITS.presenceTtlSeconds * 1000);

      // `since` survives while the state is unchanged and the row is still alive.
      await db
        .insert(presence)
        .values({ userId: me.userId, state: body.state, since: now, endsAt, expiresAt })
        .onConflictDoUpdate({
          target: presence.userId,
          set: {
            since: sql`CASE WHEN ${presence.state} = excluded.state AND ${presence.expiresAt} > ${now.toISOString()}::timestamptz THEN ${presence.since} ELSE excluded.since END`,
            state: sql`excluded.state`,
            endsAt: sql`excluded.ends_at`,
            expiresAt: sql`excluded.expires_at`,
          },
        });
      return { expiresAt: expiresAt.toISOString() };
    },
  );

  // Always allowed, even with the switch off: stopping to share never needs permission.
  app.delete('/presence', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    await db.delete(presence).where(eq(presence.userId, me.userId));
    return reply.status(204).send();
  });

  app.get<{ Reply: FriendsPresenceResponse }>('/friends/presence', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    requireConsent(await getProfile(db, me.userId), 'presence');
    const now = ctx.now();
    const rows = await db
      .select({
        userId: presence.userId,
        displayName: profiles.displayName,
        state: presence.state,
        since: presence.since,
        endsAt: presence.endsAt,
      })
      .from(friendships)
      .innerJoin(presence, eq(presence.userId, friendships.friendId))
      .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
      .where(
        and(
          eq(friendships.userId, me.userId),
          gt(presence.expiresAt, now),
          eq(profiles.sharePresence, true),
          notBlockedWith(me.userId, friendships.friendId),
        ),
      );
    const friends: FriendPresence[] = rows
      .filter((r) => r.displayName)
      .map((r) => ({
        userId: r.userId,
        displayName: r.displayName ?? '',
        state: r.state,
        since: r.since.toISOString(),
        endsAt: r.endsAt ? r.endsAt.toISOString() : null,
      }))
      .sort((a, b) => collator.compare(a.displayName, b.displayName));
    return { friends };
  });
};
