/**
 * Invites, friends and blocks (owner: SOCIAL). docs/API.md §8.1.
 *
 * - Friends only by invitation: no search, no directory, nobody can be enumerated.
 * - Codes are stored hashed. Preview and accept answer the same 404 for unknown, expired, used
 *   up, own and blocked codes.
 * - Other people appear only as `{ userId, displayName }`, never with an email.
 */
import type {
  AcceptInviteResponse,
  BlocksResponse,
  BlockUserRequest,
  CreateInviteRequest,
  CreateInviteResponse,
  FriendsResponse,
  InvitePreviewResponse,
  InvitesResponse,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { friendInvites, friendships, profiles, user, userBlocks } from '../db/schema';
import { conflict, notFound, validationFailed } from '../lib/errors';
import { parseBody, requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireDisplayName } from '../lib/profile';
import {
  formatInviteCode,
  generateInviteCode,
  hashInviteCode,
  normalizeInviteCode,
} from '../social/codes';
import {
  endRelationship,
  isBlockedEitherWay,
  notBlockedWith,
  parseUserIdParam,
  parseUuidParam,
  UserIdSchema,
} from '../social/people';
import type { Tx } from '../social/people';

const redeemLimit = { rateLimit: { max: 20, timeWindow: '1 hour' } };

const CreateInviteSchema = z
  .object({
    maxUses: z.number().int().min(1).max(CLOUD_LIMITS.inviteMaxUses).optional(),
  })
  .strict() satisfies z.ZodType<CreateInviteRequest>;

const BlockSchema = z
  .object({ userId: UserIdSchema })
  .strict() satisfies z.ZodType<BlockUserRequest>;

const collator = new Intl.Collator('es', { sensitivity: 'base' });

type InviteRow = typeof friendInvites.$inferSelect;

/**
 * The invite behind `rawCode` if it exists, is not the caller's own, and no block stands
 * between the two. Anything else is the same 404, so a code reveals nothing about why it does
 * not work. Expiry and uses are checked by the caller (see `isUsable`).
 */
async function findInvite(
  db: Db,
  callerId: string,
  rawCode: string,
): Promise<{ invite: InviteRow; inviterName: string }> {
  const code = normalizeInviteCode(rawCode);
  if (!code) throw notFound();
  const rows = await db
    .select({ invite: friendInvites, inviterName: profiles.displayName })
    .from(friendInvites)
    .innerJoin(profiles, eq(profiles.userId, friendInvites.inviterId))
    .where(eq(friendInvites.codeHash, hashInviteCode(code)))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    !row.inviterName ||
    row.invite.inviterId === callerId ||
    (await isBlockedEitherWay(db, callerId, row.invite.inviterId))
  ) {
    throw notFound();
  }
  return { invite: row.invite, inviterName: row.inviterName };
}

/** Not expired and uses left. */
function isUsable(invite: InviteRow, now: Date): boolean {
  return invite.expiresAt > now && invite.uses < invite.maxUses;
}

async function friendsSince(db: Db | Tx, a: string, b: string): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: friendships.createdAt })
    .from(friendships)
    .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

async function friendCount(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .select({ n: count() })
    .from(friendships)
    .where(eq(friendships.userId, userId));
  return Number(rows[0]?.n ?? 0);
}

