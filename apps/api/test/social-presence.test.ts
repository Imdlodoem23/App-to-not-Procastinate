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
  /** A heartbeat; `sentAt` is the app's clock (by default the same as the server's). */
  const beat = (
    who: TestUser,
    state: string,
    endsAt: string | null = null,
    sentAt = clock.now().toISOString(),
  ) => call(who, 'PUT', '/v1/presence', { state, endsAt, sentAt });

  it('keeps `since` while the state holds and forgets a silent user after 180 s', async () => {
    const ana = await person({ displayName: 'Ana', sharing });
    const bea = await person({ displayName: 'Bea', sharing });
    await befriend(t.db, ana, bea);

    const put = await beat(ana, 'focus', '2026-09-28T10:50:00.000Z');
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ expiresAt: '2026-09-28T10:03:00.000Z' });
    expect(await watch(bea)).toEqual([
      {
        userId: ana.userId,
        displayName: 'Ana',
        state: 'focus',
        since: '2026-09-28T10:00:00.000Z',
        endsAt: '2026-09-28T10:50:00.000Z',
        endsInSeconds: 3000,
      },
    ]);
    clock.advance(30_000);
    expect(await watch(bea)).toMatchObject([{ endsInSeconds: 2970 }]);

    clock.advance(30_000);
    await beat(ana, 'focus');
    expect(await watch(bea)).toMatchObject([
      { since: '2026-09-28T10:00:00.000Z', endsAt: null, endsInSeconds: null },
    ]);

    clock.advance(60_000);
    await beat(ana, 'study');
    expect(await watch(bea)).toMatchObject([{ state: 'study', since: '2026-09-28T10:02:00.000Z' }]);

    // No heartbeat for 181 s (the app crashed): gone, without waiting for the janitor.
    clock.advance(181_000);
    expect(await watch(bea)).toEqual([]);
    // A heartbeat on a dead row starts over, even with the same state.
    await beat(ana, 'study');
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
      expect((await beat(who, 'focus')).status).toBe(200);
    }
    // A row left behind by someone who no longer shares is never shown.
    const expiresAt = new Date(clock.now().getTime() + 180_000);
    await t.db
      .insert(presence)
      .values({ userId: quiet.userId, state: 'study', since: clock.now(), expiresAt });

    expect((await watch(ana)).map((f) => f.displayName)).toEqual(['Bea']);
    // Dani blocked by Ana cannot see Ana either.
    await beat(ana, 'focus');
    expect(await watch(dani)).toEqual([]);
    expect((await watch(bea)).map((f) => f.displayName)).toEqual(['Ana']);

    // Reciprocity: without the switch, neither sending nor reading.
    const res = await call(quiet, 'GET', '/v1/friends/presence');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'consent_required', consent: 'presence' } });
    const put = await beat(quiet, 'focus');
    expect(put.status).toBe(403);
    // Stopping is always allowed.
    expect((await call(quiet, 'DELETE', '/v1/presence')).status).toBe(204);
  });

  it('reads the app clock only relative to sentAt, fast or slow', async () => {
    const ana = await person({ displayName: 'Ana', sharing });
    const bea = await person({ displayName: 'Bea', sharing });
    await befriend(t.db, ana, bea);
    const at = (offsetMs: number) => new Date(clock.now().getTime() + offsetMs).toISOString();
    const hour = 3_600_000;

    // A computer 2 hours slow or fast, 5 minutes left: friends see 10:05 on the server's clock.
    for (const skew of [-2 * hour, 2 * hour]) {
      const res = await beat(ana, 'focus', at(skew + 300_000), at(skew));
      expect(res.status).toBe(200);
      expect(await watch(bea)).toMatchObject([
        { endsAt: '2026-09-28T10:05:00.000Z', endsInSeconds: 300 },
      ]);
    }
    // The first heartbeat of a 24-hour block on a clock a little fast is not refused.
    expect((await beat(ana, 'focus', at(60_000 + 24 * hour), at(60_000))).status).toBe(200);
    expect(await watch(bea)).toMatchObject([{ endsAt: '2026-09-29T10:00:00.000Z' }]);
    // More than 24 hours left (a clock stepped back during the block) is clamped, not refused.
    expect((await beat(ana, 'focus', at(30 * hour), at(0))).status).toBe(200);
    expect(await watch(bea)).toMatchObject([
      { endsAt: '2026-09-29T10:00:00.000Z', endsInSeconds: 24 * 3600 },
    ]);
  });

  it('validates the heartbeat and limits its rate', async () => {
    const sentAt = '2026-09-28T10:00:00.000Z';
    for (const body of [
      { state: 'focus', endsAt: '2026-09-28T09:59:59.000Z', sentAt },
      { state: 'focus', endsAt: sentAt, sentAt },
      { state: 'focus', endsAt: null },
      { state: 'focus', endsAt: null, sentAt: 'now' },
      { state: 'focus', endsAt: 'soon', sentAt },
      { state: 'sleep', endsAt: null, sentAt },
      { state: 'focus', sentAt },
      { state: 'focus', endsAt: null, sentAt, task: 'Mates' },
    ]) {
      // A fresh person each time: the heartbeat allows 4 per minute.
      const someone = await person({ displayName: 'Ana', sharing });
      const res = await call(someone, 'PUT', '/v1/presence', body);
      expect(res.status).toBe(400);
    }
    const bea = await person({ displayName: 'Bea', sharing });
    const ok = { state: 'focus', endsAt: '2026-09-29T10:00:00.000Z', sentAt };
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
