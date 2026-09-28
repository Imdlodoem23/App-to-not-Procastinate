/**
 * Browser sessions: listing them (GET /v1/sessions and /cuenta) and ending every other one
 * (POST /v1/sessions/revoke-others), desktop sessions only on request. docs/API.md §4.1.
 */
import type {
  RevokeOtherSessionsResponse,
  SessionsResponse,
  StatsResponse,
} from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dailyStats, devices, session } from '../src/db/schema';
import { createSessionRow, randomAlphanumeric } from '../src/auth/session';
import { sessionDate } from '../src/pages/account';
import { createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { buildCoreApp, sessionCookie, TEST_ORIGIN } from './helpers/core';
import type { CoreApp } from './helpers/core';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;
let core: CoreApp;
let ana: TestUser;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock('2026-09-28T10:00:00.000Z');
  core = await buildCoreApp(t.db, clock);
  // Ana's first browser session, signed in two hours ago.
  ana = await createTestUser(t.db, {
    now: clock.now(),
    sessionCreatedAt: new Date(clock.now().getTime() - 2 * 3_600_000),
  });
  return async () => {
    await core.app.close();
  };
});

const DAY = 86_400_000;

/** Another browser session of the user, created `hoursAgo`, lasting 14 days. */
async function browserSession(userId: string, hoursAgo: number): Promise<string> {
  const createdAt = new Date(clock.now().getTime() - hoursAgo * 3_600_000);
  const token = randomAlphanumeric(32);
  await t.db.insert(session).values({
    id: randomAlphanumeric(32),
    token,
    userId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + 14 * DAY),
  });
  return token;
}

/** A connected computer: a desktop session with its device row and one day of stats. */
async function desktop(userId: string, installId: string) {
  const s = await createSessionRow(t.db, userId, clock.now());
  const [device] = await t.db
    .insert(devices)
    .values({
      userId,
      installId,
      sessionId: s.id,
      name: 'Portátil',
      platform: 'linux',
      appVersion: '1.0.0',
    })
    .returning();
  await t.db.insert(dailyStats).values({
    deviceId: device?.id ?? '',
    userId,
    day: '2026-09-27',
    rev: 1,
    focusMinutes: 30,
    studyMinutes: 0,
    blocksCompleted: 1,
    studySessions: 0,
    attempts: 0,
    emergencyUnlocks: 0,
    punishments: 0,
    pointsEarned: 10,
    pointsLost: 0,
  });
  return { token: s.token, deviceId: device?.id ?? '' };
}

const me = (headers: Record<string, string>) =>
  core.app.inject({ method: 'GET', url: '/v1/me', headers });

