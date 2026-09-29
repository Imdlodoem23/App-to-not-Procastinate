/**
 * Stats sync: consent, device binding, idempotent upserts, stale revs, the day window, the
 * multi-device merge with its caps, and deletion.
 */
import type {
  CloudDayStats,
  PutDaysResponse,
  StatsResponse,
  SyncStateResponse,
} from '@centrate/shared/cloud-api';
import { addDays } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dailyStats, devices, session } from '../src/db/schema';
import { readServerEpoch } from '../src/db/meta';
import { buildTestApp, createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;
let app: FastifyInstance;
let u: TestUser;
let deviceId: string;

// 10:00 UTC on Monday 2026-09-28: the same civil date in Madrid.
const NOW = '2026-09-28T10:00:00.000Z';
const TODAY = '2026-09-28';

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock(NOW);
  app = await buildTestApp({ db: t.db, clock });
  u = await createTestUser(t.db, {
    now: clock.now(),
    sharing: { syncStats: true },
    dailyGoalMinutes: 120,
  });
  deviceId = await addDevice(u, 'install-main-000000001');
  return async () => {
    await app.close();
  };
});

/** A device bound to `who`'s session when `bind`, else a second computer. */
async function addDevice(who: TestUser, installId: string, bind = true): Promise<string> {
  const [row] = await t.db
    .insert(devices)
    .values({
      userId: who.userId,
      installId,
      sessionId: bind ? who.sessionId : null,
      name: installId,
      platform: 'mac',
      appVersion: '1.0.0',
      createdAt: clock.now(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('no device');
  return row.id;
}

function day(d: string, over: Partial<CloudDayStats> = {}): CloudDayStats {
  return {
    day: d,
    rev: 10,
    focusMinutes: 100,
    studyMinutes: 40,
    blocksCompleted: 2,
    studySessions: 1,
    attempts: 3,
    emergencyUnlocks: 0,
    punishments: 0,
    pointsEarned: 50,
    pointsLost: 5,
    ...over,
  };
}

const put = (days: CloudDayStats[], who: TestUser = u, id = deviceId) =>
  app.inject({
    method: 'PUT',
    url: '/v1/sync/days',
    headers: who.headers,
    payload: { deviceId: id, days },
  });

describe('PUT /v1/sync/days', () => {
  it('needs sharing.syncStats', async () => {
    const other = await createTestUser(t.db, { now: clock.now() });
    const otherDevice = await addDevice(other, 'install-other-00000001');
    const res = await put([day(TODAY)], other, otherDevice);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'consent_required', consent: 'syncStats' });
  });

  it('is idempotent and reports stale revs', async () => {
    const first = await put([day(TODAY), day(addDays(TODAY, -1))]);
    expect(first.json<PutDaysResponse>()).toEqual({ accepted: 2, stale: [] });
    // A replay changes nothing and is accepted (equal rev overwrites).
    expect((await put([day(TODAY)])).json<PutDaysResponse>()).toEqual({ accepted: 1, stale: [] });
    // A higher rev replaces; a lower one is ignored and reported.
    const mixed = await put([
      day(TODAY, { rev: 12, focusMinutes: 150 }),
      day(addDays(TODAY, -1), { rev: 3, focusMinutes: 1, studyMinutes: 0 }),
    ]);
    expect(mixed.json<PutDaysResponse>()).toEqual({
      accepted: 1,
      stale: [addDays(TODAY, -1)],
    });
    const rows = await t.db.select().from(dailyStats).orderBy(dailyStats.day);
    expect(rows.map((r) => [r.day, r.rev, r.focusMinutes])).toEqual([
      [addDays(TODAY, -1), 10, 100],
      [TODAY, 12, 150],
    ]);
    const [device] = await t.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device?.lastSyncAt?.toISOString()).toBe(NOW);
  });

  it('accepts only the device bound to the session', async () => {
    const second = await addDevice(u, 'install-second-0000001', false);
    const res = await put([day(TODAY)], u, second);
    expect(res.statusCode).toBe(403);
    const stranger = await createTestUser(t.db, { now: clock.now(), sharing: { syncStats: true } });
    const theirs = await addDevice(stranger, 'install-stranger-00001');
    expect((await put([day(TODAY)], u, theirs)).statusCode).toBe(404);
    expect((await put([day(TODAY)], u, 'nope')).statusCode).toBe(404);
  });

  it('validates days, window and numbers', async () => {
    const cases: CloudDayStats[][] = [
      [day(addDays(TODAY, 2))],
      [day(addDays(TODAY, -401))],
      [day(TODAY), day(TODAY)],
      [day(TODAY, { studyMinutes: 101 })],
      [day(TODAY, { focusMinutes: 1441 })],
      [day(TODAY, { attempts: 10_001 })],
      [day(TODAY, { pointsLost: -1 })],
      [day(TODAY, { rev: 1.5 })],
      [day('2026-02-30')],
      Array.from({ length: 101 }, (_, i) => day(addDays(TODAY, -i))),
    ];
    for (const days of cases) {
      const res = await put(days);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
    const extra = await app.inject({
      method: 'PUT',
      url: '/v1/sync/days',
      headers: u.headers,
      payload: { deviceId, days: [{ ...day(TODAY), domain: 'youtube.com' }] },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain('youtube');
    // The edges of the window are fine: 400 days back and tomorrow.
    expect((await put([day(addDays(TODAY, -400)), day(addDays(TODAY, 1))])).statusCode).toBe(200);
    expect(await t.db.select().from(dailyStats)).toHaveLength(2);
  });

  it('computes the window in the profile time zone', async () => {
    // 11:00 UTC on 2026-09-28 is already 2026-09-29 01:00 in Kiritimati (UTC+14).
    const far = await createTestUser(t.db, {
      now: clock.now(),
      timeZone: 'Pacific/Kiritimati',
      sharing: { syncStats: true },
    });
    const farDevice = await addDevice(far, 'install-kiritimati-0001');
    clock.set('2026-09-28T11:00:00.000Z');
    expect((await put([day('2026-09-30')], far, farDevice)).statusCode).toBe(200);
    expect((await put([day('2026-09-30')], u)).statusCode).toBe(400);
  });

  it('allows 100 days per request', async () => {
    const days = Array.from({ length: 100 }, (_, i) => day(addDays(TODAY, -i)));
    const res = await put(days);
    expect(res.json<PutDaysResponse>().accepted).toBe(100);
  });
});

describe('GET /v1/sync/state', () => {
  it('returns the server epoch and the stored revs of the device', async () => {
    await put([day(TODAY, { rev: 7 }), day(addDays(TODAY, -3), { rev: 4 })]);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/sync/state?deviceId=${deviceId}`,
      headers: u.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SyncStateResponse>()).toEqual({
      serverEpoch: await readServerEpoch(t.db),
      deviceId,
      revs: [
        { day: addDays(TODAY, -3), rev: 4 },
        { day: TODAY, rev: 7 },
      ],
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/sync/state?deviceId=00000000-0000-0000-0000-000000000000',
      headers: u.headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('GET /v1/stats', () => {
  it('merges devices per day with the caps and the goal', async () => {
    await put([
      day(TODAY, { focusMinutes: 1000, studyMinutes: 1000, pointsEarned: 10 }),
      day(addDays(TODAY, -1), { focusMinutes: 60, studyMinutes: 0 }),
    ]);
    // A second computer of the same user uploads through its own session.
    const [s2] = await t.db
      .insert(session)
      .values({
        id: 'second-session-id-0000000000000000',
        token: 'second-session-token-00000000000',
        userId: u.userId,
        expiresAt: new Date(clock.now().getTime() + 86_400_000),
      })
      .returning();
    const second = await addDevice(
      { ...u, sessionId: s2?.id ?? '', headers: { authorization: `Bearer ${s2?.token}` } },
      'install-second-0000001',
    );
    const res2 = await app.inject({
      method: 'PUT',
      url: '/v1/sync/days',
      headers: { authorization: `Bearer ${s2?.token}` },
      payload: { deviceId: second, days: [day(TODAY, { focusMinutes: 800, studyMinutes: 700 })] },
    });
    expect(res2.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/stats?from=${addDays(TODAY, -6)}&to=${TODAY}`,
      headers: u.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatsResponse>();
    expect(body.dailyGoalMinutes).toBe(120);
    expect(body.days).toEqual([
      expect.objectContaining({
        day: addDays(TODAY, -1),
        focusMinutes: 60,
        studyMinutes: 0,
        goalMet: false,
      }),
      expect.objectContaining({
        day: TODAY,
        focusMinutes: 1440,
        studyMinutes: 1440,
        pointsEarned: 60,
        blocksCompleted: 4,
        goalMet: true,
      }),
    ]);
    expect(body.deviceDays).toHaveLength(3);
    expect(body.devices.filter((d) => d.current).map((d) => d.id)).toEqual([deviceId]);
    expect(body.devices).toHaveLength(2);
  });

  it('validates the range', async () => {
    for (const q of [
      `from=${TODAY}&to=${addDays(TODAY, -1)}`,
      `from=${addDays(TODAY, -400)}&to=${TODAY}`,
      `from=2026-13-01&to=${TODAY}`,
      `to=${TODAY}`,
    ]) {
      const res = await app.inject({ method: 'GET', url: `/v1/stats?${q}`, headers: u.headers });
      expect(res.statusCode, q).toBe(400);
    }
    const max = await app.inject({
      method: 'GET',
      url: `/v1/stats?from=${addDays(TODAY, -399)}&to=${TODAY}`,
      headers: u.headers,
    });
    expect(max.statusCode).toBe(200);
    expect(max.json<StatsResponse>().days).toEqual([]);
  });
});

describe('DELETE /v1/sync/days', () => {
  it('deletes the caller’s stats, all or per device, without needing consent', async () => {
    await put([day(TODAY)]);
    const stranger = await createTestUser(t.db, { now: clock.now(), sharing: { syncStats: true } });
    const theirs = await addDevice(stranger, 'install-stranger-00001');
    await put([day(TODAY)], stranger, theirs);
    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: u.headers,
      payload: { sharing: { syncStats: false } },
    });

    const wrong = await app.inject({
      method: 'DELETE',
      url: `/v1/sync/days?deviceId=${theirs}`,
      headers: u.headers,
    });
    expect(wrong.statusCode).toBe(404);
    const one = await app.inject({
      method: 'DELETE',
      url: `/v1/sync/days?deviceId=${deviceId}`,
      headers: u.headers,
    });
    expect(one.statusCode).toBe(204);
    const all = await app.inject({ method: 'DELETE', url: '/v1/sync/days', headers: u.headers });
    expect(all.statusCode).toBe(204);
    const left = await t.db.select().from(dailyStats);
    expect(left.map((r) => r.userId)).toEqual([stranger.userId]);
  });

  it('needs a fresh session for all stats or another computer’s, not for its own', async () => {
    const old = await createTestUser(t.db, {
      now: clock.now(),
      sharing: { syncStats: true },
      sessionCreatedAt: new Date(clock.now().getTime() - 16 * 60_000),
    });
    const own = await addDevice(old, 'install-old-own-000001');
    const other = await addDevice(old, 'install-old-other-00001', false);
    expect((await put([day(TODAY)], old, own)).statusCode).toBe(200);
    await t.db.insert(dailyStats).values({ ...day(TODAY), deviceId: other, userId: old.userId });
    const del = (query: string) =>
      app.inject({ method: 'DELETE', url: `/v1/sync/days${query}`, headers: old.headers });

    for (const query of ['', `?deviceId=${other}`]) {
      const res = await del(query);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('reauth_required');
    }
    expect(
      await t.db.select().from(dailyStats).where(eq(dailyStats.userId, old.userId)),
    ).toHaveLength(2);

    expect((await del(`?deviceId=${own}`)).statusCode).toBe(204);
    const left = await t.db.select().from(dailyStats).where(eq(dailyStats.userId, old.userId));
    expect(left.map((r) => r.deviceId)).toEqual([other]);
  });
});
