/**
 * Desktop login (loopback redirect + PKCE): the connect page, authorize, token, logout,
 * device reuse and limits, the recent sign-in it needs and the time zone it stores. Browser
 * steps use a better-auth-signed cookie on the real resolver.
 */
import type { AppTokenResponse, DevicesResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/routes/app-auth';
import { appAuthCodes, dailyStats, devices, profiles, session, user } from '../src/db/schema';
import { createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { buildCoreApp, pkcePair, sessionCookie, TEST_ORIGIN } from './helpers/core';
import type { CoreApp } from './helpers/core';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;
let core: CoreApp;
let u: TestUser;
let cookie: string;

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
  u = await createTestUser(t.db, { now: clock.now() });
  cookie = sessionCookie(u.token);
  return async () => {
    await core.app.close();
  };
});

const STATE = 'state-0123456789abcdef';
const PORT = 51_234;

function authorize(
  fields: Record<string, string>,
  headers: Record<string, string> = { cookie, origin: TEST_ORIGIN },
) {
  return core.app.inject({
    method: 'POST',
    url: '/v1/app-auth/authorize',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(fields).toString(),
  });
}

async function codeFor(challenge: string): Promise<string> {
  const res = await authorize({ challenge, state: STATE, port: String(PORT) });
  expect(res.statusCode).toBe(303);
  const location = new URL(String(res.headers.location));
  expect(location.origin).toBe(`http://127.0.0.1:${PORT}`);
  expect(location.pathname).toBe('/callback');
  expect(location.searchParams.get('state')).toBe(STATE);
  return location.searchParams.get('code') ?? '';
}

function token(
  code: string,
  verifier: string,
  installId = 'install-0123456789abcdef',
  timeZone = 'America/Mexico_City',
) {
  return core.app.inject({
    method: 'POST',
    url: '/v1/app-auth/token',
    headers: { 'content-type': 'application/json' },
    payload: {
      code,
      codeVerifier: verifier,
      installId,
      device: { name: '  Portátil de Ana ', platform: 'win', appVersion: '1.4.0' },
      timeZone,
    },
  });
}

async function login(installId?: string): Promise<AppTokenResponse> {
  const { verifier, challenge } = pkcePair();
  const res = await token(await codeFor(challenge), verifier, installId);
  expect(res.statusCode).toBe(200);
  return res.json<AppTokenResponse>();
}

describe('connect page', () => {
  const query = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      challenge: pkcePair().challenge,
      state: STATE,
      port: String(PORT),
      device: 'Portátil <b>de</b> Ana',
      ...over,
    }).toString();

  it('asks before connecting, escaping the device name', async () => {
    const res = await core.app.inject({
      method: 'GET',
      url: `/cuenta/conectar?${query()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Conectar este ordenador');
    expect(res.body).toContain('«Portátil &lt;b&gt;de&lt;/b&gt; Ana»');
    expect(res.body).toContain('action="/v1/app-auth/authorize"');
    expect(res.body).toContain(u.email);
    expect(res.body).not.toMatch(/<script>(?!<\/script>)/);
  });

  it('sends signed-out browsers to sign in first, and back', async () => {
    const q = query();
    const res = await core.app.inject({ method: 'GET', url: `/cuenta/conectar?${q}` });
    expect(res.statusCode).toBe(303);
    const location = new URL(String(res.headers.location), TEST_ORIGIN);
    expect(location.pathname).toBe('/cuenta');
    expect(location.searchParams.get('volver')).toMatch(/^\/cuenta\/conectar\?/);
  });

  it('rejects malformed links', async () => {
    for (const over of [
      { port: '80' },
      { port: '70000' },
      { challenge: 'short' },
      { state: 'x' },
    ] as Array<Record<string, string>>) {
      const res = await core.app.inject({
        method: 'GET',
        url: `/cuenta/conectar?${query(over)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('no es válido');
    }
  });
});

