import type { HealthResponse } from '@centrate/shared/cloud-api';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { buildTestApp, createTestUser, testConfig } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';

describe('without a database (the app must work without the cloud)', () => {
  it('answers /health and lists every feature as off', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthResponse>();
    expect(body.ok).toBe(true);
    expect(body.db).toBe('unconfigured');
    expect(body.serverEpoch).toBeNull();
    expect(body.capabilities.accounts).toEqual({ enabled: false, reason: 'missing_key' });
    expect(body.capabilities.coach).toEqual({ enabled: false, reason: 'missing_key' });
    await app.close();
  });

  it('answers /v1 routes with 503 feature_disabled', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: {
        code: 'feature_disabled',
        message: expect.any(String),
        feature: 'accounts',
        reason: 'missing_key',
      },
    });
    await app.close();
  });
});

describe('with a database', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it('reports db up, the server epoch and never a secret', async () => {
    const config = testConfig({ ANTHROPIC_API_KEY: 'sk-test-never-shown' });
    const app = await buildTestApp({ db: t.db, config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json<HealthResponse>();
    expect(body.db).toBe('up');
    expect(body.serverEpoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.capabilities.accounts.enabled).toBe(true);
    expect(body.capabilities.coach.enabled).toBe(true);
    expect(res.body).not.toContain('sk-test-never-shown');
    expect(res.body).not.toContain(config.auth?.secret ?? '-');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    await app.close();
  });

  it('uses the error envelope for unknown routes', async () => {
    const app = await buildTestApp({ db: t.db });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'No such route' } });
    await app.close();
  });

  it('resolves test bearer sessions and rejects malformed JSON with 400', async () => {
    const app = await buildTestApp({ db: t.db });
    const u = await createTestUser(t.db);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/presence',
      headers: { ...u.headers, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    await app.close();
  });

  it('logs one minimal line per request, without tokens, emails or IPs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const u = await createTestUser(t.db, { email: 'secret-person@example.com' });
    const app = await buildTestApp({ db: t.db, logger: { stream } });
    await app.inject({
      method: 'GET',
      url: '/v1/friends/invites/ABCDE-FGHJK?email=secret-person@example.com',
      headers: { ...u.headers, 'x-forwarded-for': '203.0.113.9' },
    });
    const log = lines.join('\n');
    expect(log).toContain('"route":"/v1/friends/invites/:code"');
    expect(log).not.toContain(u.token);
    expect(log).not.toContain('secret-person');
    expect(log).not.toContain('ABCDE');
    expect(log).not.toContain('203.0.113.9');
    await app.close();
  });
});