export const friendsRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.post<{ Body: CreateInviteRequest; Reply: CreateInviteResponse }>(
    '/friends/invites',
    { config: { rateLimit: { max: 10, timeWindow: '1 day' } } },
    async (request, reply) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const body = parseBody(CreateInviteSchema, request);
      const now = ctx.now();
      // The preview shows the inviter's name, so inviting needs one.
      requireDisplayName(await getProfile(db, me.userId));

      const code = generateInviteCode();
      const maxUses = body.maxUses ?? 1;
      const expiresAt = new Date(now.getTime() + CLOUD_LIMITS.inviteTtlDays * 86_400_000);
      const invite = await db.transaction(async (tx) => {
        // Serializes invite creation per user so the active-invite limit holds under races.
        await tx
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.userId, me.userId))
          .for('update');
        const active = await tx
          .select({ n: count() })
          .from(friendInvites)
          .where(
            and(
              eq(friendInvites.inviterId, me.userId),
              gt(friendInvites.expiresAt, now),
              lt(friendInvites.uses, friendInvites.maxUses),
            ),
          );
        if (Number(active[0]?.n ?? 0) >= CLOUD_LIMITS.activeInvitesMax) {
          throw conflict('limit_reached', 'Too many active invites');
        }
        const [row] = await tx
          .insert(friendInvites)
          .values({
            inviterId: me.userId,
            codeHash: hashInviteCode(code),
            maxUses,
            uses: 0,
            expiresAt,
            createdAt: now,
          })
          .returning();
        if (!row) throw new Error('invite insert returned nothing');
        return row;
      });

      const shown = formatInviteCode(code);
      reply.status(201);
      return {
        id: invite.id,
        code: shown,
        url: `${ctx.config.auth?.url ?? ''}/i/${shown}`,
        expiresAt: invite.expiresAt.toISOString(),
        maxUses: invite.maxUses,
      };
    },
  );

  app.get<{ Reply: InvitesResponse }>('/friends/invites', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const now = ctx.now();
    const rows = await db
      .select()
      .from(friendInvites)
      .where(
        and(
          eq(friendInvites.inviterId, me.userId),
          gt(friendInvites.expiresAt, now),
          lt(friendInvites.uses, friendInvites.maxUses),
        ),
      )
      .orderBy(desc(friendInvites.createdAt));
    return {
      invites: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        maxUses: r.maxUses,
        uses: r.uses,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/friends/invites/:id', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const id = parseUuidParam(request.params.id);
    const deleted = await db
      .delete(friendInvites)
      .where(and(eq(friendInvites.id, id), eq(friendInvites.inviterId, me.userId)))
      .returning({ id: friendInvites.id });
    if (deleted.length === 0) throw notFound();
    return reply.status(204).send();
  });

  app.get<{ Params: { code: string }; Reply: InvitePreviewResponse }>(
    '/friends/invites/:code',
    { config: redeemLimit },
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const { invite, inviterName } = await findInvite(db, me.userId, request.params.code);
      if (!isUsable(invite, ctx.now())) throw notFound();
      return { inviter: { displayName: inviterName } };
    },
  );

  app.post<{ Params: { code: string }; Reply: AcceptInviteResponse }>(
    '/friends/invites/:code/accept',
    { config: redeemLimit },
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const now = ctx.now();
      requireDisplayName(await getProfile(db, me.userId));
      const { invite, inviterName } = await findInvite(db, me.userId, request.params.code);
      const inviterId = invite.inviterId;
      const friend = (since: Date): AcceptInviteResponse => ({
        friend: { userId: inviterId, displayName: inviterName, since: since.toISOString() },
      });
      // Already friends (for example a retry after a lost response): 200, no use consumed.
      const already = await friendsSince(db, me.userId, inviterId);
      if (already) return friend(already);
      if (!isUsable(invite, now)) throw notFound();

      const since = await db.transaction(async (tx) => {
        // Lock both profiles in a fixed order: the friend limit holds under races, no deadlock.
        for (const id of [me.userId, inviterId].sort()) {
          await tx
            .select({ userId: profiles.userId })
            .from(profiles)
            .where(eq(profiles.userId, id))
            .for('update');
        }
        const existing = await friendsSince(tx, me.userId, inviterId);
        if (existing) return existing;

        if (
          (await friendCount(tx, me.userId)) >= CLOUD_LIMITS.friendsMax ||
          (await friendCount(tx, inviterId)) >= CLOUD_LIMITS.friendsMax
        ) {
          throw conflict('limit_reached', 'Too many friends');
        }
        // Consume one use only while uses are left (the last use goes to exactly one person).
        const used = await tx
          .update(friendInvites)
          .set({ uses: sql`${friendInvites.uses} + 1` })
          .where(
            and(
              eq(friendInvites.id, invite.id),
              lt(friendInvites.uses, friendInvites.maxUses),
              gt(friendInvites.expiresAt, now),
            ),
          )
          .returning({ id: friendInvites.id });
        if (used.length === 0) throw notFound();
        await tx
          .insert(friendships)
          .values([
            { userId: me.userId, friendId: inviterId, createdAt: now },
            { userId: inviterId, friendId: me.userId, createdAt: now },
          ])
          .onConflictDoNothing();
        return now;
      });
      return friend(since);
    },
  );

  app.get<{ Reply: FriendsResponse }>('/friends', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const rows = await db
      .select({
        userId: friendships.friendId,
        displayName: profiles.displayName,
        since: friendships.createdAt,
      })
      .from(friendships)
      .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
      .where(
        and(eq(friendships.userId, me.userId), notBlockedWith(me.userId, friendships.friendId)),
      );
    const friends = rows
      .map((r) => ({
        userId: r.userId,
        displayName: r.displayName ?? '',
        since: r.since.toISOString(),
      }))
      .sort((a, b) => collator.compare(a.displayName, b.displayName) || cmp(a.userId, b.userId));
    return { friends };
  });

  // Both sides at once; idempotent. Partner links follow the cooling-off rule (see people.ts).
  app.delete<{ Params: { userId: string } }>('/friends/:userId', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const other = parseUserIdParam(request.params.userId);
    if (other !== me.userId) {
      const now = ctx.now();
      await db.transaction((tx) => endRelationship(tx, me.userId, other, now));
    }
    return reply.status(204).send();
  });

  app.get<{ Reply: BlocksResponse }>('/blocks', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const rows = await db
      .select({
        userId: userBlocks.blockedId,
        displayName: profiles.displayName,
        createdAt: userBlocks.createdAt,
      })
      .from(userBlocks)
      .leftJoin(profiles, eq(profiles.userId, userBlocks.blockedId))
      .where(eq(userBlocks.blockerId, me.userId))
      .orderBy(desc(userBlocks.createdAt), asc(userBlocks.blockedId));
    return {
      blocks: rows.map((r) => ({
        userId: r.userId,
        displayName: r.displayName ?? '',
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // Removes the friendship and hides both people from each other everywhere. Blocking an id
  // that does not exist is a silent 204 (ids cannot be probed).
  app.post<{ Body: BlockUserRequest }>('/blocks', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const { userId: other } = parseBody(BlockSchema, request);
    if (other === me.userId) {
      throw validationFailed([{ path: 'body.userId', message: 'Cannot block yourself' }]);
    }
    const now = ctx.now();
    const exists = await db.select({ id: user.id }).from(user).where(eq(user.id, other)).limit(1);
    if (exists.length > 0) {
      await db.transaction(async (tx) => {
        await tx
          .insert(userBlocks)
          .values({ blockerId: me.userId, blockedId: other, createdAt: now })
          .onConflictDoNothing();
        await endRelationship(tx, me.userId, other, now);
      });
    }
    return reply.status(204).send();
  });

  // Lifts the block; the friendship does not come back (a new invite is needed).
  app.delete<{ Params: { userId: string } }>('/blocks/:userId', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const other = parseUserIdParam(request.params.userId);
    await db
      .delete(userBlocks)
      .where(and(eq(userBlocks.blockerId, me.userId), eq(userBlocks.blockedId, other)));
    return reply.status(204).send();
  });
};

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
