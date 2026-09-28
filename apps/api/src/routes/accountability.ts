/**
 * Accountability partners, events, approvals and the partner inbox (owner: SOCIAL).
 * docs/API.md §9. Nothing here can end a block: a denial only makes the app cancel its own
 * emergency request through the guardian's existing cancel endpoint, and every approval
 * deadline ends no later than the guardian's own countdown (the flow fails open).
 *
 * - Weakening takes 24 hours (owner removes an active link, owner turns approval off);
 *   strengthening is immediate (adding a partner, approval on, undoing a pending removal).
 * - Events carry a kind and a time only: never a reason, domain, task or note from the owner.
 */
import type {
  AccountabilityEventResponse,
  ApprovalDecisionRequest,
  ApprovalState,
  CreatePartnerRequest,
  InboxItem,
  InboxResponse,
  PartnerLink,
  PartnersResponse,
  PatchPartnerRequest,
  PostAccountabilityEventRequest,
  PostAccountabilityEventResponse,
} from '@centrate/shared/cloud-api';
import { ACCOUNTABILITY_KINDS, CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { and, asc, count, desc, eq, gt, lte, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { accountabilityEvents, partnerLinks, profiles } from '../db/schema';
import { ApiError, conflict, forbidden, notFound, validationFailed } from '../lib/errors';
import { parseBody, requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireDisplayName } from '../lib/profile';
import { emailLinkProposal, emailPartnersAboutEvent } from '../social/partner-mail';
import {
  effectiveRequireApproval,
  isLive,
  linkIsListening,
  linkIsLive,
  toApprovalState,
  toEventResponse,
  toPartnerLink,
} from '../social/partners';
import type { AccountabilityEventRow, PartnerLinkRow } from '../social/partners';
import {
  areFriends,
  coolingOffMs,
  displayNames,
  isBlockedEitherWay,
  parseUuidParam,
  UserIdSchema,
} from '../social/people';

const eventLimit = { rateLimit: { max: 30, timeWindow: '1 hour' } };

const OCCURRED_PAST_MS = 7 * 86_400_000;
const OCCURRED_FUTURE_MS = 5 * 60_000;
const RETENTION_MS = CLOUD_LIMITS.accountabilityRetentionDays * 86_400_000;
const INBOX_MAX = 100;

const isoInstant = z.iso.datetime({ offset: true });

const CreatePartnerSchema = z
  .object({ friendId: UserIdSchema, requireApproval: z.boolean() })
  .strict() satisfies z.ZodType<CreatePartnerRequest>;

const PatchPartnerSchema = z
  .object({ requireApproval: z.boolean() })
  .strict() satisfies z.ZodType<PatchPartnerRequest>;

const EventSchema = z
  .object({
    clientRef: z
      .string()
      .min(CLOUD_LIMITS.opaqueIdMin)
      .max(CLOUD_LIMITS.opaqueIdMax)
      .regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque id'),
    kind: z.enum(ACCOUNTABILITY_KINDS),
    occurredAt: isoInstant,
    countdownEndsAt: isoInstant.nullable(),
  })
  .strict() satisfies z.ZodType<PostAccountabilityEventRequest>;

const DecisionSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    note: z
      .string()
      .max(CLOUD_LIMITS.noteMax * 4)
      .nullable(),
  })
  .strict() satisfies z.ZodType<ApprovalDecisionRequest>;

