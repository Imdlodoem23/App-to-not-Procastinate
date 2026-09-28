/**
 * better-auth end to end through app.inject: email-code sign-in and its limits, Google sign-in
 * and account linking (Google's token endpoint stubbed), cookies and bearer tokens on the real
 * session resolver, the CSRF rule for cookie writes, sign-out and revocation.
 */
import type { HealthResponse, MeResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeMailbox } from '../src/auth/email-limits';
import { account, profiles, rateCounters, session, user } from '../src/db/schema';
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

async function requestCode(
  email: string,
  headers: Record<string, string> = json,
  remoteAddress?: string,
) {
  return core.app.inject({
    method: 'POST',
    url: '/api/auth/email-otp/send-verification-otp',
    headers,
    payload: { email, type: 'sign-in' },
    ...(remoteAddress ? { remoteAddress } : {}),
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
    // The first name moved to the display name; `user.name` keeps no copy of it.
    expect(u?.name).toBe('');
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

describe('sign-in email limits', () => {
  // The counters use the app clock; better-auth only stamps the code with the real one.
  beforeEach(() => {
    clock.set('2026-09-28T01:00:00.000Z');
  });

  it('normalises mailboxes: case, +tags and Gmail dots', () => {
    expect(normalizeMailbox(' Ana.Lopez+centrate@GMail.com ')).toBe('analopez@gmail.com');
    expect(normalizeMailbox('ana.lopez@googlemail.com')).toBe('analopez@gmail.com');
    expect(normalizeMailbox('ana.lopez+x@example.com')).toBe('ana.lopez@example.com');
    expect(normalizeMailbox('+tag@example.com')).toBe('+tag@example.com');
  });

  it('counts +tag and dot variants of one mailbox together, and stores no address', async () => {
    const variants = [
      'ana.lopez+1@gmail.com',
      'analopez+2@googlemail.com',
      'AnaLopez@gmail.com',
      'a.n.a.lopez+x@gmail.com',
    ];
    const statuses = [];
    for (const [i, email] of variants.entries()) {
      statuses.push((await requestCode(email, json, `198.51.100.${i + 1}`)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(core.mailer.sent).toHaveLength(3);
    const rows = await t.db.select().from(rateCounters);
    expect(JSON.stringify(rows)).not.toMatch(/lopez|gmail/i);
  });

  it('keeps the counts in Postgres across a restart', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await requestCode('ana@example.com', json, `198.51.100.${i + 1}`)).statusCode).toBe(
        200,
      );
    }
    await core.app.close();
    core = await buildCoreApp(t.db, clock);
    expect((await requestCode('ana@example.com', json, '198.51.100.9')).statusCode).toBe(429);
  });

  it('allows at most 10 codes per mailbox per UTC day', async () => {
    let sent = 0;
    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < 3; i += 1) {
        const res = await requestCode('ana@example.com', json, `198.51.${hour}.${i + 1}`);
        if (res.statusCode === 200) sent += 1;
      }
      clock.advance(3_600_000);
    }
    expect(sent).toBe(10);
    clock.set('2026-09-29T01:00:00.000Z');
    expect((await requestCode('ana@example.com', json, '198.51.9.9')).statusCode).toBe(200);
  });

  it('stops every sign-in email past SIGNIN_EMAILS_PER_DAY, and health says so', async () => {
    await core.app.close();
    core = await buildCoreApp(t.db, clock, testConfig({ SIGNIN_EMAILS_PER_DAY: '2' }));
    expect((await requestCode('a@example.com', json, '198.51.100.1')).statusCode).toBe(200);
    expect((await requestCode('b@example.com', json, '198.51.100.2')).statusCode).toBe(200);
    const res = await requestCode('c@example.com', json, '198.51.100.3');
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      code: 'feature_disabled',
      feature: 'emailLogin',
      reason: 'budget',
    });
    expect(core.mailer.sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    const health = (
      await core.app.inject({ method: 'GET', url: '/health' })
    ).json<HealthResponse>();
    expect(health.capabilities.emailLogin).toEqual({ enabled: false, reason: 'budget' });
    expect(health.capabilities.googleLogin.enabled).toBe(true);

    // A new UTC day starts over.
    clock.set('2026-09-29T00:00:01.000Z');
    expect((await requestCode('c@example.com', json, '198.51.100.4')).statusCode).toBe(200);
  });

  it('limits codes per IPv6 /64, not per address inside it', async () => {
    const statuses = [];
    for (let i = 1; i <= 6; i += 1) {
      statuses.push(
        (await requestCode(`user${i}@example.com`, json, `2001:db8:1:2::${i.toString(16)}`))
          .statusCode,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const other = await requestCode('user7@example.com', json, '2001:db8:1:3::1');
    expect(other.statusCode).toBe(200);
  });

  it('refuses malformed addresses before counting them', async () => {
    const res = await requestCode('not-an-address');
    expect(res.statusCode).toBe(400);
    expect(await t.db.select().from(rateCounters)).toHaveLength(0);
  });
});

/** A JWT with Google's claims; the callback only decodes it (it came straight from Google). */
function unsignedIdToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  return [
    part({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }),
    part({
      iss: 'https://accounts.google.com',
      aud: 'test-google-id',
      iat,
      exp: iat + 3600,
      ...claims,
    }),
    'c2lnbmF0dXJl',
  ].join('.');
}

interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

/** Runs the Google sign-in: start, then the callback with Google's token endpoint stubbed. */
async function googleSignIn(claims: GoogleClaims) {
  const start = await core.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: json,
    payload: {
      provider: 'google',
      callbackURL: '/cuenta',
      errorCallbackURL: '/cuenta?error=google',
    },
  });
  expect(start.statusCode).toBe(200);
  const state = new URL(start.json<{ url: string }>().url).searchParams.get('state') ?? '';
  const cookie = [start.headers['set-cookie'] ?? []]
    .flat()
    .map((c) => String(c).split(';')[0])
    .join('; ');
  const realFetch = globalThis.fetch;
  const tokenRequests: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.startsWith('https://oauth2.googleapis.com/token')) {
      tokenRequests.push(target);
      return new Response(
        JSON.stringify({
          access_token: 'google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: unsignedIdToken({ ...claims }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return realFetch(input, init);
  });
  try {
    const res = await core.app.inject({
      method: 'GET',
      url: `/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(tokenRequests).toHaveLength(1);
    const setCookie = [res.headers['set-cookie'] ?? []].flat().join('\n');
    return { res, location: String(res.headers.location ?? ''), setCookie };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('Google sign-in and account linking', () => {
  it('creates an account from a verified Google identity, keeping only the first name', async () => {
    const { location, setCookie } = await googleSignIn({
      sub: 'google-sub-new-0001',
      email: 'Nora@Example.com',
      email_verified: true,
      name: 'Nora García Pérez',
    });
    expect(location).toBe('/cuenta');
    expect(setCookie).toMatch(/centrate\.session_token=/);
    const [u] = await t.db.select().from(user).where(eq(user.email, 'nora@example.com'));
    expect(u?.name).toBe('');
    expect(u?.image).toBeNull();
    const [p] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, u?.id ?? ''));
    expect(p?.displayName).toBe('Nora');
    const [a] = await t.db
      .select()
      .from(account)
      .where(eq(account.userId, u?.id ?? ''));
    expect(a).toMatchObject({ providerId: 'google', accessToken: null, idToken: null });
  });

  it('never links an unverified Google address to an existing account', async () => {
    const { token } = await signIn('ana@example.com');
    const [ana] = await t.db.select().from(user).where(eq(user.email, 'ana@example.com'));
    expect(ana?.emailVerified).toBe(true);

    const { location, setCookie } = await googleSignIn({
      sub: 'google-sub-attacker-01',
      email: 'ana@example.com',
      email_verified: false,
      name: 'Mallory',
    });
    expect(location).toMatch(/^\/cuenta\?error=google&error=account_not_linked$/);
    expect(setCookie).not.toMatch(/centrate\.session_token=[^;]/);
    expect(await t.db.select().from(account)).toHaveLength(0);
    const sessions = await t.db
      .select()
      .from(session)
      .where(eq(session.userId, ana?.id ?? ''));
    expect(sessions.map((s) => s.token)).toEqual([token]);
  });

  it('links a verified Google address to the existing account with that email', async () => {
    await signIn('ana@example.com');
    const [ana] = await t.db.select().from(user).where(eq(user.email, 'ana@example.com'));
    const { location, setCookie } = await googleSignIn({
      sub: 'google-sub-ana-000001',
      email: 'ana@example.com',
      email_verified: true,
    });
    expect(location).toBe('/cuenta');
    const match = setCookie.match(/centrate\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    const me = await core.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: `centrate.session_token=${match?.[1] ?? ''}` },
    });
    expect(me.json<MeResponse>().user.id).toBe(ana?.id);
    const links = await t.db.select().from(account);
    expect(links).toEqual([
      expect.objectContaining({
        userId: ana?.id,
        providerId: 'google',
        accountId: 'google-sub-ana-000001',
      }),
    ]);
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