describe('authorize', () => {
  it('needs our Origin on the cookie form post', async () => {
    const { challenge } = pkcePair();
    const fields = { challenge, state: STATE, port: String(PORT) };
    expect((await authorize(fields, { cookie })).statusCode).toBe(403);
    expect((await authorize(fields, { cookie, origin: 'https://evil.example' })).statusCode).toBe(
      403,
    );
    // A same-origin form post under `Referrer-Policy: no-referrer` sends `Origin: null`.
    const sameSite = await authorize(fields, {
      cookie,
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    });
    expect(sameSite.statusCode).toBe(303);
  });

  it('refuses bearer tokens and redirects signed-out browsers', async () => {
    const { challenge } = pkcePair();
    const fields = { challenge, state: STATE, port: String(PORT) };
    expect((await authorize(fields, { ...u.headers })).statusCode).toBe(403);
    const out = await authorize(fields, { origin: TEST_ORIGIN });
    expect(out.statusCode).toBe(303);
    expect(String(out.headers.location)).toMatch(/^\/cuenta\?volver=%2Fcuenta%2Fconectar/);
  });

  it('validates the port and the challenge', async () => {
    const { challenge } = pkcePair();
    for (const fields of [
      { challenge, state: STATE, port: '80' },
      { challenge, state: STATE, port: '65536' },
      { challenge, state: STATE, port: 'http://evil' },
      { challenge: 'x', state: STATE, port: String(PORT) },
      { challenge, state: 'a b', port: String(PORT) },
      { challenge, state: STATE, port: String(PORT), extra: '1' },
    ] as Array<Record<string, string>>) {
      const res = await authorize(fields);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
    expect(await t.db.select().from(appAuthCodes)).toHaveLength(0);
  });

  it('stores only a hash of the code', async () => {
    const { challenge } = pkcePair();
    const code = await codeFor(challenge);
    const rows = await t.db.select().from(appAuthCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.codeHash).not.toContain(code);
    expect(rows[0]?.port).toBe(PORT);
  });
});

describe('token', () => {
  it('trades code and verifier for a bearer session bound to a device', async () => {
    const body = await login();
    expect(body.token).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(body.me.user.email).toBe(u.email);
    expect(new Date(body.expiresAt).getTime()).toBe(clock.now().getTime() + 60 * 86_400_000);

    const headers = { authorization: `Bearer ${body.token}` };
    const list = await core.app.inject({ method: 'GET', url: '/v1/devices', headers });
    const { devices: devs } = list.json<DevicesResponse>();
    expect(devs).toEqual([
      {
        id: body.deviceId,
        name: 'Portátil de Ana',
        platform: 'win',
        appVersion: '1.4.0',
        createdAt: clock.now().toISOString(),
        lastSyncAt: null,
        current: true,
      },
    ]);
    const rows = await t.db.select().from(session).where(eq(session.token, body.token));
    expect(rows[0]?.ipAddress).toBeNull();
    expect(rows[0]?.userAgent).toBeNull();
  });

  it('rejects a wrong verifier and burns the code', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await codeFor(challenge);
    const wrong = await token(code, pkcePair().verifier);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('validation_failed');
    expect((await token(code, verifier)).statusCode).toBe(400);
  });

  it('accepts each code once', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await codeFor(challenge);
    expect((await token(code, verifier)).statusCode).toBe(200);
    expect((await token(code, verifier)).statusCode).toBe(400);
  });

  it('rejects codes older than 60 seconds', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await codeFor(challenge);
    clock.advance(61_000);
    expect((await token(code, verifier)).statusCode).toBe(400);
  });

  it('validates the body strictly', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await codeFor(challenge);
    const res = await core.app.inject({
      method: 'POST',
      url: '/v1/app-auth/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        code,
        codeVerifier: verifier,
        installId: 'short',
        device: { name: 'x', platform: 'amiga', appVersion: '1' },
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['body.installId', 'body.device.platform']));
  });

  it('reuses the device when the same computer logs in again and revokes its old session', async () => {
    const first = await login();
    await t.db.insert(dailyStats).values({
      deviceId: first.deviceId,
      userId: u.userId,
      day: '2026-09-27',
      rev: 1,
      focusMinutes: 10,
      studyMinutes: 0,
      blocksCompleted: 0,
      studySessions: 0,
      attempts: 0,
      emergencyUnlocks: 0,
      punishments: 0,
      pointsEarned: 0,
      pointsLost: 0,
    });
    const second = await login();
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.token).not.toBe(first.token);
    const old = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(old.statusCode).toBe(401);
    expect(await t.db.select().from(devices)).toHaveLength(1);
    expect(await t.db.select().from(dailyStats)).toHaveLength(1);

    const other = await login('install-other-computer-01');
    expect(other.deviceId).not.toBe(first.deviceId);
  });

  it('allows at most 10 devices', async () => {
    for (let i = 0; i < 10; i += 1) {
      await t.db.insert(devices).values({
        userId: u.userId,
        installId: `install-existing-${String(i).padStart(4, '0')}`,
        name: `PC ${i}`,
        platform: 'linux',
        appVersion: '1.0.0',
      });
    }
    const { verifier, challenge } = pkcePair();
    const res = await token(await codeFor(challenge), verifier);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('limit_reached');
    // An existing computer can still log in again.
    const again = await token(await codeFor(challenge), verifier, 'install-existing-0003');
    expect(again.statusCode).toBe(200);
  });
});

