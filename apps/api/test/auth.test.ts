/**
 * better-auth end to end through app.inject: email-code sign-in, cookies and bearer tokens on
 * the real session resolver, the CSRF rule for cookie writes, sign-out and revocation.
 */
import type { MeResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { session, user } from '../src/db/schema';
import { fakeClock, testConfig } from './helpers/app';
import type { FakeClock } from './helpers/app';
import { buildCoreApp, sessionCookie, TEST_ORIGIN } from './helpers/core';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import type { CoreApp } from './helpers/core';

let t: TestDb;
let clock: FakeClock;
let core: CoreApp;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  // better-auth checks code and session expiry against the real clock: start from it.
  clock = fakeClock(new Date());
  core = await buildCoreApp(t.db, clock);
  return async () => {
    await core.app.close();
  };
});

const json = { 'content-type': 'application/json', origin: TEST_ORIGIN };

async function requestCode(email: string, headers: Record<string, string> = json) {
  return core.app.inject({
    method: 'POST',
    url: '/api/auth/email-otp/send-verification-otp',
    headers,
    payload: { email, type: 'sign-in' },
  });
}

function lastCode(): string {
  const message = core.mailer.sent.at(-1);
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error('no code sent');
  return match[1];
}

/** Signs in with an email code and returns the session cookie and the JSON token. */
async function signIn(email: string): Promise<{ cookie: string; token: string }> {
  expect((await requestCode(email)).statusCode).toBe(200);
  const res = await core.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email-otp',
    headers: json,
    payload: { email, otp: lastCode() },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = [res.headers['set-cookie']].flat().join('\n');
  const match = setCookie.match(/centrate\.session_token=([^;]+)/);
  if (!match?.[1]) throw new Error('no session cookie');
  return { cookie: `centrate.session_token=${match[1]}`, token: res.json().token };
}

describe('email code sign-in', () => {
  it('sends a Spanish email with the code and a link, and signs in with the code', async () => {
    const res = await requestCode('Ana@Example.com');
    expect(res.statusCode).toBe(200);
    const mail = core.mailer.sent[0];
    expect(mail?.to).toBe('ana@example.com');
    expect(mail?.tag).toBe('sign_in_code');
    expect(mail?.subject).not.toMatch(/\d{6}/);
    const code = lastCode();
    expect(mail?.text).toContain(
      `http://localhost:3000/cuenta/codigo#email=ana%40example.com&otp=${code}`,
    );
    expect(mail?.text).toContain('Caduca en 10 minutos');

    const { cookie } = await signIn('ana@example.com');
    const me = await core.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const body = me.json<MeResponse>();
    expect(body.user.email).toBe('ana@example.com');
    expect(body.profile).toEqual({
      displayName: null,
      timeZone: 'Europe/Madrid',
      dailyGoalMinutes: null,
    });
    expect(Object.values(body.sharing).every((v) => v === false)).toBe(true);
  });

  it('stores no IP, user agent or picture', async () => {
    await requestCode('eva@example.com', {
      ...json,
      'user-agent': 'SpyBrowser/1.0',
      'x-forwarded-for': '203.0.113.7',
    });
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email-otp',
      headers: { ...json, 'user-agent': 'SpyBrowser/1.0', 'x-forwarded-for': '203.0.113.7' },
      payload: {
        email: 'eva@example.com',
        otp: lastCode(),
        name: 'Eva María López',
        image: 'https://x/y.png',
      },
    });
    expect(res.statusCode).toBe(200);
    const [u] = await t.db.select().from(user).where(eq(user.email, 'eva@example.com'));
    expect(u?.image).toBeNull();
    expect(u?.name).toBe('Eva');
    const rows = await t.db
      .select()
      .from(session)
      .where(eq(session.userId, u?.id ?? ''));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ipAddress).toBeNull();
    expect(rows[0]?.userAgent).toBeNull();
    // The first name seeds the display name.
    const me = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(me.json<MeResponse>().profile.displayName).toBe('Eva');
  });

  it('rejects a wrong code and codes that are not for signing in', async () => {
    await requestCode('ana@example.com');
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await core.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email-otp',
      headers: json,
      payload: { email: 'ana@example.com', otp: wrong },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['set-cookie']).toBeUndefined();

    const other = await core.app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/send-verification-otp',
      headers: json,
      payload: { email: 'ana@example.com', type: 'forget-password' },
    });
    expect(other.statusCode).toBe(400);
  });

  it('limits codes per address to 3 per hour', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await requestCode('ana@example.com')).statusCode).toBe(200);
    }
    const res = await requestCode('ANA@example.com ');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(core.mailer.sent).toHaveLength(3);
  });
});

