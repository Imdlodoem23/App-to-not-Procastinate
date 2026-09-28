import type { RankingResponse } from '@centrate/shared/cloud-api';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userBlocks } from '../src/db/schema';
import { rankEntries } from '../src/routes/ranking';
import {
  buildTestApp,
  createTestUser,
  fakeClock,
  type CreateUserOptions,
  type FakeClock,
  type TestUser,
} from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { addDay, addDevice, befriend, caller, type Caller } from './helpers/social';

const sharing = { syncStats: true, ranking: true };

describe('rankEntries', () => {
  it('uses competition ranking on minutes and active days (1, 2, 2, 4)', () => {
    const e = (userId: string, displayName: string, focusMinutes: number, activeDays: number) => ({
      userId,
      displayName,
      focusMinutes,
      studyMinutes: 0,
      activeDays,
      goalDays: 0,
      isMe: false,
    });
    const ranked = rankEntries([
      e('d', 'Dani', 10, 1),
      e('b', 'Bea', 100, 2),
      e('a', 'Ana', 300, 3),
      e('c', 'Álvaro', 100, 2),
      e('x', 'Zoe', 100, 1),
    ]);
    expect(ranked.map((r) => [r.displayName, r.rank])).toEqual([
      ['Ana', 1],
      ['Álvaro', 2], // Spanish collation: «Á» sorts with «A»
      ['Bea', 2],
      ['Zoe', 4], // same minutes, fewer active days
      ['Dani', 5],
    ]);
  });
});

