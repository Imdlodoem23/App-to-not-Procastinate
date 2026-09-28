import type {
  AcceptInviteResponse,
  BlocksResponse,
  CreateInviteResponse,
  FriendsResponse,
  InvitesResponse,
} from '@centrate/shared/cloud-api';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  friendInvites,
  friendships,
  partnerLinks,
  profiles,
  user,
  userBlocks,
} from '../src/db/schema';
import {
  formatInviteCode,
  generateInviteCode,
  hashInviteCode,
  normalizeInviteCode,
} from '../src/social/codes';
import { buildTestApp, createTestUser, fakeClock, type FakeClock } from './helpers/app';
import type { TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { befriend, caller, linkPartners, type Caller } from './helpers/social';

const NOT_FOUND = { error: { code: 'not_found', message: 'Not found' } };

describe('invite codes', () => {
  it('generates 10 Crockford characters and normalizes what people type', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
      expect(normalizeInviteCode(formatInviteCode(code))).toBe(code);
    }
    expect(formatInviteCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(normalizeInviteCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeInviteCode(' ab cde-fg hjk ')).toBe('ABCDEFGHJK');
    expect(normalizeInviteCode('oOiIl-12345')).toBe('0011112345');
    expect(normalizeInviteCode('ABCDE-FGHJU')).toBeNull(); // U is not Crockford
    expect(normalizeInviteCode('ABCDE-FGHJ')).toBeNull();
    expect(normalizeInviteCode('A'.repeat(40))).toBeNull();
    expect(hashInviteCode('ABCDEFGHJK')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('friends', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let call: Caller;
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
    clock = fakeClock();
    app = await buildTestApp({ db: t.db, clock });
    call = caller(app);
    const now = clock.now();
    ana = await createTestUser(t.db, { displayName: 'Ana', now });
    bea = await createTestUser(t.db, { displayName: 'Bea', now });
    carlos = await createTestUser(t.db, { displayName: 'Carlos', now });
  });
  afterEach(async () => {
    // Other people are only ever `{ userId, displayName }`: never an email.
    expect(call.bodies.join('\n')).not.toContain('@');
    await app.close();
  });

  async function invite(by: TestUser, maxUses?: number): Promise<CreateInviteResponse> {
    const res = await call(by, 'POST', '/v1/friends/invites', maxUses ? { maxUses } : {});
    expect(res.status).toBe(201);
    return res.json<CreateInviteResponse>();
  }

  it('creates, previews and accepts an invite; the code is stored only as a hash', async () => {
    const created = await invite(ana);
    expect(created.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(created.url).toBe(`http://localhost:3000/i/${created.code}`);
    expect(created.maxUses).toBe(1);
    expect(created.expiresAt).toBe('2026-10-05T10:00:00.000Z');

    const rows = await t.db.select().from(friendInvites);
    expect(rows).toHaveLength(1);
    const code = normalizeInviteCode(created.code) ?? '';
    expect(rows[0]?.codeHash).toBe(hashInviteCode(code));
    expect(JSON.stringify(rows)).not.toContain(code);

    const listed = await call(ana, 'GET', '/v1/friends/invites');
    expect(listed.json<InvitesResponse>().invites).toEqual([
      {
        id: created.id,
        createdAt: '2026-09-28T10:00:00.000Z',
        expiresAt: created.expiresAt,
        maxUses: 1,
        uses: 0,
      },
    ]);
    expect(listed.raw).not.toContain(code.slice(0, 5));

    // Typed by hand: lower case, no dash.
    const preview = await call(bea, 'GET', `/v1/friends/invites/${code.toLowerCase()}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({ inviter: { displayName: 'Ana' } });

    clock.advance(60_000);
    const accepted = await call(bea, 'POST', `/v1/friends/invites/${created.code}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.json<AcceptInviteResponse>()).toEqual({
      friend: { userId: ana.userId, displayName: 'Ana', since: '2026-09-28T10:01:00.000Z' },
    });

    const anaFriends = await call(ana, 'GET', '/v1/friends');
    expect(anaFriends.json<FriendsResponse>().friends).toEqual([
      { userId: bea.userId, displayName: 'Bea', since: '2026-09-28T10:01:00.000Z' },
    ]);
    const beaFriends = await call(bea, 'GET', '/v1/friends');
    expect(beaFriends.json<FriendsResponse>().friends.map((f) => f.userId)).toEqual([ana.userId]);

    // Used up: gone from the list, and nobody else can use it.
    expect((await call(ana, 'GET', '/v1/friends/invites')).json<InvitesResponse>().invites).toEqual(
      [],
    );
    expect((await call(carlos, 'GET', `/v1/friends/invites/${created.code}`)).body).toEqual(
      NOT_FOUND,
    );
    // A retry by the new friend (lost response) is still a 200, and consumes nothing.
    const retry = await call(bea, 'POST', `/v1/friends/invites/${created.code}/accept`);
    expect(retry.status).toBe(200);
    expect(retry.json<AcceptInviteResponse>().friend.since).toBe('2026-09-28T10:01:00.000Z');
    const [stored] = await t.db.select().from(friendInvites);
    expect(stored?.uses).toBe(1);
  });

  it('answers the same 404 for unknown, malformed, expired, used up, own and blocked codes', async () => {
    const results: unknown[] = [];
    const both = async (who: TestUser, code: string) => {
      results.push((await call(who, 'GET', `/v1/friends/invites/${code}`)).body);
      results.push((await call(who, 'POST', `/v1/friends/invites/${code}/accept`)).body);
    };

    await both(bea, formatInviteCode(generateInviteCode())); // unknown
    await both(bea, 'not-a-code!');
    const own = await invite(ana);
    await both(ana, own.code);

    const used = await invite(ana);
    expect((await call(bea, 'POST', `/v1/friends/invites/${used.code}/accept`)).status).toBe(200);
    await both(carlos, used.code);

    // Blocked either way.
    const fromCarlos = await invite(carlos, 5);
    await t.db.insert(userBlocks).values({ blockerId: carlos.userId, blockedId: bea.userId });
    await both(bea, fromCarlos.code);
    const fromBea = await invite(bea, 5);
    await both(carlos, fromBea.code);

    const expiring = await invite(ana, 3);
    clock.advance(7 * 86_400_000);
    await both(carlos, expiring.code);

    expect(results).toHaveLength(14);
    for (const body of results) expect(body).toEqual(NOT_FOUND);
    expect(
      await t.db.select().from(friendships).where(eq(friendships.userId, carlos.userId)),
    ).toEqual([]);
  });

  it('honours maxUses and gives the last use to exactly one person', async () => {
    const two = await invite(ana, 2);
    expect(two.maxUses).toBe(2);
    expect((await call(bea, 'POST', `/v1/friends/invites/${two.code}/accept`)).status).toBe(200);
    expect((await call(carlos, 'POST', `/v1/friends/invites/${two.code}/accept`)).status).toBe(200);
    const dani = await createTestUser(t.db, { displayName: 'Dani', now: clock.now() });
    expect((await call(dani, 'POST', `/v1/friends/invites/${two.code}/accept`)).status).toBe(404);

    const one = await invite(dani);
    const eva = await createTestUser(t.db, { displayName: 'Eva', now: clock.now() });
    const fede = await createTestUser(t.db, { displayName: 'Fede', now: clock.now() });
    const results = await Promise.all([
      call(eva, 'POST', `/v1/friends/invites/${one.code}/accept`),
      call(fede, 'POST', `/v1/friends/invites/${one.code}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const daniFriends = await t.db
      .select()
      .from(friendships)
      .where(eq(friendships.userId, dani.userId));
    expect(daniFriends).toHaveLength(1);
  });

  it('validates input, needs display names and limits active invites', async () => {
    for (const payload of [{ maxUses: 0 }, { maxUses: 11 }, { maxUses: 1.5 }, { extra: true }]) {
      const res = await call(bea, 'POST', '/v1/friends/invites', payload);
      expect(res.status).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_failed');
    }

    const nameless = await createTestUser(t.db, { displayName: null, now: clock.now() });
    const noName = await call(nameless, 'POST', '/v1/friends/invites', {});
    expect(noName.status).toBe(409);
    expect(noName.json<{ error: { code: string } }>().error.code).toBe('profile_incomplete');
    const code = (await invite(ana)).code;
    const acceptNoName = await call(nameless, 'POST', `/v1/friends/invites/${code}/accept`);
    expect(acceptNoName.json<{ error: { code: string } }>().error.code).toBe('profile_incomplete');

    const ids = [(await call(ana, 'GET', '/v1/friends/invites')).json<InvitesResponse>()];
    expect(ids[0]?.invites).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) await invite(ana);
    const sixth = await call(ana, 'POST', '/v1/friends/invites', {});
    expect(sixth.status).toBe(409);
    expect(sixth.json<{ error: { code: string } }>().error.code).toBe('limit_reached');

    // Deleting one frees a slot; someone else's invite or an unknown id is a 404.
    const list = (await call(ana, 'GET', '/v1/friends/invites')).json<InvitesResponse>().invites;
    const target = list[0]?.id ?? '';
    expect((await call(bea, 'DELETE', `/v1/friends/invites/${target}`)).status).toBe(404);
    expect((await call(ana, 'DELETE', `/v1/friends/invites/${randomUUID()}`)).status).toBe(404);
    expect((await call(ana, 'DELETE', '/v1/friends/invites/nope')).status).toBe(404);
    expect((await call(ana, 'DELETE', `/v1/friends/invites/${target}`)).status).toBe(204);
    expect((await call(ana, 'POST', '/v1/friends/invites', {})).status).toBe(201);
  });

  it('stops at 100 friends on either side without consuming the invite', async () => {
    const ids = Array.from({ length: 100 }, () => randomUUID());
    await t.db
      .insert(user)
      .values(ids.map((id) => ({ id, name: '', email: `${id}@example.com`, emailVerified: true })));
    await t.db.insert(profiles).values(ids.map((id) => ({ userId: id, displayName: 'X' })));
    await t.db.insert(friendships).values(
      ids.flatMap((id) => [
        { userId: ana.userId, friendId: id },
        { userId: id, friendId: ana.userId },
      ]),
    );
    const created = await invite(ana);
    const res = await call(bea, 'POST', `/v1/friends/invites/${created.code}/accept`);
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('limit_reached');
    const [row] = await t.db.select().from(friendInvites);
    expect(row?.uses).toBe(0);
  });

  it('removes a friend on both sides; an owner cannot skip the partner cooling-off', async () => {
    const now = clock.now();
    await befriend(t.db, ana, bea, now);
    const anaOwns = await linkPartners(t.db, ana, bea, { requireApproval: true, at: now });
    const beaOwns = await linkPartners(t.db, bea, ana, { at: now });
    await befriend(t.db, ana, carlos, now);
    const [pending] = await t.db
      .insert(partnerLinks)
      .values({ ownerId: ana.userId, partnerId: carlos.userId, status: 'pending' })
      .returning();

    expect((await call(ana, 'DELETE', `/v1/friends/${bea.userId}`)).status).toBe(204);
    expect((await call(ana, 'DELETE', `/v1/friends/${bea.userId}`)).status).toBe(204);
    expect((await call(bea, 'GET', '/v1/friends')).json<FriendsResponse>().friends).toEqual([]);
    expect(
      (await call(ana, 'GET', '/v1/friends')).json<FriendsResponse>().friends.map((f) => f.userId),
    ).toEqual([carlos.userId]);

    const links = await t.db.select().from(partnerLinks);
    const byId = new Map(links.map((l) => [l.id, l]));
    // Ana held herself accountable to Bea: that link still works for 24 hours.
    expect(byId.get(anaOwns)?.endsAt?.toISOString()).toBe('2026-09-29T10:00:00.000Z');
    // Ana was Bea's partner: a partner may leave at once.
    expect(byId.has(beaOwns)).toBe(false);
    expect(byId.has(pending?.id ?? '')).toBe(true);

    expect((await call(ana, 'DELETE', `/v1/friends/${carlos.userId}`)).status).toBe(204);
    expect(
      await t.db
        .select()
        .from(partnerLinks)
        .where(eq(partnerLinks.id, pending?.id ?? '')),
    ).toEqual([]);
    expect((await call(ana, 'DELETE', '/v1/friends/bad%20id')).status).toBe(404);
  });

  it('blocks hide both people, stop invites and follow the cooling-off rule', async () => {
    const now = clock.now();
    await befriend(t.db, ana, bea, now);
    const beaOwns = await linkPartners(t.db, bea, ana, { at: now });
    const pendingInvite = await invite(ana, 5);

    // Bea blocks Ana: the friendship ends, Bea's own link cools off for 24 hours.
    expect((await call(bea, 'POST', '/v1/blocks', { userId: ana.userId })).status).toBe(204);
    expect((await call(bea, 'POST', '/v1/blocks', { userId: ana.userId })).status).toBe(204);
    expect((await call(ana, 'GET', '/v1/friends')).json<FriendsResponse>().friends).toEqual([]);
    const [link] = await t.db.select().from(partnerLinks).where(eq(partnerLinks.id, beaOwns));
    expect(link?.endsAt?.toISOString()).toBe('2026-09-29T10:00:00.000Z');
    expect((await call(bea, 'GET', `/v1/friends/invites/${pendingInvite.code}`)).body).toEqual(
      NOT_FOUND,
    );

    const blocks = await call(bea, 'GET', '/v1/blocks');
    expect(blocks.json<BlocksResponse>()).toEqual({
      blocks: [{ userId: ana.userId, displayName: 'Ana', createdAt: '2026-09-28T10:00:00.000Z' }],
    });
    // Ana does not see who blocked her.
    expect((await call(ana, 'GET', '/v1/blocks')).json<BlocksResponse>().blocks).toEqual([]);

    // Unknown ids are a silent 204; blocking yourself is a 400.
    expect((await call(bea, 'POST', '/v1/blocks', { userId: 'no-such-user' })).status).toBe(204);
    expect((await call(bea, 'POST', '/v1/blocks', { userId: bea.userId })).status).toBe(400);
    expect((await call(bea, 'POST', '/v1/blocks', { userId: 'x@y' })).status).toBe(400);
    expect(await t.db.select().from(userBlocks)).toHaveLength(1);

    // Unblocking does not restore the friendship.
    expect((await call(bea, 'DELETE', `/v1/blocks/${ana.userId}`)).status).toBe(204);
    expect(
      await t.db
        .select()
        .from(userBlocks)
        .where(and(eq(userBlocks.blockerId, bea.userId), eq(userBlocks.blockedId, ana.userId))),
    ).toEqual([]);
    expect((await call(bea, 'GET', '/v1/friends')).json<FriendsResponse>().friends).toEqual([]);
    // After unblocking, invites work again.
    expect((await call(bea, 'GET', `/v1/friends/invites/${pendingInvite.code}`)).status).toBe(200);
  });

  it('needs a session', async () => {
    expect((await call(null, 'GET', '/v1/friends')).status).toBe(401);
    expect((await call(null, 'POST', '/v1/friends/invites', {})).status).toBe(401);
  });
});
