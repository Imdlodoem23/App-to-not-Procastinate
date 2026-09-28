import type {
  AccountabilityEventResponse,
  ApprovalState,
  InboxResponse,
  PartnerLink,
  PartnersResponse,
  PostAccountabilityEventResponse,
} from '@centrate/shared/cloud-api';
import { ACCOUNTABILITY_KINDS, approvalOutcome } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, deriveCapabilities } from '../src/config';
import type { MailMessage, Mailer } from '../src/context';
import {
  accountabilityEvents,
  partnerLinks,
  profiles,
  rateCounters,
  usageCounters,
} from '../src/db/schema';
import { createResendMailer, MailerError, parseRetryAfter } from '../src/lib/mailer';
import { composeLinkProposal } from '../src/social/partner-mail';
import {
  buildTestApp,
  createTestUser,
  fakeClock,
  fakeMailer,
  testConfig,
  type CreateUserOptions,
  type FakeClock,
  type TestUser,
} from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { befriend, caller, linkPartners, type Caller } from './helpers/social';

const T0 = '2026-09-28T10:00:00.000Z';
const minutes = (n: number) => n * 60_000;
const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;

describe('accountability partners', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let call: Caller;
  let mailer: Mailer & { sent: MailMessage[] };
  let ana: TestUser;
  let bea: TestUser;
  let carlos: TestUser;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    clock = fakeClock(T0);
    mailer = fakeMailer();
    app = await buildTestApp({ db: t.db, clock, mailer });
    call = caller(app);
    ana = await person({ displayName: 'Ana', email: 'ana@example.com' });
    bea = await person({
      displayName: 'Bea',
      email: 'bea@example.com',
      sharing: { partnerEmails: true },
    });
    carlos = await person({ displayName: 'Carlos', email: 'carlos@example.com' });
  });
  afterEach(async () => {
    expect(call.bodies.join('\n')).not.toContain('@');
    await app.close();
  });

  function person(options: CreateUserOptions): Promise<TestUser> {
    return createTestUser(t.db, { now: clock.now(), ...options });
  }
  const iso = (offsetMs = 0) => new Date(clock.now().getTime() + offsetMs).toISOString();
  const ref = () => randomUUID().replace(/-/g, '');

  async function postEvent(
    who: TestUser,
    body: Partial<{
      clientRef: string;
      kind: string;
      occurredAt: string;
      countdownEndsAt: string | null;
      sentAt: string;
    }> = {},
  ) {
    return call(who, 'POST', '/v1/accountability/events', {
      clientRef: ref(),
      kind: 'emergency_requested',
      occurredAt: iso(),
      countdownEndsAt: null,
      sentAt: iso(),
      ...body,
    });
  }

  describe('links', () => {
    it('goes from proposal to active; weakening waits 24 hours, strengthening does not', async () => {
      await befriend(t.db, ana, bea);
      const proposed = await call(ana, 'POST', '/v1/partners', {
        friendId: bea.userId,
        requireApproval: false,
      });
      expect(proposed.status).toBe(201);
      const link = proposed.json<PartnerLink>();
      expect(link).toEqual({
        id: expect.any(String),
        role: 'owner',
        owner: { userId: ana.userId, displayName: 'Ana' },
        partner: { userId: bea.userId, displayName: 'Bea' },
        status: 'pending',
        requireApproval: false,
        approvalOffAt: null,
        endsAt: null,
        createdAt: T0,
        acceptedAt: null,
      });
      // Bea wants partner emails: she hears about the proposal.
      expect(mailer.sent.map((m) => [m.to, m.tag, m.subject])).toEqual([
        ['bea@example.com', 'partner_link', 'Ana quiere que seas su compañero de responsabilidad'],
      ]);

      const again = await call(ana, 'POST', '/v1/partners', {
        friendId: bea.userId,
        requireApproval: true,
      });
      expect(again.status).toBe(409);
      expect(errorCode(again.body)).toBe('conflict');

      const beaView = (await call(bea, 'GET', '/v1/partners')).json<PartnersResponse>();
      expect(beaView.links).toMatchObject([{ id: link.id, role: 'partner', status: 'pending' }]);
      // Only the partner accepts.
      expect((await call(ana, 'POST', `/v1/partners/${link.id}/accept`)).status).toBe(404);
      expect((await call(carlos, 'POST', `/v1/partners/${link.id}/accept`)).status).toBe(404);
      clock.advance(minutes(1));
      const accepted = await call(bea, 'POST', `/v1/partners/${link.id}/accept`);
      expect(accepted.json<PartnerLink>()).toMatchObject({
        role: 'partner',
        status: 'active',
        acceptedAt: '2026-09-28T10:01:00.000Z',
      });
      expect((await call(bea, 'POST', `/v1/partners/${link.id}/accept`)).status).toBe(200);

      // Approval on: immediate. Only the owner may change it.
      const on = await call(ana, 'PATCH', `/v1/partners/${link.id}`, { requireApproval: true });
      expect(on.json<PartnerLink>()).toMatchObject({ requireApproval: true, approvalOffAt: null });
      const byPartner = await call(bea, 'PATCH', `/v1/partners/${link.id}`, {
        requireApproval: false,
      });
      expect(byPartner.status).toBe(403);

      // Approval off: still required for 24 hours.
      const off = await call(ana, 'PATCH', `/v1/partners/${link.id}`, { requireApproval: false });
      expect(off.json<PartnerLink>()).toMatchObject({
        requireApproval: true,
        approvalOffAt: '2026-09-29T10:01:00.000Z',
      });
      // Asking again does not push the time further.
      clock.advance(minutes(60));
      const offAgain = await call(ana, 'PATCH', `/v1/partners/${link.id}`, {
        requireApproval: false,
      });
      expect(offAgain.json<PartnerLink>().approvalOffAt).toBe('2026-09-29T10:01:00.000Z');
      clock.set('2026-09-29T10:01:00.000Z');
      const applied = (await call(ana, 'GET', '/v1/partners')).json<PartnersResponse>().links[0];
      expect(applied).toMatchObject({ requireApproval: false, approvalOffAt: null });

      // Removal by the owner: the link keeps working for 24 hours.
      const removal = await call(ana, 'DELETE', `/v1/partners/${link.id}`);
      expect(removal.status).toBe(200);
      expect(removal.json<PartnerLink>().endsAt).toBe('2026-09-30T10:01:00.000Z');
      // Changing their mind is strengthening: immediate.
      const undo = await call(ana, 'POST', '/v1/partners', {
        friendId: bea.userId,
        requireApproval: true,
      });
      expect(undo.status).toBe(200);
      expect(undo.json<PartnerLink>()).toMatchObject({
        id: link.id,
        status: 'active',
        endsAt: null,
        requireApproval: true,
      });
      await call(ana, 'DELETE', `/v1/partners/${link.id}`);
      clock.set('2026-09-30T10:01:00.000Z');
      expect((await call(ana, 'GET', '/v1/partners')).json<PartnersResponse>().links).toEqual([]);
      expect((await call(bea, 'GET', '/v1/partners')).json<PartnersResponse>().links).toEqual([]);
      expect((await call(ana, 'DELETE', `/v1/partners/${link.id}`)).status).toBe(404);

      // After it ended, a new proposal starts from scratch.
      const fresh = await call(ana, 'POST', '/v1/partners', {
        friendId: bea.userId,
        requireApproval: false,
      });
      expect(fresh.status).toBe(201);
      expect(fresh.json<PartnerLink>().status).toBe('pending');
    });

    it('lets the partner leave at once and removes pending links at once', async () => {
      await befriend(t.db, ana, bea);
      await befriend(t.db, ana, carlos);
      const active = await linkPartners(t.db, ana, bea, { requireApproval: true });
      expect((await call(bea, 'DELETE', `/v1/partners/${active}`)).status).toBe(204);
      expect(await t.db.select().from(partnerLinks)).toEqual([]);

      const pending = await call(ana, 'POST', '/v1/partners', {
        friendId: carlos.userId,
        requireApproval: true,
      });
      const id = pending.json<PartnerLink>().id;
      // Approval off on a pending link applies at once: nobody listens yet.
      const off = await call(ana, 'PATCH', `/v1/partners/${id}`, { requireApproval: false });
      expect(off.json<PartnerLink>()).toMatchObject({
        requireApproval: false,
        approvalOffAt: null,
      });
      expect((await call(ana, 'DELETE', `/v1/partners/${id}`)).status).toBe(204);
      expect(await t.db.select().from(partnerLinks)).toEqual([]);
    });

    it('needs a friend with a name, a display name, and allows three partners', async () => {
      const ask = (who: TestUser, friendId: string) =>
        call(who, 'POST', '/v1/partners', { friendId, requireApproval: false });
      expect((await ask(ana, bea.userId)).status).toBe(404); // not friends
      expect((await ask(ana, ana.userId)).status).toBe(404);
      expect((await ask(ana, 'no-such-user')).status).toBe(404);
      const bad = await call(ana, 'POST', '/v1/partners', { friendId: bea.userId });
      expect(bad.status).toBe(400);

      const nameless = await person({ displayName: null });
      await befriend(t.db, nameless, bea);
      expect(errorCode((await ask(nameless, bea.userId)).body)).toBe('profile_incomplete');

      const friends = [bea, carlos, await person({ displayName: 'Dani' })];
      const extra = await person({ displayName: 'Eva' });
      for (const f of [...friends, extra]) await befriend(t.db, ana, f);
      for (const f of friends) expect((await ask(ana, f.userId)).status).toBe(201);
      const fourth = await ask(ana, extra.userId);
      expect(fourth.status).toBe(409);
      expect(errorCode(fourth.body)).toBe('limit_reached');
    });
  });

  describe('events and approvals', () => {
    beforeEach(async () => {
      await befriend(t.db, ana, bea);
      await befriend(t.db, ana, carlos);
      await linkPartners(t.db, ana, bea, { requireApproval: true, at: clock.now() });
      await linkPartners(t.db, ana, carlos, { requireApproval: false, at: clock.now() });
    });

    it('is idempotent on clientRef and lets only partners who must approve decide', async () => {
      const clientRef = ref();
      const first = await postEvent(ana, { clientRef, countdownEndsAt: iso(minutes(10)) });
      expect(first.status).toBe(201);
      const created = first.json<PostAccountabilityEventResponse>();
      expect(created.approval).toEqual({
        status: 'pending',
        deadline: '2026-09-28T10:09:30.000Z',
        note: null,
        decidedAt: null,
      });
      const replay = await postEvent(ana, { clientRef, countdownEndsAt: iso(minutes(10)) });
      expect(replay.status).toBe(200);
      expect(replay.json<PostAccountabilityEventResponse>().eventId).toBe(created.eventId);
      expect(await t.db.select().from(accountabilityEvents)).toHaveLength(1);

      const inbox = (await call(carlos, 'GET', '/v1/accountability/inbox')).json<InboxResponse>();
      expect(inbox.items).toEqual([
        {
          eventId: created.eventId,
          kind: 'emergency_requested',
          owner: { userId: ana.userId, displayName: 'Ana' },
          occurredAt: T0,
          approval: created.approval,
          decidedByMe: false,
          // Carlos's link does not ask for approval: he is told, he does not answer.
          canDecide: false,
        },
      ]);
      const beaBefore = (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>();
      expect(beaBefore.items).toMatchObject([{ eventId: created.eventId, canDecide: true }]);

      clock.advance(minutes(2));
      const deny = await call(
        bea,
        'POST',
        `/v1/accountability/events/${created.eventId}/decision`,
        {
          decision: 'deny',
          note: '  Hoy no, que mañana tienes examen  ',
        },
      );
      expect(deny.status).toBe(200);
      expect(deny.json<ApprovalState>()).toEqual({
        status: 'denied',
        deadline: '2026-09-28T10:09:30.000Z',
        note: 'Hoy no, que mañana tienes examen',
        decidedAt: '2026-09-28T10:02:00.000Z',
      });
      // A partner who is only told cannot answer; the same partner repeating herself is fine.
      const told = await call(
        carlos,
        'POST',
        `/v1/accountability/events/${created.eventId}/decision`,
        { decision: 'approve', note: null },
      );
      expect(told.status).toBe(403);
      expect(errorCode(told.body)).toBe('forbidden');
      const repeat = await call(
        bea,
        'POST',
        `/v1/accountability/events/${created.eventId}/decision`,
        { decision: 'deny', note: null },
      );
      expect(repeat.status).toBe(200);

      const owner = await call(ana, 'GET', `/v1/accountability/events/${created.eventId}`);
      expect(owner.json<AccountabilityEventResponse>()).toEqual({
        eventId: created.eventId,
        kind: 'emergency_requested',
        occurredAt: T0,
        approval: deny.json<ApprovalState>(),
      });
      // The note is for the owner (and its author); other partners see the outcome.
      const carlosItem = (
        await call(carlos, 'GET', '/v1/accountability/inbox')
      ).json<InboxResponse>().items[0];
      expect(carlosItem?.approval).toMatchObject({ status: 'denied', note: null });
      const beaItem = (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>()
        .items[0];
      expect(beaItem).toMatchObject({
        decidedByMe: true,
        canDecide: false,
        approval: { note: expect.any(String) },
      });
      // Nothing replaces a denial, not even her own change of mind.
      const undo = await call(
        bea,
        'POST',
        `/v1/accountability/events/${created.eventId}/decision`,
        { decision: 'approve', note: null },
      );
      expect(undo.status).toBe(409);
      expect(errorCode(undo.body)).toBe('already_decided');
    });

    it('never outlasts the local countdown and expires on read', async () => {
      const long = await postEvent(ana, { countdownEndsAt: iso(minutes(120)) });
      expect(long.json<PostAccountabilityEventResponse>().approval?.deadline).toBe(
        '2026-09-28T10:30:00.000Z',
      );
      const approve = await call(
        bea,
        'POST',
        `/v1/accountability/events/${long.json<PostAccountabilityEventResponse>().eventId}/decision`,
        { decision: 'approve', note: null },
      );
      expect(approve.json<ApprovalState>()).toMatchObject({ status: 'approved', note: null });
      // The partner gets at least a minute, and the deadline ends 30 s before the countdown.
      const short = await postEvent(ana, { countdownEndsAt: iso(89_000) });
      expect(short.status).toBe(201);
      expect(short.json<PostAccountabilityEventResponse>().approval).toBeNull();
      const tight = await postEvent(ana, { countdownEndsAt: iso(90_000) });
      expect(tight.json<PostAccountabilityEventResponse>().approval?.deadline).toBe(
        '2026-09-28T10:01:00.000Z',
      );
      const confirmed = await postEvent(ana, {
        kind: 'emergency_confirmed',
        countdownEndsAt: iso(minutes(10)),
      });
      expect(confirmed.json<PostAccountabilityEventResponse>().approval).toBeNull();

      const soon = await postEvent(ana, { countdownEndsAt: iso(minutes(5)) });
      const id = soon.json<PostAccountabilityEventResponse>().eventId;
      clock.advance(minutes(5));
      const read = await call(ana, 'GET', `/v1/accountability/events/${id}`);
      expect(read.json<AccountabilityEventResponse>().approval?.status).toBe('expired');
      const tooLate = await call(bea, 'POST', `/v1/accountability/events/${id}/decision`, {
        decision: 'deny',
        note: null,
      });
      expect(tooLate.status).toBe(409);
      expect(errorCode(tooLate.body)).toBe('deadline_passed');

      // Without an approving partner there is nothing to wait for.
      await t.db.update(partnerLinks).set({ requireApproval: false });
      const free = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      expect(free.json<PostAccountabilityEventResponse>().approval).toBeNull();
      const noApproval = await call(
        bea,
        'POST',
        `/v1/accountability/events/${free.json<PostAccountabilityEventResponse>().eventId}/decision`,
        { decision: 'approve', note: null },
      );
      expect(noApproval.status).toBe(409);
      expect(errorCode(noApproval.body)).toBe('conflict');
    });

    it('lets a denial win over a quick approval until the deadline', async () => {
      // Ana adds Dani (an account she controls) with approval on: immediate, and he accepts in
      // seconds. Bea is the strict partner from before.
      const dani = await person({ displayName: 'Dani' });
      await befriend(t.db, ana, dani);
      clock.advance(10_000);
      const daniLink = await linkPartners(t.db, ana, dani, {
        requireApproval: true,
        at: clock.now(),
      });
      clock.advance(5_000);
      const res = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const { eventId, approval } = res.json<PostAccountabilityEventResponse>();
      const countdownEndsAt = iso(minutes(10));
      const decide = (who: TestUser, decision: 'approve' | 'deny', note: string | null = null) =>
        call(who, 'POST', `/v1/accountability/events/${eventId}/decision`, { decision, note });

      // Dani approves at once: the owner sees it, but the app keeps waiting.
      const quick = await decide(dani, 'approve', 'Adelante');
      expect(quick.json<ApprovalState>()).toMatchObject({ status: 'approved' });
      const owner = async () =>
        (
          await call(ana, 'GET', `/v1/accountability/events/${eventId}`)
        ).json<AccountabilityEventResponse>().approval;
      expect(approvalOutcome(await owner(), clock.now(), countdownEndsAt)).toBe('wait');
      // Another approval changes nothing; a retry from Dani is fine.
      expect(errorCode((await decide(bea, 'approve')).body)).toBe('already_decided');
      expect((await decide(dani, 'approve')).status).toBe(200);

      // Bea still sees she can answer, and her «no» wins.
      const beaItems = (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>();
      expect(beaItems.items).toMatchObject([
        {
          eventId,
          canDecide: true,
          decidedByMe: false,
          approval: { status: 'approved', note: null },
        },
      ]);
      clock.advance(minutes(5));
      const no = await decide(bea, 'deny', 'No, que te conozco');
      expect(no.status).toBe(200);
      expect(no.json<ApprovalState>()).toEqual({
        status: 'denied',
        deadline: approval?.deadline,
        note: 'No, que te conozco',
        decidedAt: clock.now().toISOString(),
      });
      const final = await owner();
      expect(final).toMatchObject({ status: 'denied', note: 'No, que te conozco' });
      expect(approvalOutcome(final, clock.now(), countdownEndsAt)).toBe('denied');
      // Dani cannot approve over it, and sees only the outcome.
      expect(errorCode((await decide(dani, 'approve')).body)).toBe('already_decided');
      const daniItem = (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>()
        .items[0];
      expect(daniItem).toMatchObject({
        canDecide: false,
        decidedByMe: false,
        approval: { status: 'denied', note: null },
      });

      // A partner may turn their own approval into a denial; past the deadline nothing changes.
      const next = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const nextId = next.json<PostAccountabilityEventResponse>().eventId;
      const decideNext = (who: TestUser, decision: 'approve' | 'deny') =>
        call(who, 'POST', `/v1/accountability/events/${nextId}/decision`, { decision, note: null });
      expect((await decideNext(dani, 'approve')).status).toBe(200);
      expect((await decideNext(dani, 'deny')).json<ApprovalState>().status).toBe('denied');
      const third = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const thirdId = third.json<PostAccountabilityEventResponse>().eventId;
      await call(dani, 'POST', `/v1/accountability/events/${thirdId}/decision`, {
        decision: 'approve',
        note: null,
      });
      clock.advance(minutes(10));
      const tooLate = await call(bea, 'POST', `/v1/accountability/events/${thirdId}/decision`, {
        decision: 'deny',
        note: null,
      });
      expect(tooLate.status).toBe(409);
      expect(errorCode(tooLate.body)).toBe('deadline_passed');

      // Approval switched off: Dani keeps deciding for the 24 hours it takes, then only hears.
      await call(ana, 'PATCH', `/v1/partners/${daniLink}`, { requireApproval: false });
      const during = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const duringId = during.json<PostAccountabilityEventResponse>().eventId;
      const daniDuring = await call(
        dani,
        'POST',
        `/v1/accountability/events/${duringId}/decision`,
        {
          decision: 'approve',
          note: null,
        },
      );
      expect(daniDuring.status).toBe(200);
      clock.advance(24 * 3_600_000);
      const after = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const afterId = after.json<PostAccountabilityEventResponse>().eventId;
      const daniAfter = await call(dani, 'POST', `/v1/accountability/events/${afterId}/decision`, {
        decision: 'deny',
        note: null,
      });
      expect(daniAfter.status).toBe(403);
      const daniInbox = (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>();
      expect(daniInbox.items.find((i) => i.eventId === afterId)).toMatchObject({
        canDecide: false,
        approval: { status: 'pending' },
      });
    });

    it('keeps nothing when no partner hears about the event', async () => {
      const dani = await person({ displayName: 'Dani' });
      const eva = await person({ displayName: 'Eva', sharing: { partnerEmails: true } });
      await befriend(t.db, dani, eva);
      const notStored = { eventId: null, approval: null };

      // No partner at all.
      const alone = await postEvent(dani, { countdownEndsAt: iso(minutes(10)) });
      expect(alone.status).toBe(200);
      expect(alone.json<PostAccountabilityEventResponse>()).toEqual(notStored);

      // A pending link does not listen yet: no kind is kept.
      await t.db.insert(partnerLinks).values({
        ownerId: dani.userId,
        partnerId: eva.userId,
        status: 'pending',
        requireApproval: true,
        createdAt: clock.now(),
      });
      const queuedRef = ref();
      for (const kind of ACCOUNTABILITY_KINDS) {
        const clientRef = kind === 'study_abandoned' ? queuedRef : ref();
        const res = await postEvent(dani, { kind, clientRef, countdownEndsAt: iso(minutes(10)) });
        expect(res.status).toBe(200);
        expect(res.json<PostAccountabilityEventResponse>()).toEqual(notStored);
      }

      // Accepted after the event: the outbox replaying it later still stores nothing.
      clock.advance(minutes(1));
      await t.db
        .update(partnerLinks)
        .set({ status: 'active', acceptedAt: clock.now() })
        .where(eq(partnerLinks.ownerId, dani.userId));
      clock.advance(minutes(1));
      const replay = await postEvent(dani, {
        kind: 'study_abandoned',
        clientRef: queuedRef,
        occurredAt: T0,
      });
      expect(replay.status).toBe(200);
      expect(replay.json<PostAccountabilityEventResponse>()).toEqual(notStored);

      expect(await t.db.select().from(accountabilityEvents)).toEqual([]);
      expect(mailer.sent.filter((m) => m.to === 'eva@example.com')).toEqual([]);
      expect(
        (await call(eva, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);

      // Once someone listens, the next event is kept.
      const heard = await postEvent(dani, { kind: 'study_abandoned' });
      expect(heard.status).toBe(201);
      expect(heard.json<PostAccountabilityEventResponse>().eventId).toEqual(expect.any(String));
    });

    it('reads the app clock only relative to sentAt, fast or slow', async () => {
      // Both links were accepted at T0 (beforeEach). The owner's computer is 10 minutes off.
      for (const skew of [minutes(10), -minutes(10)]) {
        const onApp = (offsetMs = 0) => iso(skew + offsetMs);
        const res = await postEvent(ana, {
          occurredAt: onApp(),
          countdownEndsAt: onApp(minutes(10)),
          sentAt: onApp(),
        });
        expect(res.status).toBe(201);
        const { eventId, approval } = res.json<PostAccountabilityEventResponse>();
        // Ends 30 s before the real countdown, not 10 minutes after or before it.
        expect(approval?.deadline).toBe('2026-09-28T10:09:30.000Z');
        // Placed on the server's clock: a slow computer does not hide it behind acceptedAt.
        const owner = await call(ana, 'GET', `/v1/accountability/events/${eventId}`);
        expect(owner.json<AccountabilityEventResponse>().occurredAt).toBe(T0);
        const inbox = (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>();
        expect(inbox.items.map((i) => i.eventId)).toContain(eventId);
      }
      expect(mailer.sent.map((m) => m.text.split('\n')[1])).toEqual([
        expect.stringContaining('hasta las 12:09 '),
        expect.stringContaining('hasta las 12:09 '),
      ]);

      // Queued offline for 2 hours on a clock 3 hours fast, sent 3 hours after T0.
      clock.advance(minutes(180));
      const queued = await postEvent(ana, {
        kind: 'study_abandoned',
        occurredAt: iso(minutes(180 - 120)),
        sentAt: iso(minutes(180)),
      });
      expect(queued.status).toBe(201);
      const queuedId = queued.json<PostAccountabilityEventResponse>().eventId;
      const queuedRead = await call(ana, 'GET', `/v1/accountability/events/${queuedId}`);
      expect(queuedRead.json<AccountabilityEventResponse>().occurredAt).toBe(
        '2026-09-28T11:00:00.000Z',
      );
      // Six days before sending on a clock 10 hours fast: before the links, nobody hears.
      const beforeLinks = await postEvent(ana, {
        kind: 'study_abandoned',
        occurredAt: iso(minutes(600) - 6 * 86_400_000),
        sentAt: iso(minutes(600)),
      });
      expect(beforeLinks.status).toBe(200);
      expect(beforeLinks.json<PostAccountabilityEventResponse>().eventId).toBeNull();

      // The 7-day window is measured on the app's clock too.
      for (const body of [
        { occurredAt: iso(minutes(60) - 8 * 86_400_000), sentAt: iso(minutes(60)) },
        { occurredAt: iso(-minutes(60) + minutes(6)), sentAt: iso(-minutes(60)) },
      ]) {
        const res = await postEvent(ana, { kind: 'study_abandoned', ...body });
        expect(res.status).toBe(400);
        expect(errorCode(res.body)).toBe('validation_failed');
      }

      // A partner cannot answer once the real countdown is over, whatever the app's clock says.
      const fast = await postEvent(ana, {
        occurredAt: iso(minutes(10)),
        countdownEndsAt: iso(minutes(15)),
        sentAt: iso(minutes(10)),
      });
      const created = fast.json<PostAccountabilityEventResponse>();
      expect(created.approval?.deadline).toBe(iso(minutes(5) - 30_000));
      clock.advance(minutes(5) - 30_000);
      const tooLate = await call(
        bea,
        'POST',
        `/v1/accountability/events/${created.eventId}/decision`,
        { decision: 'deny', note: null },
      );
      expect(tooLate.status).toBe(409);
      expect(errorCode(tooLate.body)).toBe('deadline_passed');
    });

    it('hides events from anyone who is not a listening partner', async () => {
      const res = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const id = res.json<PostAccountabilityEventResponse>().eventId;
      const dani = await person({ displayName: 'Dani' });
      const decide = (who: TestUser, eventId = id) =>
        call(who, 'POST', `/v1/accountability/events/${eventId}/decision`, {
          decision: 'approve',
          note: null,
        });
      for (const who of [dani, ana]) expect((await decide(who)).status).toBe(404);
      expect((await decide(bea, randomUUID())).status).toBe(404);
      expect((await decide(bea, 'not-an-id')).status).toBe(404);
      expect((await call(bea, 'GET', `/v1/accountability/events/${id}`)).status).toBe(404);
      expect(
        (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);

      // A partner accepted after the event does not see it; a pending one sees nothing.
      await befriend(t.db, ana, dani);
      clock.advance(minutes(1));
      await linkPartners(t.db, ana, dani, { at: clock.now() });
      expect(
        (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);
      const eva = await person({ displayName: 'Eva' });
      await befriend(t.db, ana, eva);
      await t.db
        .insert(partnerLinks)
        .values({ ownerId: ana.userId, partnerId: eva.userId, status: 'pending' });
      await postEvent(ana, { kind: 'study_abandoned' });
      expect(
        (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toHaveLength(1);
      expect(
        (await call(eva, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);

      // An ending link still hears until its end; then the inbox empties.
      await call(ana, 'DELETE', `/v1/friends/${bea.userId}`);
      expect(
        (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toHaveLength(2);
      clock.advance(24 * 3_600_000);
      expect(
        (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);

      // After 30 days nothing is shown, even before the janitor runs.
      clock.advance(30 * 86_400_000);
      expect(
        (await call(dani, 'GET', '/v1/accountability/inbox')).json<InboxResponse>().items,
      ).toEqual([]);
      expect((await call(ana, 'GET', `/v1/accountability/events/${id}`)).status).toBe(404);
    });

    it('accepts only a kind and a time: no reasons, domains or tasks', async () => {
      const bad = [
        { occurredAt: iso(-8 * 86_400_000) },
        { occurredAt: iso(minutes(6)) },
        { occurredAt: 'yesterday' },
        { sentAt: 'now' },
        { sentAt: undefined },
        { clientRef: 'short' },
        { clientRef: 'x'.repeat(65) },
        { clientRef: 'has spaces in it 1234' },
        { kind: 'site_opened' },
        { countdownEndsAt: 'soon' },
        { reason: 'youtube.com' },
        { task: 'Estudiar mates' },
      ];
      for (const body of bad) {
        const res = await postEvent(ana, body);
        expect(res.status).toBe(400);
        expect(errorCode(res.body)).toBe('validation_failed');
      }
      // Valid, but from before the partners accepted: nothing is kept.
      const old = await postEvent(ana, {
        kind: 'punishment_started',
        occurredAt: iso(-86_400_000),
      });
      expect(old.status).toBe(200);
      expect((await postEvent(ana, { kind: 'punishment_started' })).status).toBe(201);

      const event = await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      const id = event.json<PostAccountabilityEventResponse>().eventId;
      const long = await call(bea, 'POST', `/v1/accountability/events/${id}/decision`, {
        decision: 'deny',
        note: 'x'.repeat(141),
      });
      expect(long.status).toBe(400);
      const control = await call(bea, 'POST', `/v1/accountability/events/${id}/decision`, {
        decision: 'deny',
        note: 'hola\u0007',
      });
      expect(control.status).toBe(400);
    });
  });

  describe('emails', () => {
    beforeEach(async () => {
      // Partners since three days ago, so events queued offline for a while still count.
      const at = new Date(clock.now().getTime() - 3 * 86_400_000);
      await befriend(t.db, ana, bea);
      await befriend(t.db, ana, carlos);
      await linkPartners(t.db, ana, bea, { requireApproval: true, at });
      await linkPartners(t.db, ana, carlos, { at });
    });

    it('sends minimal Spanish text in the partner’s zone, only to partners who asked', async () => {
      await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      expect(mailer.sent).toEqual([
        {
          to: 'bea@example.com',
          subject: 'Ana ha pedido el desbloqueo de emergencia',
          text: [
            'Ana ha pedido el desbloqueo de emergencia (12:00).',
            'Puedes aprobarlo o rechazarlo hasta las 12:09 en Céntrate o en ' +
              'http://localhost:3000/cuenta/avisos. Si no respondes, se aprueba solo.',
            '',
            'Recibes este correo porque eres compañero de responsabilidad de Ana en Céntrate y ' +
              'activaste los avisos por email. Puedes desactivarlos en tu cuenta, desde la app.',
          ].join('\n'),
          html: null,
          tag: 'partner_alert',
        },
      ]);

      mailer.sent.length = 0;
      await postEvent(ana, { kind: 'emergency_confirmed', occurredAt: iso(-minutes(90)) });
      await postEvent(ana, { kind: 'study_abandoned' });
      await postEvent(ana, { kind: 'emergency_cancelled' });
      await postEvent(ana, { kind: 'punishment_started' });
      await postEvent(ana, { kind: 'study_abandoned', occurredAt: iso(-2 * 86_400_000) }); // stale
      expect(mailer.sent.map((m) => m.text.split('\n')[0])).toEqual([
        'Ana ha usado el desbloqueo de emergencia (10:30).',
        'Ana ha abandonado una sesión de estudio (12:00).',
      ]);
      for (const m of mailer.sent) {
        expect(m.to).toBe('bea@example.com');
        expect(m.text).not.toMatch(/puntos|motivo|\.com\b|tarea/i);
      }
      // The inbox still lists every kind, stale ones included.
      const items = (await call(bea, 'GET', '/v1/accountability/inbox')).json<InboxResponse>()
        .items;
      expect(items).toHaveLength(6);
    });

    it('stops at 10 emails per partner per day and survives a failing mailer', async () => {
      for (let i = 0; i < 12; i += 1) {
        expect((await postEvent(ana, { kind: 'study_abandoned' })).status).toBe(201);
      }
      expect(mailer.sent).toHaveLength(10);
      const [counter] = await t.db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, bea.userId));
      expect(counter).toMatchObject({ day: '2026-09-28', key: 'partner_email', count: 10 });

      // The next UTC day starts a new allowance.
      clock.advance(86_400_000);
      await postEvent(ana, { kind: 'study_abandoned' });
      expect(mailer.sent).toHaveLength(11);

      await app.close();
      const failing: Mailer = { send: async () => Promise.reject(new Error('down')) };
      app = await buildTestApp({ db: t.db, clock, mailer: failing });
      call = caller(app);
      expect((await postEvent(ana, { kind: 'study_abandoned' })).status).toBe(201);
    });

    it('offers the approval only to partners who can answer it', async () => {
      await t.db
        .update(profiles)
        .set({ partnerEmails: true })
        .where(eq(profiles.userId, carlos.userId));
      await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      await vi.waitFor(() => expect(mailer.sent).toHaveLength(2));
      const byTo = new Map(mailer.sent.map((m) => [m.to, m.text]));
      expect(byTo.get('bea@example.com')).toContain('Puedes aprobarlo o rechazarlo');
      expect(byTo.get('carlos@example.com')).toContain('Ana ha pedido el desbloqueo');
      expect(byTo.get('carlos@example.com')).not.toContain('Puedes aprobarlo');
    });

    it('keeps partner emails under a global daily cap, leaving room for sign-in codes', async () => {
      await app.close();
      app = await buildTestApp({
        db: t.db,
        clock,
        mailer,
        config: testConfig({ PARTNER_EMAILS_PER_DAY_GLOBAL: '3' }),
      });
      call = caller(app);
      // Carlos is past his own 10 for today: that must not spend the global cap.
      await t.db
        .update(profiles)
        .set({ partnerEmails: true })
        .where(eq(profiles.userId, carlos.userId));
      await t.db
        .insert(usageCounters)
        .values({ userId: carlos.userId, day: '2026-09-28', key: 'partner_email', count: 10 });
      for (let i = 0; i < 5; i += 1) {
        expect((await postEvent(ana, { kind: 'study_abandoned' })).status).toBe(201);
      }
      await app.close(); // Waits for the emails sent in the background.
      expect(mailer.sent.map((m) => m.to)).toEqual([
        'bea@example.com',
        'bea@example.com',
        'bea@example.com',
      ]);
      const [global] = await t.db
        .select()
        .from(rateCounters)
        .where(eq(rateCounters.key, 'partner_email:global'));
      expect(global).toMatchObject({ count: 3 });
      // Past the global cap, a partner's own allowance is not used up either.
      const [beaCount] = await t.db
        .select()
        .from(usageCounters)
        .where(eq(usageCounters.userId, bea.userId));
      expect(beaCount?.count).toBe(3);

      // 0 turns partner emails off, and the capability says so.
      app = await buildTestApp({
        db: t.db,
        clock,
        mailer,
        config: testConfig({ PARTNER_EMAILS_PER_DAY_GLOBAL: '0' }),
      });
      call = caller(app);
      clock.advance(86_400_000);
      await postEvent(ana, { kind: 'study_abandoned' });
      await app.close();
      expect(mailer.sent).toHaveLength(3);
      app = await buildTestApp({ db: t.db, clock, mailer });
      call = caller(app);
      expect(
        deriveCapabilities(testConfig({ PARTNER_EMAILS_PER_DAY_GLOBAL: '0' })).partnerEmails,
      ).toEqual({ enabled: false, reason: 'budget' });
      expect(testConfig().email?.partnerEmailsPerDay).toBe(40);
      expect(() => testConfig({ PARTNER_EMAILS_PER_DAY_GLOBAL: 'many' })).toThrow(ConfigError);
    });

    it('sends one message at a time and retries once after a short 429', async () => {
      await t.db
        .update(profiles)
        .set({ partnerEmails: true })
        .where(eq(profiles.userId, carlos.userId));
      const attempts: string[] = [];
      const sent: string[] = [];
      let inFlight = 0;
      let overlapped = false;
      const busy: Mailer = {
        send: async (message) => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          attempts.push(message.to);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          // Resend's per-second limit refuses the second message once (no Retry-After: a
          // short default wait); later its daily quota runs out (a wait too long to retry).
          if (attempts.length === 2) throw new MailerError(429, null);
          if (attempts.length > 3) throw new MailerError(429, 3_600_000);
          sent.push(message.to);
        },
      };
      await app.close();
      app = await buildTestApp({ db: t.db, clock, mailer: busy });
      call = caller(app);
      // Two fan-outs back to back: they still go out one message at a time.
      await postEvent(ana, { countdownEndsAt: iso(minutes(10)) });
      await postEvent(ana, { kind: 'study_abandoned' });
      await app.close(); // Waits for the emails sent in the background.
      expect(overlapped).toBe(false);
      expect(attempts).toHaveLength(5);
      expect(attempts[2]).toBe(attempts[1]); // The refused message, retried once.
      expect(new Set(attempts.slice(0, 2))).toEqual(
        new Set(['bea@example.com', 'carlos@example.com']),
      );
      expect(sent).toEqual([attempts[0], attempts[1]]);
      app = await buildTestApp({ db: t.db, clock, mailer });
      call = caller(app);
    });

    it('reads Retry-After in seconds or as a date', () => {
      const now = Date.parse('2026-09-28T10:00:00.000Z');
      expect(parseRetryAfter('2', now)).toBe(2000);
      expect(parseRetryAfter('Mon, 28 Sep 2026 10:00:03 GMT', now)).toBe(3000);
      expect(parseRetryAfter('Mon, 28 Sep 2026 09:00:00 GMT', now)).toBe(0);
      expect(parseRetryAfter(null, now)).toBeNull();
      expect(parseRetryAfter('soon', now)).toBeNull();
    });

    it('hands Resend’s Retry-After to the caller on a 429', async () => {
      const limited = createResendMailer(testConfig().email, {
        fetch: (async () =>
          new Response('{}', { status: 429, headers: { 'retry-after': '1' } })) as typeof fetch,
      });
      const message = composeLinkProposal('Ana', 'bea@example.com');
      await expect(limited?.send(message)).rejects.toMatchObject({
        status: 429,
        retryAfterMs: 1000,
      });
    });

    it('sends nothing when email is not configured', async () => {
      await app.close();
      app = await buildTestApp({ db: t.db, clock, mailer: null });
      call = caller(app);
      expect((await postEvent(ana, { countdownEndsAt: iso(minutes(10)) })).status).toBe(201);
      expect(await t.db.select().from(usageCounters)).toEqual([]);
    });
  });
});