function revoke(headers: Record<string, string>, payload: object = {}) {
  return core.app.inject({
    method: 'POST',
    url: '/v1/sessions/revoke-others',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('GET /v1/sessions', () => {
  it('lists live browser sessions newest first, marks the caller and leaves computers out', async () => {
    await browserSession(ana.userId, 30);
    // Expired, a computer's and someone else's: not listed.
    await browserSession(ana.userId, 15 * 24);
    await desktop(ana.userId, 'install-sessions-00001');
    await createTestUser(t.db, { now: clock.now() });

    const res = await core.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { cookie: sessionCookie(ana.token) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionsResponse>();
    expect(body.browser).toEqual([
      {
        createdAt: '2026-09-28T08:00:00.000Z',
        expiresAt: '2026-11-27T10:00:00.000Z',
        current: true,
      },
      {
        createdAt: '2026-09-27T04:00:00.000Z',
        expiresAt: '2026-10-11T04:00:00.000Z',
        current: false,
      },
    ]);
  });
});

describe('POST /v1/sessions/revoke-others', () => {
  it('ends every other browser session and keeps this one and the computers', async () => {
    const b = await browserSession(ana.userId, 5);
    const c = await browserSession(ana.userId, 50);
    const pc = await desktop(ana.userId, 'install-sessions-00001');
    const other = await createTestUser(t.db, { now: clock.now() });
    const cookie = sessionCookie(ana.token);

    const res = await revoke({ cookie, origin: TEST_ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.json<RevokeOtherSessionsResponse>()).toEqual({ browser: 2, devices: 0 });

    expect((await me({ cookie })).statusCode).toBe(200);
    for (const token of [b, c]) {
      expect((await me({ cookie: sessionCookie(token) })).statusCode).toBe(401);
    }
    expect((await me({ authorization: `Bearer ${pc.token}` })).statusCode).toBe(200);
    expect((await me(other.headers)).statusCode).toBe(200);
    // Nothing left to end.
    expect((await revoke({ cookie, origin: TEST_ORIGIN })).json()).toEqual({
      browser: 0,
      devices: 0,
    });
  });

  it('follows the CSRF rule for cookies', async () => {
    const b = await browserSession(ana.userId, 5);
    const cookie = sessionCookie(ana.token);
    const refused: Record<string, string>[] = [
      { cookie },
      { cookie, origin: 'https://evil.example' },
      { cookie, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of refused) {
      const res = await revoke(headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    expect((await me({ cookie: sessionCookie(b) })).statusCode).toBe(200);
    expect((await revoke({ cookie, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await me({ cookie: sessionCookie(b) })).statusCode).toBe(401);
  });

  it('signs out the computers too on request, keeping their devices and stats', async () => {
    const pc = await desktop(ana.userId, 'install-sessions-00001');
    const laptop = await desktop(ana.userId, 'install-sessions-00002');
    await browserSession(ana.userId, 5);
    // The caller: a browser session created a minute ago (fresh).
    const fresh = await browserSession(ana.userId, 1 / 60);

    const res = await revoke(
      { cookie: sessionCookie(fresh), origin: TEST_ORIGIN },
      { includeDevices: true },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ browser: 2, devices: 2 });
    for (const token of [pc.token, laptop.token, ana.token]) {
      expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(401);
    }
    const rows = await t.db.select().from(devices).where(eq(devices.userId, ana.userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.sessionId === null)).toBe(true);
    expect(await t.db.select().from(dailyStats)).toHaveLength(2);
    const stats = await core.app.inject({
      method: 'GET',
      url: '/v1/stats?from=2026-09-27&to=2026-09-27',
      headers: { cookie: sessionCookie(fresh) },
    });
    expect(stats.json<StatsResponse>().days[0]?.focusMinutes).toBe(60);
  });

  it('lets a computer sign out the others and stay connected itself', async () => {
    const pc = await desktop(ana.userId, 'install-sessions-00001');
    const laptop = await desktop(ana.userId, 'install-sessions-00002');
    const headers = { authorization: `Bearer ${pc.token}` };
    const res = await revoke(headers, { includeDevices: true });
    expect(res.json()).toEqual({ browser: 1, devices: 1 });
    expect((await me(headers)).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${laptop.token}` })).statusCode).toBe(401);
  });

  it('needs a fresh session to sign out the computers', async () => {
    const pc = await desktop(ana.userId, 'install-sessions-00001');
    const cookie = sessionCookie(ana.token);
    const res = await revoke({ cookie, origin: TEST_ORIGIN }, { includeDevices: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('reauth_required');
    expect((await me({ authorization: `Bearer ${pc.token}` })).statusCode).toBe(200);
  });

  it('validates the body and needs a session', async () => {
    const cookie = sessionCookie(ana.token);
    const bad = await revoke({ cookie, origin: TEST_ORIGIN }, { includeDevices: 'yes' });
    expect(bad.statusCode).toBe(400);
    const extra = await revoke({ cookie, origin: TEST_ORIGIN }, { everything: true });
    expect(extra.statusCode).toBe(400);
    const anonymous = await revoke({ origin: TEST_ORIGIN });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('/cuenta', () => {
  it('shows the open browser sessions (dates only) and the button to end the others', async () => {
    await browserSession(ana.userId, 30);
    const res = await core.app.inject({
      method: 'GET',
      url: '/cuenta',
      headers: { cookie: sessionCookie(ana.token) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Navegadores con la sesión abierta');
    expect(res.body).toContain('Cada sesión en un navegador dura 14 días');
    expect(res.body).toMatch(/Este navegador: desde el\s+28 de septiembre a las 10:00/);
    expect(res.body).toMatch(/Otro navegador: desde el\s+27 de septiembre a las 06:00/);
    expect(res.body).toContain('id="revoke-others"');
    expect(res.body).toContain('Cerrar sesión en los demás navegadores');
  });

  it('says so when this is the only browser session', async () => {
    await desktop(ana.userId, 'install-sessions-00001');
    const res = await core.app.inject({
      method: 'GET',
      url: '/cuenta',
      headers: { cookie: sessionCookie(ana.token) },
    });
    expect(res.body).toContain('Solo este navegador tiene la sesión abierta.');
    expect(res.body).not.toContain('id="revoke-others"');
  });

  it('formats dates in the user’s zone', () => {
    const at = new Date('2026-10-11T22:30:00.000Z');
    expect(sessionDate(at, 'Europe/Madrid')).toBe('12 de octubre a las 00:30');
    expect(sessionDate(at, 'Not/AZone')).toBe('11 de octubre a las 22:30');
  });
});
