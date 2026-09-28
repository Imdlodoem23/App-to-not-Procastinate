/**
 * Accountability partners, events, approvals and the partner inbox (owner: SOCIAL).
 * docs/API.md §9. Nothing here can end a block: a denial only makes the app cancel its own
 * emergency request through the guardian's existing cancel endpoint, and every approval
 * deadline ends no later than the guardian's own countdown (the flow fails open).
 *
 * - Weakening takes 24 hours (owner removes an active link, owner turns approval off);
 *   strengthening is immediate (adding a partner, approval on, undoing a pending removal).
 * - Only partners whose link asks for approval answer an approval, and a denial wins: it
 *   replaces an earlier approval until the deadline. An approval never shortens anything, so a
 *   partner the owner added in a hurry (or controls) cannot lock out a stricter one's «no».
 * - Events carry a kind and a time only: never a reason, domain, task or note from the owner.
 *   One that no partner hears about is not stored at all.
 * - The owner's computer clock may be off: its instants only count relative to `sentAt` (its
 *   clock when sending), placed on the server's clock at the time the request arrives.
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
import { and, asc, count, desc, eq, gt, inArray, lte, or } from 'drizzle-orm';
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

/** How long before its sending an event may have happened (both on the app's clock). */
const OCCURRED_PAST_MS = 7 * 86_400_000;
/** `occurredAt` a little after `sentAt`: the app's clock stepped back in between. */
const OCCURRED_FUTURE_MS = 5 * 60_000;
const APPROVAL_MIN_MS = CLOUD_LIMITS.approvalMinSeconds * 1000;
const APPROVAL_MAX_MS = CLOUD_LIMITS.approvalMaxMinutes * 60_000;
const APPROVAL_MARGIN_MS = CLOUD_LIMITS.approvalMarginSeconds * 1000;
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
    sentAt: isoInstant,
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

interface PartnerEvent {
  event: AccountabilityEventRow;
  /** The caller's link to the event's owner (one per owner and partner). */
  link: PartnerLinkRow;
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
): Promise<PartnerEvent | null> {
  const rows = await db
    .select({ event: accountabilityEvents, link: partnerLinks })
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
  return rows[0] ?? null;
}

/**
 * Whether the partner may still answer: their link asks for approval now, the deadline has not
 * passed, and nobody denied (a denial is final; an approval can still turn into a denial).
 */
function canDecide(event: AccountabilityEventRow, link: PartnerLinkRow, now: Date): boolean {
  return (
    effectiveRequireApproval(link, now) &&
    event.approvalDeadline !== null &&
    event.approvalDeadline > now &&
    (event.approvalStatus === 'pending' || event.approvalStatus === 'approved')
  );
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
      // Clock-independent: how long ago it happened and how much countdown is left, both
      // measured on the app's clock at `sentAt`, then placed on ours.
      const sentAt = Date.parse(body.sentAt);
      const ageMs = sentAt - Date.parse(body.occurredAt);
      if (ageMs > OCCURRED_PAST_MS || ageMs < -OCCURRED_FUTURE_MS) {
        throw validationFailed([
          { path: 'body.occurredAt', message: 'Must be within the 7 days before sentAt' },
        ]);
      }
      const occurredAt = new Date(now.getTime() - Math.max(0, ageMs));
      const countdownLeftMs =
        body.countdownEndsAt === null ? null : Date.parse(body.countdownEndsAt) - sentAt;

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

      // Nobody hears about it: keep nothing (a replay stays harmless, since a partner who
      // accepts later never hears about an earlier event).
      if (listeners.length === 0) return { eventId: null, approval: null };

      // Approval: only for an emergency request whose local countdown leaves the partner at
      // least a minute, when some partner requires it. The deadline ends a margin before the
      // countdown (travel time, one poll) and at most 30 minutes from now.
      let deadline: Date | null = null;
      const approvalMs =
        countdownLeftMs === null
          ? null
          : Math.min(countdownLeftMs - APPROVAL_MARGIN_MS, APPROVAL_MAX_MS);
      if (
        body.kind === 'emergency_requested' &&
        approvalMs !== null &&
        approvalMs >= APPROVAL_MIN_MS &&
        listeners.some((l) => effectiveRequireApproval(l.link, now))
      ) {
        deadline = new Date(now.getTime() + approvalMs);
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
        listeners.map((l) => ({
          userId: l.partnerId,
          canDecide: effectiveRequireApproval(l.link, now),
        })),
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
      .select({ event: accountabilityEvents, link: partnerLinks })
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
    const items: InboxItem[] = rows.map(({ event, link }) => {
      const decidedByMe = event.decidedBy === me.userId;
      return {
        eventId: event.id,
        kind: event.kind,
        owner: { userId: event.ownerId, displayName: names.get(event.ownerId) ?? '' },
        occurredAt: event.occurredAt.toISOString(),
        // The note is for the owner; other partners see only the outcome.
        approval: toApprovalState(event, now, decidedByMe),
        decidedByMe,
        canDecide: canDecide(event, link, now),
      };
    });
    return { items };
  });

  // Only partners whose link asks for approval decide. A denial wins: it replaces a pending or
  // approved answer until the deadline, and nothing replaces a denial.
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

      const found = await eventForPartner(db, id, me.userId, now);
      if (!found) throw notFound();
      if (found.event.approvalStatus === null || !found.event.approvalDeadline) {
        throw conflict('conflict', 'No approval was requested');
      }
      // A partner who is only told (approval off, or its 24 h switch-off applied) sees the
      // outcome but does not answer.
      if (!effectiveRequireApproval(found.link, now)) {
        throw forbidden('This partner link does not ask for your approval');
      }

      /** Why this decision cannot apply to `row`, or the answer to a harmless repeat. */
      const refuse = (row: AccountabilityEventRow): ApprovalState => {
        // The same partner repeating the same answer (a retry) is not an error.
        if (row.decidedBy === me.userId && row.approvalStatus === status) {
          return toApprovalState(row, now, true) as ApprovalState;
        }
        if (
          row.approvalStatus === 'denied' ||
          (row.approvalStatus === 'approved' && status === 'approved')
        ) {
          throw conflict('already_decided', 'Somebody already answered');
        }
        // Still pending, or approved and this is a «no»: only the deadline stops it.
        throw conflict('deadline_passed', 'The deadline has passed');
      };
      if (!canDecide(found.event, found.link, now)) return refuse(found.event);

      const [updated] = await db
        .update(accountabilityEvents)
        .set({ approvalStatus: status, decidedBy: me.userId, decidedAt: now, note })
        .where(
          and(
            eq(accountabilityEvents.id, id),
            status === 'denied'
              ? inArray(accountabilityEvents.approvalStatus, ['pending', 'approved'])
              : eq(accountabilityEvents.approvalStatus, 'pending'),
            gt(accountabilityEvents.approvalDeadline, now),
          ),
        )
        .returning();
      if (updated) return toApprovalState(updated, now, true) as ApprovalState;
      // Already answered, the deadline passed, or another partner won a race.
      const again = await eventForPartner(db, id, me.userId, now);
      if (!again) throw notFound();
      return refuse(again.event);
    },
  );
};