describe('sessions', () => {
  it('accepts the cookie and the bearer token, and signs out', async () => {
    const { cookie, token } = await signIn('ana@example.com');
    const bearer = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bearer.statusCode).toBe(200);

    const out = await core.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, ...json },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    const after = await core.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('unauthorized');
  });

  it('rejects tampered cookies and unknown tokens', async () => {
    const { cookie } = await signIn('ana@example.com');
    const tampered = cookie.replace(/.(%3D|=)$/, 'A$1');
    for (const headers of [
      { cookie: tampered },
      { cookie: sessionCookie('x'.repeat(32), testConfig({ BETTER_AUTH_SECRET: 'z'.repeat(40) })) },
      { authorization: 'Bearer not-a-real-token-0000000000' },
      { authorization: 'Bearer ' },
    ]) {
      const res = await core.app.inject({ method: 'GET', url: '/v1/me', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('stops a deleted session at once and slides expiry once a day', async () => {
    const { token } = await signIn('ana@example.com');
    const headers = { authorization: `Bearer ${token}` };
    const [row] = await t.db.select().from(session).where(eq(session.token, token));
    const firstExpiry = row?.expiresAt.getTime() ?? 0;

    clock.advance(2 * 86_400_000);
    expect((await core.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(200);
    const [slid] = await t.db.select().from(session).where(eq(session.token, token));
    expect(slid?.expiresAt.getTime()).toBeGreaterThan(firstExpiry);

    await t.db.delete(session).where(eq(session.token, token));
    expect((await core.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
  });

  it('expires sessions after 60 days without use', async () => {
    const { token } = await signIn('ana@example.com');
    clock.advance(61 * 86_400_000);
    const res = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('CSRF rule for cookie sessions', () => {
  const patch = (headers: Record<string, string>) =>
    core.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'content-type': 'application/json', ...headers },
      payload: { profile: { dailyGoalMinutes: 60 } },
    });

  it('needs our Origin (or Sec-Fetch-Site: same-origin) on cookie writes', async () => {
    const { cookie, token } = await signIn('ana@example.com');
    expect((await patch({ cookie })).statusCode).toBe(403);
    expect((await patch({ cookie, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await patch({ cookie, origin: 'null' })).statusCode).toBe(403);
    expect((await patch({ cookie, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await patch({ cookie, origin: TEST_ORIGIN })).statusCode).toBe(200);
    expect((await patch({ cookie, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    // Bearer tokens are not ambient credentials: no Origin needed.
    expect((await patch({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    // Reads never need it.
    expect(
      (await core.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('accepts origins listed in APP_ORIGINS', async () => {
    await core.app.close();
    core = await buildCoreApp(t.db, clock, testConfig({ APP_ORIGINS: 'https://panel.example' }));
    const { cookie } = await signIn('ana@example.com');
    expect((await patch({ cookie, origin: 'https://panel.example' })).statusCode).toBe(200);
  });
});

describe('sign-in methods follow the configuration', () => {
  it('hides Google when unconfigured and exposes it when configured', async () => {
    const google = await core.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: json,
      payload: { provider: 'google', callbackURL: '/cuenta' },
    });
    expect(google.statusCode).toBe(200);
    expect(google.json().url).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(google.json().url).not.toContain('access_type=offline');

    await core.app.close();
    core = await buildCoreApp(t.db, clock, testConfig({ GOOGLE_CLIENT_ID: undefined }));
    const off = await core.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: json,
      payload: { provider: 'google', callbackURL: '/cuenta' },
    });
    expect(off.statusCode).toBe(404);
    const page = await core.app.inject({ method: 'GET', url: '/cuenta' });
    expect(page.body).not.toContain('id="google"');
    expect(page.body).toContain('id="email-form"');
  });

  it('turns email codes off without Resend', async () => {
    await core.app.close();
    core = await buildCoreApp(t.db, clock, testConfig({ RESEND_API_KEY: undefined }));
    expect((await requestCode('ana@example.com')).statusCode).toBe(404);
    const page = await core.app.inject({ method: 'GET', url: '/cuenta' });
    expect(page.body).toContain('id="google"');
    expect(page.body).not.toContain('id="email-form"');
  });

  it('exposes only the better-auth endpoints the pages use', async () => {
    for (const [method, url] of [
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/delete-user'],
      ['GET', '/api/auth/list-sessions'],
      ['POST', '/api/auth/sign-up/email'],
      ['POST', '/api/auth/email-otp/reset-password'],
      ['GET', '/api/auth/ok'],
    ] as const) {
      const res = await core.app.inject({
        method,
        url,
        headers: json,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
