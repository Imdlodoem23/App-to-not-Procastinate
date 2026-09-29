/**
 * Floods must not turn into Postgres queries: session lookups sit behind a per-IP gate, unknown
 * routes and /health never look a session up, the 404 handler is rate limited, and /health
 * caches what it reads from the database.
 */
import type { HealthResponse } from '@centrate/shared/cloud-api';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_LOOKUPS_PER_IP_PER_MINUTE } from '../src/app';
import type { SessionResolver } from '../src/context';
import { clientKey, FixedWindowLimiter } from '../src/lib/ip-limit';
import { HEALTH_PER_IP_PER_MINUTE, HEALTH_PROBE_TTL_MS } from '../src/routes/health';
import { buildTestApp, fakeClock } from './helpers/app';
import type { FakeClock } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const bearer = { authorization: 'Bearer made-up-token-made-up-token-0000' };

let t: TestDb;
let clock: FakeClock;
let app: FastifyInstance;
let lookups: number;
let pings: number;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock('2026-09-28T10:00:00.000Z');
  lookups = 0;
  pings = 0;
  const resolveSession: SessionResolver = async () => {
    lookups += 1;
    return null;
  };
  app = await buildTestApp({
    db: t.db,
    clock,
    resolveSession,
    pingDb: async () => {
      pings += 1;
      return true;
    },
  });
  return async () => {
    await app.close();
  };
});

async function hit(url: string, times: number, remoteAddress = '203.0.113.5') {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const res = await app.inject({ method: 'GET', url, headers: bearer, remoteAddress });
    statuses.push(res.statusCode);
  }
  return statuses;
}

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

describe('session lookups', () => {
  it('stop at the per-IP gate, before the database', async () => {
    const statuses = await hit('/v1/me', SESSION_LOOKUPS_PER_IP_PER_MINUTE + 20);
    expect(lookups).toBe(SESSION_LOOKUPS_PER_IP_PER_MINUTE);
    // The route limiter answers 429 from the 121st request on; the gate stops the lookups.
    expect(count(statuses, 401)).toBe(120);
    expect(count(statuses, 429)).toBe(SESSION_LOOKUPS_PER_IP_PER_MINUTE + 20 - 120);

    const gated = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer,
      remoteAddress: '203.0.113.5',
    });
    expect(gated.json().error.code).toBe('rate_limited');
    expect(Number(gated.headers['retry-after'])).toBeGreaterThan(0);

    // Another client is not affected; the same client is again after a minute.
    await hit('/v1/me', 1, '203.0.113.6');
    expect(lookups).toBe(SESSION_LOOKUPS_PER_IP_PER_MINUTE + 1);
    clock.advance(60_000);
    await hit('/v1/me', 1, '203.0.113.5');
    expect(lookups).toBe(SESSION_LOOKUPS_PER_IP_PER_MINUTE + 2);
  });

  it('share one gate across an IPv6 /64', async () => {
    for (let i = 0; i < SESSION_LOOKUPS_PER_IP_PER_MINUTE + 5; i += 1) {
      await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: bearer,
        remoteAddress: `2001:db8:aa:bb:${(i + 1).toString(16)}::1`,
      });
    }
    expect(lookups).toBe(SESSION_LOOKUPS_PER_IP_PER_MINUTE);
  });

  it('never run for unknown routes, which are rate limited too', async () => {
    const statuses = await hit('/nope', 150);
    expect(lookups).toBe(0);
    expect(count(statuses, 404)).toBe(120);
    expect(count(statuses, 429)).toBe(30);
  });

  it('never run for /health', async () => {
    await hit('/health', 10);
    expect(lookups).toBe(0);
  });
});

describe('/health', () => {
  it('reads the database once per cache period, also under concurrent calls', async () => {
    const bodies = await Promise.all(
      Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/health' })),
    );
    expect(bodies.every((r) => r.json<HealthResponse>().db === 'up')).toBe(true);
    expect(pings).toBe(1);
    await hit('/health', 30);
    expect(pings).toBe(1);

    clock.advance(HEALTH_PROBE_TTL_MS);
    const later = await app.inject({ method: 'GET', url: '/health' });
    expect(later.json<HealthResponse>().serverEpoch).toMatch(/^[0-9a-f-]{36}$/);
    expect(pings).toBe(2);
  });

  it('has a generous per-IP limit', async () => {
    const statuses = await hit('/health', HEALTH_PER_IP_PER_MINUTE + 1);
    expect(count(statuses, 200)).toBe(HEALTH_PER_IP_PER_MINUTE);
    expect(statuses.at(-1)).toBe(429);
    expect((await hit('/health', 1, '203.0.113.99'))[0]).toBe(200);
  });
});

describe('clientKey', () => {
  it('keeps IPv4, maps IPv4-in-IPv6 and groups IPv6 by /64', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });
});

describe('FixedWindowLimiter', () => {
  it('counts per key in fixed windows and bounds its memory', () => {
    const limiter = new FixedWindowLimiter(2, 1000, 3);
    expect(limiter.hit('a', 0)).toBe(0);
    expect(limiter.hit('a', 10)).toBe(0);
    expect(limiter.hit('a', 20)).toBe(980);
    expect(limiter.hit('a', 1000)).toBe(0);
    for (const key of ['b', 'c', 'd', 'e']) expect(limiter.hit(key, 1000)).toBe(0);
  });
});
