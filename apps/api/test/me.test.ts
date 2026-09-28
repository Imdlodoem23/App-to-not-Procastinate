/**
 * /v1/me and /v1/devices: profile and consent rules, device management, fresh-session delete.
 */
import type { CloudDevice, MeResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devices, presence, profiles, user } from '../src/db/schema';
import { buildTestApp, createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;
let app: FastifyInstance;
let u: TestUser;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock('2026-09-28T10:00:00.000Z');
  app = await buildTestApp({ db: t.db, clock });
  u = await createTestUser(t.db, { now: clock.now(), displayName: 'Ana' });
  return async () => {
    await app.close();
  };
});

const patch = (payload: unknown, who: TestUser = u) =>
  app.inject({ method: 'PATCH', url: '/v1/me', headers: who.headers, payload: payload as object });

async function addDevice(userId: string, n = 0, sessionId: string | null = null) {
  const [row] = await t.db
    .insert(devices)
    .values({
      userId,
      installId: `install-test-${String(n).padStart(8, '0')}`,
      sessionId,
      name: `PC ${n}`,
      platform: 'linux',
      appVersion: '1.0.0',
      createdAt: new Date(clock.now().getTime() + n),
    })
    .returning();
  if (!row) throw new Error('no device');
  return row;
}

describe('GET /v1/me', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the account with every switch off', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: u.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>()).toEqual({
      user: { id: u.userId, email: u.email, createdAt: expect.any(String) },
      profile: { displayName: 'Ana', timeZone: 'Europe/Madrid', dailyGoalMinutes: null },
      sharing: {
        syncStats: false,
        ranking: false,
        presence: false,
        partnerEmails: false,
        coach: false,
      },
      consentUpdatedAt: null,
      rankingSince: null,
    });
  });
});

describe('PATCH /v1/me', () => {
  it('updates the profile with trimmed, validated values', async () => {
    const res = await patch({
      profile: { displayName: '  Ana  ', timeZone: 'America/Bogota', dailyGoalMinutes: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>().profile).toEqual({
      displayName: 'Ana',
      timeZone: 'America/Bogota',
      dailyGoalMinutes: 90,
    });
    // Profile changes are not consent changes.
    expect(res.json<MeResponse>().consentUpdatedAt).toBeNull();
    expect(
      (await patch({ profile: { dailyGoalMinutes: null } })).json().profile.dailyGoalMinutes,
    ).toBeNull();
  });

  it('rejects bad profile values', async () => {
    for (const profile of [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(41) },
      { displayName: 'Ana\u0007' },
      { displayName: 'Ana\u202e' },
      { displayName: null },
      { timeZone: 'Mars/Olympus' },
      { dailyGoalMinutes: 14 },
      { dailyGoalMinutes: 601 },
      { dailyGoalMinutes: 30.5 },
      { email: 'x@example.com' },
    ]) {
      const res = await patch({ profile });
      expect(res.statusCode, JSON.stringify(profile)).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
      expect(res.body).not.toContain('Olympus');
    }
    expect((await patch({ extra: true })).statusCode).toBe(400);
  });

  it('needs sync for the ranking and turns the ranking off with sync', async () => {
    const bad = await patch({ sharing: { ranking: true } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.issues[0].path).toBe('body.sharing.ranking');
    expect((await patch({ sharing: { syncStats: false, ranking: true } })).statusCode).toBe(400);

    const on = await patch({ sharing: { syncStats: true, ranking: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json<MeResponse>().sharing).toMatchObject({ syncStats: true, ranking: true });
    expect(on.json<MeResponse>().consentUpdatedAt).toBe(clock.now().toISOString());

    clock.advance(60_000);
    const off = await patch({ sharing: { syncStats: false } });
    expect(off.json<MeResponse>().sharing).toMatchObject({ syncStats: false, ranking: false });
    expect(off.json<MeResponse>().consentUpdatedAt).toBe(clock.now().toISOString());
  });

  it('keeps consentUpdatedAt when nothing changes and deletes presence when it is turned off', async () => {
    await patch({ sharing: { presence: true, coach: true, partnerEmails: true } });
    const first = clock.now().toISOString();
    clock.advance(60_000);
    const same = await patch({ sharing: { presence: true } });
    expect(same.json<MeResponse>().consentUpdatedAt).toBe(first);

    await t.db.insert(presence).values({
      userId: u.userId,
      state: 'focus',
      since: clock.now(),
      endsAt: null,
      expiresAt: new Date(clock.now().getTime() + 180_000),
    });
    const off = await patch({ sharing: { presence: false } });
    expect(off.json<MeResponse>().sharing).toEqual({
      syncStats: false,
      ranking: false,
      presence: false,
      partnerEmails: true,
      coach: true,
    });
    expect(await t.db.select().from(presence)).toHaveLength(0);
  });
});

describe('devices', () => {
  it('lists, renames and removes only the caller’s devices', async () => {
    const mine = await addDevice(u.userId, 1, u.sessionId);
    const other = await createTestUser(t.db, { now: clock.now() });
    const theirs = await addDevice(other.userId, 2);

    const list = await app.inject({ method: 'GET', url: '/v1/devices', headers: u.headers });
    expect(list.json().devices.map((d: CloudDevice) => [d.id, d.current])).toEqual([
      [mine.id, true],
    ]);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${mine.id}`,
      headers: u.headers,
      payload: { name: ' Sobremesa ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<CloudDevice>().name).toBe('Sobremesa');

    for (const id of [theirs.id, 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const p = await app.inject({
        method: 'PATCH',
        url: `/v1/devices/${id}`,
        headers: u.headers,
        payload: { name: 'X' },
      });
      expect(p.statusCode).toBe(404);
      const d = await app.inject({
        method: 'DELETE',
        url: `/v1/devices/${id}`,
        headers: u.headers,
      });
      expect(d.statusCode).toBe(404);
    }
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${mine.id}`,
      headers: u.headers,
      payload: { name: 'x'.repeat(41) },
    });
    expect(bad.statusCode).toBe(400);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${mine.id}`,
      headers: u.headers,
    });
    expect(removed.statusCode).toBe(204);
    // It was this session's device: the session is gone too.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: u.headers })).statusCode,
    ).toBe(401);
    expect(await t.db.select().from(devices).where(eq(devices.userId, other.userId))).toHaveLength(
      1,
    );
  });
});

describe('DELETE /v1/me', () => {
  it('needs a fresh session and the typed confirmation', async () => {
    const old = await createTestUser(t.db, {
      now: clock.now(),
      sessionCreatedAt: new Date(clock.now().getTime() - 16 * 60_000),
    });
    const stale = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: old.headers,
      payload: { confirm: 'BORRAR' },
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('reauth_required');

    const wrong = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: u.headers,
      payload: { confirm: 'borrar' },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: u.headers,
      payload: { confirm: 'BORRAR' },
    });
    expect(ok.statusCode).toBe(204);
    expect(String(ok.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await t.db.select().from(user).where(eq(user.id, u.userId))).toHaveLength(0);
    expect(await t.db.select().from(profiles).where(eq(profiles.userId, u.userId))).toHaveLength(0);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: u.headers })).statusCode,
    ).toBe(401);
    // The other account is untouched.
    expect(await t.db.select().from(user).where(eq(user.id, old.userId))).toHaveLength(1);
  });
});