describe('weekly ranking', () => {
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
    clock = fakeClock('2026-09-28T10:00:00.000Z'); // Monday of 2026-W40
    app = await buildTestApp({ db: t.db, clock });
    call = caller(app);
  });
  afterEach(async () => {
    expect(call.bodies.join('\n')).not.toContain('@');
    await app.close();
  });

  const person = (options: CreateUserOptions): Promise<TestUser> =>
    createTestUser(t.db, { now: clock.now(), ...options });

  it('ranks the caller and friends who share, with daily caps and goals', async () => {
    const ana = await person({ displayName: 'Ana', sharing, dailyGoalMinutes: 60 });
    const bea = await person({ displayName: 'Bea', sharing, dailyGoalMinutes: 30 });
    const fede = await person({ displayName: 'Fede', sharing });
    const gael = await person({ displayName: 'Gael', sharing, timeZone: 'America/New_York' });
    const hidden = await person({ displayName: 'Carlos', sharing: { syncStats: true } });
    const blocked = await person({ displayName: 'Dani', sharing });
    const stranger = await person({ displayName: 'Eva', sharing });
    for (const friend of [bea, fede, gael, hidden, blocked]) await befriend(t.db, ana, friend);
    await t.db.insert(userBlocks).values({ blockerId: blocked.userId, blockedId: ana.userId });

    const anaPc = await addDevice(t.db, ana);
    const anaLaptop = await addDevice(t.db, ana);
    // Two devices on one day: 1500 minutes are capped at 1440; study is capped at focus.
    await addDay(t.db, ana, anaPc, '2026-09-28', { focusMinutes: 100, studyMinutes: 50 });
    await addDay(t.db, ana, anaLaptop, '2026-09-28', { focusMinutes: 1400, studyMinutes: 1400 });
    await addDay(t.db, ana, anaPc, '2026-10-04', { focusMinutes: 60, studyMinutes: 0 });
    await addDay(t.db, ana, anaPc, '2026-09-27', { focusMinutes: 500 }); // previous week
    await addDay(t.db, ana, anaPc, '2026-10-05', { focusMinutes: 500 }); // next week

    const beaPc = await addDevice(t.db, bea);
    await addDay(t.db, bea, beaPc, '2026-09-29', { focusMinutes: 20, studyMinutes: 10 });
    await addDay(t.db, bea, beaPc, '2026-09-30', { focusMinutes: 980, studyMinutes: 30 });
    const fedePc = await addDevice(t.db, fede);
    await addDay(t.db, fede, fedePc, '2026-10-01', { focusMinutes: 500 });
    await addDay(t.db, fede, fedePc, '2026-10-02', { focusMinutes: 500, pointsEarned: 90 });
    await addDay(t.db, fede, fedePc, '2026-10-03', { focusMinutes: 0 });
    for (const other of [hidden, blocked, stranger]) {
      const pc = await addDevice(t.db, other);
      await addDay(t.db, other, pc, '2026-09-29', { focusMinutes: 900 });
    }

    const res = await call(ana, 'GET', '/v1/ranking');
    expect(res.status).toBe(200);
    const body = res.json<RankingResponse>();
    expect(body).toMatchObject({ week: '2026-W40', from: '2026-09-28', to: '2026-10-04' });
    expect(body.entries).toEqual([
      {
        userId: ana.userId,
        displayName: 'Ana',
        rank: 1,
        focusMinutes: 1500,
        studyMinutes: 1440,
        activeDays: 2,
        goalDays: 2,
        isMe: true,
      },
      {
        userId: bea.userId,
        displayName: 'Bea',
        rank: 2,
        focusMinutes: 1000,
        studyMinutes: 40,
        activeDays: 2,
        goalDays: 1,
        isMe: false,
      },
      {
        userId: fede.userId,
        displayName: 'Fede',
        rank: 2,
        focusMinutes: 1000,
        studyMinutes: 0,
        activeDays: 2,
        goalDays: 0, // no goal set
        isMe: false,
      },
      {
        userId: gael.userId,
        displayName: 'Gael',
        rank: 4,
        focusMinutes: 0,
        studyMinutes: 0,
        activeDays: 0,
        goalDays: 0,
        isMe: false,
      },
    ]);
    // Points are never shared.
    expect(res.raw).not.toContain('points');
  });

  it('needs the ranking switch (reciprocity) and a display name', async () => {
    const off = await person({ displayName: 'Ana', sharing: { syncStats: true } });
    const res = await call(off, 'GET', '/v1/ranking');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'consent_required', consent: 'ranking' } });

    const nameless = await person({ displayName: null, sharing });
    const res2 = await call(nameless, 'GET', '/v1/ranking');
    expect(res2.status).toBe(409);
    expect(res2.body).toMatchObject({ error: { code: 'profile_incomplete' } });
  });

  it('defaults to the current ISO week in the caller’s own time zone', async () => {
    // Sunday 2026-10-04 22:30 UTC: already Monday (W41) in Madrid, still Sunday (W40) in New York.
    clock.set('2026-10-04T22:30:00.000Z');
    const madrid = await person({ displayName: 'Ana', sharing, timeZone: 'Europe/Madrid' });
    const newYork = await person({ displayName: 'Bea', sharing, timeZone: 'America/New_York' });
    expect((await call(madrid, 'GET', '/v1/ranking')).json<RankingResponse>().week).toBe(
      '2026-W41',
    );
    expect((await call(newYork, 'GET', '/v1/ranking')).json<RankingResponse>().week).toBe(
      '2026-W40',
    );

    // A day is each person's own civil date: Sunday 23:59 in New York counts on Sunday.
    await befriend(t.db, madrid, newYork);
    const pc = await addDevice(t.db, newYork);
    await addDay(t.db, newYork, pc, '2026-10-04', { focusMinutes: 45 });
    const w40 = (await call(madrid, 'GET', '/v1/ranking?week=2026-W40')).json<RankingResponse>();
    expect(w40.entries.find((e) => e.userId === newYork.userId)?.focusMinutes).toBe(45);
    const w41 = (await call(madrid, 'GET', '/v1/ranking')).json<RankingResponse>();
    expect(w41.entries.find((e) => e.userId === newYork.userId)?.focusMinutes).toBe(0);
  });

  it('handles 53-week years and rejects weeks that do not exist', async () => {
    const ana = await person({ displayName: 'Ana', sharing });
    const pc = await addDevice(t.db, ana);
    await addDay(t.db, ana, pc, '2026-12-27', { focusMinutes: 1 });
    await addDay(t.db, ana, pc, '2026-12-28', { focusMinutes: 10 });
    await addDay(t.db, ana, pc, '2027-01-03', { focusMinutes: 20 });
    await addDay(t.db, ana, pc, '2027-01-04', { focusMinutes: 300 });
    const res = await call(ana, 'GET', '/v1/ranking?week=2026-W53');
    expect(res.status).toBe(200);
    const body = res.json<RankingResponse>();
    expect(body).toMatchObject({ week: '2026-W53', from: '2026-12-28', to: '2027-01-03' });
    expect(body.entries[0]).toMatchObject({ focusMinutes: 30, activeDays: 2 });

    for (const week of ['2027-W53', '2026-W00', '2026-40', '0050-W01', '2026-W1']) {
      const bad = await call(ana, 'GET', `/v1/ranking?week=${week}`);
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ error: { code: 'validation_failed' } });
    }
  });
});