/** Trims the partner's note; empty is null. Over 140 characters or control characters: 400. */
function cleanNote(note: string | null): string | null {
  if (note === null) return null;
  const trimmed = note.trim();
  if (trimmed === '') return null;
  if (trimmed.length > CLOUD_LIMITS.noteMax || /[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    throw validationFailed([
      { path: 'body.note', message: `At most ${CLOUD_LIMITS.noteMax} characters of plain text` },
    ]);
  }
  return trimmed;
}

async function linkView(
  db: Db,
  row: PartnerLinkRow,
  viewerId: string,
  now: Date,
): Promise<PartnerLink> {
  const names = await displayNames(db, [row.ownerId, row.partnerId]);
  return toPartnerLink(row, viewerId, names, now);
}

/** A live link the caller is part of (as owner or partner), or 404. */
async function ownLink(db: Db, id: string, userId: string, now: Date): Promise<PartnerLinkRow> {
  const rows = await db
    .select()
    .from(partnerLinks)
    .where(
      and(
        eq(partnerLinks.id, id),
        or(eq(partnerLinks.ownerId, userId), eq(partnerLinks.partnerId, userId)),
        linkIsLive(now),
      ),
    )
    .limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/**
 * The event if the caller is a partner who hears about it: an active link to its owner (still
 * live, possibly ending) accepted no later than the event, and the event is within retention.
 */
async function eventForPartner(
  db: Db,
  eventId: string,
  partnerId: string,
  now: Date,
): Promise<AccountabilityEventRow | null> {
  const rows = await db
    .select({ event: accountabilityEvents })
    .from(accountabilityEvents)
    .innerJoin(
      partnerLinks,
      and(
        eq(partnerLinks.ownerId, accountabilityEvents.ownerId),
        eq(partnerLinks.partnerId, partnerId),
        linkIsListening(now),
        lte(partnerLinks.acceptedAt, accountabilityEvents.occurredAt),
      ),
    )
    .where(
      and(
        eq(accountabilityEvents.id, eventId),
        gt(accountabilityEvents.createdAt, new Date(now.getTime() - RETENTION_MS)),
      ),
    )
    .limit(1);
  return rows[0]?.event ?? null;
}

export const accountabilityRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  // ----- Partner links ------------------------------------------------------------------

  app.get<{ Reply: PartnersResponse }>('/partners', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const now = ctx.now();
    const rows = await db
      .select()
      .from(partnerLinks)
      .where(
        and(
          or(eq(partnerLinks.ownerId, me.userId), eq(partnerLinks.partnerId, me.userId)),
          linkIsLive(now),
        ),
      )
      .orderBy(asc(partnerLinks.createdAt), asc(partnerLinks.id));
    const names = await displayNames(
      db,
      rows.flatMap((r) => [r.ownerId, r.partnerId]),
    );
    return { links: rows.map((r) => toPartnerLink(r, me.userId, names, now)) };
  });

  // The owner (the person held accountable) proposes a friend; the partner must accept.
  app.post<{ Body: CreatePartnerRequest; Reply: PartnerLink }>(
    '/partners',
    async (request, reply) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const body = parseBody(CreatePartnerSchema, request);
      const myName = requireDisplayName(await getProfile(db, me.userId));
      const now = ctx.now();
      const partnerId = body.friendId;
      if (
        partnerId === me.userId ||
        !(await areFriends(db, me.userId, partnerId)) ||
        (await isBlockedEitherWay(db, me.userId, partnerId)) ||
        !(await displayNames(db, [partnerId])).has(partnerId)
      ) {
        throw notFound('Not a friend');
      }

      const result = await db.transaction(async (tx) => {
        // Serializes link changes per owner so the limit holds under races.
        await tx
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.userId, me.userId))
          .for('update');
        const [existing] = await tx
          .select()
          .from(partnerLinks)
          .where(and(eq(partnerLinks.ownerId, me.userId), eq(partnerLinks.partnerId, partnerId)))
          .limit(1);
        if (existing && isLive(existing, now)) {
          if (existing.endsAt === null) throw conflict('conflict', 'This partner link exists');
          // Undoing a pending removal strengthens the setup, so it applies at once.
          const [row] = await tx
            .update(partnerLinks)
            .set({
              endsAt: null,
              ...(body.requireApproval ? { requireApproval: true, approvalOffAt: null } : {}),
            })
            .where(eq(partnerLinks.id, existing.id))
            .returning();
          return { row: row ?? existing, created: false };
        }
        if (existing) {
          await tx.delete(partnerLinks).where(eq(partnerLinks.id, existing.id));
        }
        const live = await tx
          .select({ n: count() })
          .from(partnerLinks)
          .where(and(eq(partnerLinks.ownerId, me.userId), linkIsLive(now)));
        if (Number(live[0]?.n ?? 0) >= CLOUD_LIMITS.partnersMax) {
          throw conflict('limit_reached', 'Too many partners');
        }
        const [row] = await tx
          .insert(partnerLinks)
          .values({
            ownerId: me.userId,
            partnerId,
            status: 'pending',
            requireApproval: body.requireApproval,
            createdAt: now,
          })
          .returning();
        if (!row) throw new Error('partner link insert returned nothing');
        return { row, created: true };
      });

      if (result.created) await emailLinkProposal(ctx, db, request.log, partnerId, myName);
      reply.status(result.created ? 201 : 200);
      return linkView(db, result.row, me.userId, now);
    },
  );

  app.post<{ Params: { id: string }; Reply: PartnerLink }>(
    '/partners/:id/accept',
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const id = parseUuidParam(request.params.id);
      const now = ctx.now();
      const link = await ownLink(db, id, me.userId, now);
      if (link.partnerId !== me.userId) throw notFound();
      requireDisplayName(await getProfile(db, me.userId));
      if (link.status === 'active') return linkView(db, link, me.userId, now);
      const [row] = await db
        .update(partnerLinks)
        .set({ status: 'active', acceptedAt: now })
        .where(and(eq(partnerLinks.id, id), eq(partnerLinks.status, 'pending')))
        .returning();
      return linkView(db, row ?? (await ownLink(db, id, me.userId, now)), me.userId, now);
    },
  );

  // Owner only. Approval on applies now; approval off on an active link applies in 24 hours.
  app.patch<{ Params: { id: string }; Body: PatchPartnerRequest; Reply: PartnerLink }>(
    '/partners/:id',
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const id = parseUuidParam(request.params.id);
      const now = ctx.now();
      const link = await ownLink(db, id, me.userId, now);
      if (link.ownerId !== me.userId) throw forbidden('Only the owner changes approval');
      const { requireApproval } = parseBody(PatchPartnerSchema, request);

      let set: Partial<PartnerLinkRow> | null;
      if (requireApproval) {
        set = { requireApproval: true, approvalOffAt: null };
      } else if (!effectiveRequireApproval(link, now) || link.status === 'pending') {
        // Already off, or nobody is listening yet: nothing to cool off from.
        set = { requireApproval: false, approvalOffAt: null };
      } else if (link.approvalOffAt) {
        set = null; // Already scheduled: the earlier time stands.
      } else {
        set = { approvalOffAt: new Date(now.getTime() + coolingOffMs) };
      }
      if (!set) return linkView(db, link, me.userId, now);
      const [row] = await db
        .update(partnerLinks)
        .set(set)
        .where(eq(partnerLinks.id, id))
        .returning();
      return linkView(db, row ?? link, me.userId, now);
    },
  );

  // The partner leaves at once, and a pending link goes at once (204). An active link removed
  // by its owner keeps working for 24 hours (200 with `endsAt`).
  app.delete<{ Params: { id: string } }>('/partners/:id', async (request, reply) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const id = parseUuidParam(request.params.id);
    const now = ctx.now();
    const link = await ownLink(db, id, me.userId, now);
    if (link.partnerId === me.userId || link.status === 'pending') {
      await db.delete(partnerLinks).where(eq(partnerLinks.id, id));
      return reply.status(204).send();
    }
    if (link.endsAt) return linkView(db, link, me.userId, now);
    const [row] = await db
      .update(partnerLinks)
      .set({ endsAt: new Date(now.getTime() + coolingOffMs) })
      .where(and(eq(partnerLinks.id, id), eq(partnerLinks.status, 'active')))
      .returning();
    return linkView(db, row ?? link, me.userId, now);
  });

  // ----- Events ---------------------------------------------------------------------------

  app.post<{ Body: PostAccountabilityEventRequest; Reply: PostAccountabilityEventResponse }>(
    '/accountability/events',
    { config: eventLimit },
    async (request, reply) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const body = parseBody(EventSchema, request);
      const now = ctx.now();
      const occurredAt = new Date(body.occurredAt);
      if (
        occurredAt.getTime() < now.getTime() - OCCURRED_PAST_MS ||
        occurredAt.getTime() > now.getTime() + OCCURRED_FUTURE_MS
      ) {
        throw validationFailed([
          { path: 'body.occurredAt', message: 'Must be within the last 7 days' },
        ]);
      }

      // Replay of a queued event: answer with what is stored (200), change nothing.
      const stored = async (): Promise<AccountabilityEventRow | undefined> =>
        (
          await db
            .select()
            .from(accountabilityEvents)
            .where(
              and(
                eq(accountabilityEvents.ownerId, me.userId),
                eq(accountabilityEvents.clientRef, body.clientRef),
              ),
            )
            .limit(1)
        )[0];
      const previous = await stored();
      if (previous) {
        return { eventId: previous.id, approval: toApprovalState(previous, now, true) };
      }

      // Partners who hear about it: active (or ending) links accepted no later than the event.
      const listeners = await db
        .select({ partnerId: partnerLinks.partnerId, link: partnerLinks })
        .from(partnerLinks)
        .where(
          and(
            eq(partnerLinks.ownerId, me.userId),
            linkIsListening(now),
            lte(partnerLinks.acceptedAt, occurredAt),
          ),
        );

      // Approval: only for an emergency request whose local countdown leaves at least a
      // minute, when some partner requires it. The deadline never passes the countdown.
      let deadline: Date | null = null;
      const countdownEndsAt = body.countdownEndsAt ? new Date(body.countdownEndsAt) : null;
      if (
        body.kind === 'emergency_requested' &&
        countdownEndsAt &&
        countdownEndsAt.getTime() >= now.getTime() + CLOUD_LIMITS.approvalMinSeconds * 1000 &&
        listeners.some((l) => effectiveRequireApproval(l.link, now))
      ) {
        deadline = new Date(
          Math.min(
            countdownEndsAt.getTime(),
            now.getTime() + CLOUD_LIMITS.approvalMaxMinutes * 60_000,
          ),
        );
      }

      const [inserted] = await db
        .insert(accountabilityEvents)
        .values({
          ownerId: me.userId,
          clientRef: body.clientRef,
          kind: body.kind,
          occurredAt,
          createdAt: now,
          approvalStatus: deadline ? 'pending' : null,
          approvalDeadline: deadline,
        })
        .onConflictDoNothing({
          target: [accountabilityEvents.ownerId, accountabilityEvents.clientRef],
        })
        .returning();
      if (!inserted) {
        // A concurrent replay won the insert.
        const row = await stored();
        if (!row) throw new ApiError(500, 'internal_error', 'Event vanished');
        return { eventId: row.id, approval: toApprovalState(row, now, true) };
      }

      const ownerName = (await displayNames(db, [me.userId])).get(me.userId) ?? '';
      await emailPartnersAboutEvent(
        ctx,
        db,
        request.log,
        listeners.map((l) => l.partnerId),
        { kind: inserted.kind, ownerName, occurredAt, approvalDeadline: deadline },
      );
      reply.status(201);
      return { eventId: inserted.id, approval: toApprovalState(inserted, now, true) };
    },
  );

  // The owner polls this every 15 s while an approval is pending.
  app.get<{ Params: { id: string }; Reply: AccountabilityEventResponse }>(
    '/accountability/events/:id',
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const id = parseUuidParam(request.params.id);
      const now = ctx.now();
      const [row] = await db
        .select()
        .from(accountabilityEvents)
        .where(
          and(
            eq(accountabilityEvents.id, id),
            eq(accountabilityEvents.ownerId, me.userId),
            gt(accountabilityEvents.createdAt, new Date(now.getTime() - RETENTION_MS)),
          ),
        )
        .limit(1);
      if (!row) throw notFound();
      return toEventResponse(row, now);
    },
  );

  app.get<{ Reply: InboxResponse }>('/accountability/inbox', async (request) => {
    requireFeature(ctx, 'social');
    const me = requireUser(request);
    const db = requireDb(ctx);
    const now = ctx.now();
    const rows = await db
      .select({ event: accountabilityEvents })
      .from(accountabilityEvents)
      .innerJoin(
        partnerLinks,
        and(
          eq(partnerLinks.ownerId, accountabilityEvents.ownerId),
          eq(partnerLinks.partnerId, me.userId),
          linkIsListening(now),
          lte(partnerLinks.acceptedAt, accountabilityEvents.occurredAt),
        ),
      )
      .where(gt(accountabilityEvents.createdAt, new Date(now.getTime() - RETENTION_MS)))
      .orderBy(
        desc(accountabilityEvents.occurredAt),
        desc(accountabilityEvents.createdAt),
        asc(accountabilityEvents.id),
      )
      .limit(INBOX_MAX);
    const names = await displayNames(
      db,
      rows.map((r) => r.event.ownerId),
    );
    const items: InboxItem[] = rows.map(({ event }) => {
      const decidedByMe = event.decidedBy === me.userId;
      return {
        eventId: event.id,
        kind: event.kind,
        owner: { userId: event.ownerId, displayName: names.get(event.ownerId) ?? '' },
        occurredAt: event.occurredAt.toISOString(),
        // The note is for the owner; other partners see only the outcome.
        approval: toApprovalState(event, now, decidedByMe),
        decidedByMe,
      };
    });
    return { items };
  });

  // First decision wins. Any partner with an active link to the owner may decide.
  app.post<{ Params: { id: string }; Body: ApprovalDecisionRequest; Reply: ApprovalState }>(
    '/accountability/events/:id/decision',
    { config: eventLimit },
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const id = parseUuidParam(request.params.id);
      const body = parseBody(DecisionSchema, request);
      const note = cleanNote(body.note);
      const status = body.decision === 'approve' ? 'approved' : 'denied';
      const now = ctx.now();

      const event = await eventForPartner(db, id, me.userId, now);
      if (!event) throw notFound();
      const check = (row: AccountabilityEventRow): ApprovalState => {
        if (row.approvalStatus === null) throw conflict('conflict', 'No approval was requested');
        if (row.approvalStatus !== 'pending') {
          // The same partner repeating the same answer (a retry) is not an error.
          if (row.decidedBy === me.userId && row.approvalStatus === status) {
            return toApprovalState(row, now, true) as ApprovalState;
          }
          throw conflict('already_decided', 'Somebody already answered');
        }
        throw conflict('deadline_passed', 'The deadline has passed');
      };
      if (event.approvalStatus !== 'pending' || !event.approvalDeadline) return check(event);
      if (event.approvalDeadline <= now) return check(event);

      const [updated] = await db
        .update(accountabilityEvents)
        .set({ approvalStatus: status, decidedBy: me.userId, decidedAt: now, note })
        .where(
          and(
            eq(accountabilityEvents.id, id),
            eq(accountabilityEvents.approvalStatus, 'pending'),
            gt(accountabilityEvents.approvalDeadline, now),
          ),
        )
        .returning();
      if (updated) return toApprovalState(updated, now, true) as ApprovalState;
      // Lost a race with another partner (or the deadline passed meanwhile).
      const again = await eventForPartner(db, id, me.userId, now);
      if (!again) throw notFound();
      return check(again);
    },
  );
};
