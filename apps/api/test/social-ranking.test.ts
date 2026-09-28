import type { MeResponse, RankingResponse } from '@centrate/shared/cloud-api';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userBlocks } from '../src/db/schema';
import { firstSharedDay, rankEntries } from '../src/routes/ranking';
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

describe('firstSharedDay', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  it('takes the latest start, as a civil day in the friend’s zone', () => {
    const friends = new Date('2026-09-27T23:30:00.000Z'); // Monday in Madrid, Sunday in New York
    const long = new Date('2026-01-01T00:00:00.000Z');
    expect(firstSharedDay('Europe/Madrid', friends, long, long, now)).toBe('2026-09-28');
    expect(firstSharedDay('America/New_York', friends, long, long, now)).toBe('2026-09-27');
    const friendOn = new Date('2026-09-30T08:00:00.000Z');
    expect(firstSharedDay('Europe/Madrid', friends, friendOn, long, now)).toBe('2026-09-30');
    const meOn = new Date('2026-09-29T08:00:00.000Z');
    expect(firstSharedDay('Europe/Madrid', friends, long, meOn, now)).toBe('2026-09-29');
  });

  it('treats a missing start as now', () => {
    const long = new Date('2026-01-01T00:00:00.000Z');
    expect(firstSharedDay('Europe/Madrid', long, null, long, now)).toBe('2026-10-01');
    expect(firstSharedDay('Europe/Madrid', long, long, null, now)).toBe('2026-10-01');
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
    for (const friend of [bea, fede, gael, hidden, blocked]) {
      await befriend(t.db, ana, friend, clock.now());
    }
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
    await befriend(t.db, madrid, newYork, clock.now());
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
  describe('never retroactive', () => {
    const longAgo = new Date('2026-01-05T09:00:00.000Z');
    const week = (res: { json: <T>() => T }) => res.json<RankingResponse>();
    const entry = (body: RankingResponse, userId: string) =>
      body.entries.find((e) => e.userId === userId);

    it('counts a friend’s days only from the day the friendship began', async () => {
      const ana = await person({ displayName: 'Ana', sharing, rankingSince: longAgo });
      const bea = await person({ displayName: 'Bea', sharing, rankingSince: longAgo });
      const anaPc = await addDevice(t.db, ana);
      const beaPc = await addDevice(t.db, bea);
      for (const day of ['2026-09-14', '2026-09-20', '2026-09-22', '2026-09-23', '2026-09-24']) {
        await addDay(t.db, bea, beaPc, day, { focusMinutes: 100, studyMinutes: 10 });
        await addDay(t.db, ana, anaPc, day, { focusMinutes: 50 });
      }
      await addDay(t.db, bea, beaPc, '2026-09-29', { focusMinutes: 40 });
      // Friends since Wednesday 2026-09-23 of W39 (Madrid time).
      await befriend(t.db, ana, bea, new Date('2026-09-23T07:00:00.000Z'));

      // A week before the friendship: Bea is not in it at all; Ana keeps her own history.
      const w38 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W38'));
      expect(w38.entries.map((e) => e.userId)).toEqual([ana.userId]);
      expect(w38.entries[0]).toMatchObject({ focusMinutes: 100, activeDays: 2 });
      const w38Bea = week(await call(bea, 'GET', '/v1/ranking?week=2026-W38'));
      expect(w38Bea.entries.map((e) => e.userId)).toEqual([bea.userId]);

      // The week they became friends: only from that Wednesday on (both ways).
      const w39 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W39'));
      expect(entry(w39, bea.userId)).toMatchObject({
        focusMinutes: 200,
        studyMinutes: 20,
        activeDays: 2,
      });
      expect(entry(w39, ana.userId)).toMatchObject({ focusMinutes: 150, activeDays: 3 });
      const w39Bea = week(await call(bea, 'GET', '/v1/ranking?week=2026-W39'));
      expect(entry(w39Bea, ana.userId)).toMatchObject({ focusMinutes: 100, activeDays: 2 });

      const w40 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W40'));
      expect(entry(w40, bea.userId)).toMatchObject({ focusMinutes: 40, activeDays: 1 });
    });

    it('counts a friend’s days only from when they last turned the ranking on', async () => {
      const ana = await person({ displayName: 'Ana', sharing, rankingSince: longAgo });
      const bea = await person({ displayName: 'Bea', sharing: { syncStats: true } });
      await befriend(t.db, ana, bea, longAgo);
      const beaPc = await addDevice(t.db, bea);
      // Synced while Bea's ranking was off.
      for (const day of ['2026-09-21', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) {
        await addDay(t.db, bea, beaPc, day, { focusMinutes: 100 });
      }
      const patchBea = async (sharingPatch: object): Promise<MeResponse> => {
        const res = await app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: bea.headers,
          payload: { sharing: sharingPatch },
        });
        expect(res.statusCode).toBe(200);
        return res.json<MeResponse>();
      };

      // Wednesday 2026-09-30, 10:00 in Madrid: Bea turns the ranking on.
      clock.set('2026-09-30T08:00:00.000Z');
      expect((await patchBea({ ranking: true })).rankingSince).toBe('2026-09-30T08:00:00.000Z');
      clock.advance(3_600_000);
      // Saying «on» again keeps the start.
      expect((await patchBea({ ranking: true, presence: true })).rankingSince).toBe(
        '2026-09-30T08:00:00.000Z',
      );

      const w39 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W39'));
      expect(entry(w39, bea.userId)).toBeUndefined();
      const w40 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W40'));
      expect(entry(w40, bea.userId)).toMatchObject({ focusMinutes: 200, activeDays: 2 });

      // Off and on again: it starts over (Friday 2026-10-02) and nothing before counts.
      expect((await patchBea({ ranking: false })).rankingSince).toBeNull();
      clock.set('2026-10-02T08:00:00.000Z');
      expect((await patchBea({ ranking: true })).rankingSince).toBe('2026-10-02T08:00:00.000Z');
      await addDay(t.db, bea, beaPc, '2026-10-02', { focusMinutes: 30 });
      const again = week(await call(ana, 'GET', '/v1/ranking?week=2026-W40'));
      expect(entry(again, bea.userId)).toMatchObject({ focusMinutes: 30, activeDays: 1 });

      // Turning sync off turns the ranking off and forgets its start.
      expect(await patchBea({ syncStats: false })).toMatchObject({
        sharing: { syncStats: false, ranking: false },
        rankingSince: null,
      });
    });

    it('shows friends only from when the caller turned the ranking on (reciprocity)', async () => {
      const bea = await person({ displayName: 'Bea', sharing, rankingSince: longAgo });
      // Ana turned hers on on Thursday 2026-10-01 at 11:00 in Madrid.
      const ana = await person({
        displayName: 'Ana',
        sharing,
        rankingSince: new Date('2026-10-01T09:00:00.000Z'),
      });
      await befriend(t.db, ana, bea, longAgo);
      const anaPc = await addDevice(t.db, ana);
      const beaPc = await addDevice(t.db, bea);
      for (const day of ['2026-09-22', '2026-09-29', '2026-10-01', '2026-10-02']) {
        await addDay(t.db, ana, anaPc, day, { focusMinutes: 10 });
        await addDay(t.db, bea, beaPc, day, { focusMinutes: 100 });
      }

      const w39 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W39'));
      expect(w39.entries.map((e) => e.userId)).toEqual([ana.userId]);
      expect(w39.entries[0]).toMatchObject({ focusMinutes: 10 });

      const w40 = week(await call(ana, 'GET', '/v1/ranking?week=2026-W40'));
      expect(entry(w40, ana.userId)).toMatchObject({ focusMinutes: 30, activeDays: 3 });
      expect(entry(w40, bea.userId)).toMatchObject({ focusMinutes: 200, activeDays: 2 });
      // And Bea sees Ana from the same day.
      const w40Bea = week(await call(bea, 'GET', '/v1/ranking?week=2026-W40'));
      expect(entry(w40Bea, ana.userId)).toMatchObject({ focusMinutes: 20, activeDays: 2 });
    });
  });
});
