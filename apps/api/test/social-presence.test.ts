import type { FriendsPresenceResponse } from '@centrate/shared/cloud-api';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { presence, userBlocks } from '../src/db/schema';
import {
  buildTestApp,
  createTestUser,
  fakeClock,
  type CreateUserOptions,
  type FakeClock,
  type TestUser,
} from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { befriend, caller, type Caller } from './helpers/social';

const sharing = { presence: true };

describe('«estudiando ahora»', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let call: Caller;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    clock = fakeClock('2026-09-28T10:00:00.000Z');
    app = await buildTestApp({ db: t.db, clock });
    call = caller(app);
  });
  afterEach(async () => {
    expect(call.bodies.join('\n')).not.toContain('@');
    await app.close();
  });

  const person = (options: CreateUserOptions): Promise<TestUser> =>
    createTestUser(t.db, { now: clock.now(), ...options });
  const watch = async (who: TestUser) =>
    (await call(who, 'GET', '/v1/friends/presence')).json<FriendsPresenceResponse>().friends;

  it('keeps `since` while the state holds and forgets a silent user after 180 s', async () => {
    const ana = await person({ displayName: 'Ana', sharing });
    const bea = await person({ displayName: 'Bea', sharing });
    await befriend(t.db, ana, bea);

    const put = await call(ana, 'PUT', '/v1/presence', {
      state: 'focus',
      endsAt: '2026-09-28T10:50:00.000Z',
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ expiresAt: '2026-09-28T10:03:00.000Z' });
    expect(await watch(bea)).toEqual([
      {
        userId: ana.userId,
        displayName: 'Ana',
        state: 'focus',
        since: '2026-09-28T10:00:00.000Z',
        endsAt: '2026-09-28T10:50:00.000Z',
      },
    ]);

    clock.advance(60_000);
    await call(ana, 'PUT', '/v1/presence', { state: 'focus', endsAt: null });
    expect(await watch(bea)).toMatchObject([{ since: '2026-09-28T10:00:00.000Z', endsAt: null }]);

    clock.advance(60_000);
    await call(ana, 'PUT', '/v1/presence', { state: 'study', endsAt: null });
    expect(await watch(bea)).toMatchObject([{ state: 'study', since: '2026-09-28T10:02:00.000Z' }]);

    // No heartbeat for 181 s (the app crashed): gone, without waiting for the janitor.
    clock.advance(181_000);
    expect(await watch(bea)).toEqual([]);
    // A heartbeat on a dead row starts over, even with the same state.
    await call(ana, 'PUT', '/v1/presence', { state: 'study', endsAt: null });
    expect(await watch(bea)).toMatchObject([{ since: '2026-09-28T10:05:01.000Z' }]);

    expect((await call(ana, 'DELETE', '/v1/presence')).status).toBe(204);
    expect(await watch(bea)).toEqual([]);
    expect(await t.db.select().from(presence)).toEqual([]);
  });

  it('shows only friends who share, only to people who share, never across a block', async () => {
    const ana = await person({ displayName: 'Ana', sharing });
    const quiet = await person({ displayName: 'Carlos' });
    const bea = await person({ displayName: 'Bea', sharing });
    const dani = await person({ displayName: 'Dani', sharing });
    const stranger = await person({ displayName: 'Eva', sharing });
    for (const friend of [quiet, bea, dani]) await befriend(t.db, ana, friend);
    await t.db.insert(userBlocks).values({ blockerId: ana.userId, blockedId: dani.userId });

    for (const who of [bea, dani, stranger]) {
      expect(
        (await call(who, 'PUT', '/v1/presence', { state: 'focus', endsAt: null })).status,
      ).toBe(200);
    }
    // A row left behind by someone who no longer shares is never shown.
    const expiresAt = new Date(clock.now().getTime() + 180_000);
    await t.db
      .insert(presence)
      .values({ userId: quiet.userId, state: 'study', since: clock.now(), expiresAt });

    expect((await watch(ana)).map((f) => f.displayName)).toEqual(['Bea']);
    // Dani blocked by Ana cannot see Ana either.
    await call(ana, 'PUT', '/v1/presence', { state: 'focus', endsAt: null });
    expect(await watch(dani)).toEqual([]);
    expect((await watch(bea)).map((f) => f.displayName)).toEqual(['Ana']);

    // Reciprocity: without the switch, neither sending nor reading.
    const res = await call(quiet, 'GET', '/v1/friends/presence');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'consent_required', consent: 'presence' } });
    const put = await call(quiet, 'PUT', '/v1/presence', { state: 'focus', endsAt: null });
    expect(put.status).toBe(403);
    // Stopping is always allowed.
    expect((await call(quiet, 'DELETE', '/v1/presence')).status).toBe(204);
  });

  it('validates the heartbeat and limits its rate', async () => {
    for (const body of [
      { state: 'focus', endsAt: '2026-09-28T09:59:59.000Z' },
      { state: 'focus', endsAt: '2026-09-28T10:00:00.000Z' },
      { state: 'focus', endsAt: '2026-09-29T10:00:01.000Z' },
      { state: 'sleep', endsAt: null },
      { state: 'focus' },
      { state: 'focus', endsAt: null, task: 'Mates' },
    ]) {
      // A fresh person each time: the heartbeat allows 4 per minute.
      const someone = await person({ displayName: 'Ana', sharing });
      const res = await call(someone, 'PUT', '/v1/presence', body);
      expect(res.status).toBe(400);
    }
    const bea = await person({ displayName: 'Bea', sharing });
    const ok = { state: 'focus', endsAt: '2026-09-29T10:00:00.000Z' };
    for (let i = 0; i < 4; i += 1) {
      expect((await call(bea, 'PUT', '/v1/presence', ok)).status).toBe(200);
    }
    const limited = await app.inject({
      method: 'PUT',
      url: '/v1/presence',
      headers: bea.headers,
      payload: ok,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