describe('logout and device removal', () => {
  it('logout revokes the session and keeps the device', async () => {
    const body = await login();
    const headers = { authorization: `Bearer ${body.token}` };
    const out = await core.app.inject({ method: 'POST', url: '/v1/app-auth/logout', headers });
    expect(out.statusCode).toBe(204);
    expect((await core.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
    const [device] = await t.db.select().from(devices).where(eq(devices.id, body.deviceId));
    expect(device?.sessionId).toBeNull();
  });

  it('removing a device revokes its session and deletes its stats', async () => {
    const body = await login();
    await t.db.insert(dailyStats).values({
      deviceId: body.deviceId,
      userId: u.userId,
      day: '2026-09-27',
      rev: 1,
      focusMinutes: 10,
      studyMinutes: 0,
      blocksCompleted: 0,
      studySessions: 0,
      attempts: 0,
      emergencyUnlocks: 0,
      punishments: 0,
      pointsEarned: 0,
      pointsLost: 0,
    });
    // From the web panel (cookie session of the same user).
    const res = await core.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${body.deviceId}`,
      headers: { cookie, origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(204);
    const after = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(after.statusCode).toBe(401);
    expect(await t.db.select().from(dailyStats)).toHaveLength(0);
  });
});

describe('connecting a computer needs a recent sign-in', () => {
  const DAY = 86_400_000;
  const MINUTE = 60_000;
  const signedInAt = new Date('2026-09-28T10:00:00.000Z');

  const deleteAccount = (headers: Record<string, string>) =>
    core.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { confirm: 'BORRAR' },
    });

  it('an old browser session cannot mint a desktop session to delete the account', async () => {
    // A computer connected right after signing in, then the browser left open for 13 days.
    const pc = await login('install-real-computer-01');
    clock.advance(13 * DAY);
    const stale = await deleteAccount({ cookie, origin: TEST_ORIGIN });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('reauth_required');

    // «Conectar» with the old session: back to the connect page (which asks to sign in
    // again), never to the loopback, and no code is stored.
    const { challenge } = pkcePair();
    const res = await authorize({ challenge, state: STATE, port: String(PORT) });
    expect(res.statusCode).toBe(303);
    const location = new URL(String(res.headers.location), TEST_ORIGIN);
    expect(location.origin).toBe(TEST_ORIGIN);
    expect(location.pathname).toBe('/cuenta/conectar');
    expect(location.searchParams.get('challenge')).toBe(challenge);
    expect(location.searchParams.get('code')).toBeNull();
    expect(await t.db.select().from(appAuthCodes)).toHaveLength(0);

    // Nothing changed: the account, the real computer and its session are all there.
    expect(await t.db.select().from(user).where(eq(user.id, u.userId))).toHaveLength(1);
    const headers = { authorization: `Bearer ${pc.token}` };
    expect((await core.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(200);
    expect(await t.db.select().from(devices)).toHaveLength(1);
  });

  it('gives the desktop session the sign-in time behind it, not its own', async () => {
    // Signed in at 10:00, the computer connected at 10:10.
    clock.advance(10 * MINUTE);
    const body = await login();
    const [row] = await t.db.select().from(session).where(eq(session.token, body.token));
    expect(row?.createdAt).toEqual(clock.now());
    expect(row?.authenticatedAt).toEqual(signedInAt);

    const headers = { authorization: `Bearer ${body.token}` };
    // 16 minutes after signing in (6 after connecting): no longer fresh anywhere.
    clock.advance(6 * MINUTE);
    const del = await deleteAccount(headers);
    expect(del.statusCode).toBe(403);
    expect(del.json().error.code).toBe('reauth_required');
    const revoke = await core.app.inject({
      method: 'POST',
      url: '/v1/sessions/revoke-others',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { includeDevices: true },
    });
    expect(revoke.statusCode).toBe(403);
    // Its sliding expiry still counts from the connection (60 days).
    expect(row?.expiresAt.getTime()).toBe((row?.createdAt.getTime() ?? 0) + 60 * DAY);
  });

  it('deletes the account from a computer connected right after signing in', async () => {
    const body = await login();
    clock.advance(5 * MINUTE);
    const res = await deleteAccount({ authorization: `Bearer ${body.token}` });
    expect(res.statusCode).toBe(204);
    expect(await t.db.select().from(user).where(eq(user.id, u.userId))).toHaveLength(0);
  });

  it('asks an old browser session to sign in again on the connect page', async () => {
    clock.advance(16 * MINUTE);
    const { challenge } = pkcePair();
    const q = new URLSearchParams({ challenge, state: STATE, port: String(PORT), device: 'PC' });
    const res = await core.app.inject({
      method: 'GET',
      url: `/cuenta/conectar?${q.toString()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Vuelve a iniciar sesión');
    expect(res.body).toContain('id="reauth"');
    expect(res.body).toContain(`data-volver="/cuenta/conectar?challenge=${challenge}&amp;state=`);
    expect(res.body).not.toContain('action="/v1/app-auth/authorize"');
  });

  it('refuses a code whose sign-in is too old, however it was stored', async () => {
    const { verifier, challenge } = pkcePair();
    const code = 'c'.repeat(43);
    await t.db.insert(appAuthCodes).values({
      codeHash: sha256Hex(code),
      userId: u.userId,
      challenge,
      port: PORT,
      authenticatedAt: new Date(clock.now().getTime() - 17 * MINUTE),
      createdAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    const res = await token(code, verifier);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0].path).toBe('body.code');
    expect(await t.db.select().from(devices)).toHaveLength(0);
  });
});

describe('time zone', () => {
  it('stores the computer’s zone in the profile on every login', async () => {
    const first = await login();
    expect(first.me.profile.timeZone).toBe('America/Mexico_City');
    const { verifier, challenge } = pkcePair();
    const again = await token(await codeFor(challenge), verifier, undefined, 'Atlantic/Canary');
    expect(again.statusCode).toBe(200);
    expect(again.json<AppTokenResponse>().me.profile.timeZone).toBe('Atlantic/Canary');
    const [p] = await t.db.select().from(profiles).where(eq(profiles.userId, u.userId));
    expect(p?.timeZone).toBe('Atlantic/Canary');
  });

  it('needs a valid IANA zone, and a refused login changes nothing', async () => {
    for (const zone of ['Mars/Olympus', '', 'x'.repeat(65)]) {
      const { verifier, challenge } = pkcePair();
      const res = await token(await codeFor(challenge), verifier, undefined, zone);
      expect(res.statusCode).toBe(400);
      const paths = res.json().error.issues.map((i: { path: string }) => i.path);
      expect(paths).toContain('body.timeZone');
    }
    const [p] = await t.db.select().from(profiles).where(eq(profiles.userId, u.userId));
    expect(p?.timeZone).toBe('Europe/Madrid');
    expect(await t.db.select().from(devices)).toHaveLength(0);
  });
});
