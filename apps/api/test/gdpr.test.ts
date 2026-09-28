/**
 * GDPR export and erasure, driven by the schema: every table with a column that references a
 * user must be listed in USER_DATA_COVERAGE, show up in the export, and be empty of that user
 * after `DELETE /v1/me`.
 */
import type { CloudExport } from '@centrate/shared/cloud-api';
import { eq, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema';
import { USER_DATA_COVERAGE, otpIdentifiers } from '../src/lib/gdpr';
import { buildTestApp, createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const {
  account,
  accountabilityEvents,
  aiUsage,
  appAuthCodes,
  dailyStats,
  devices,
  friendInvites,
  friendships,
  partnerLinks,
  presence,
  usageCounters,
  user,
  userBlocks,
  verification,
} = schema;

/** Every table and the columns that hold a user id (foreign keys to `user`). */
function userColumns(): Array<{ table: PgTable; name: string; columns: string[] }> {
  const out: Array<{ table: PgTable; name: string; columns: string[] }> = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const columns = config.foreignKeys.flatMap((fk) => {
      const ref = fk.reference();
      return getTableConfig(ref.foreignTable).name === 'user' ? ref.columns.map((c) => c.name) : [];
    });
    // A `user_id` column without a foreign key still holds a user id.
    for (const col of config.columns) {
      if (col.name === 'user_id' && !columns.includes('user_id')) columns.push('user_id');
    }
    if (config.name === 'user') columns.push('id');
    out.push({ table: value, name: config.name, columns });
  }
  return out;
}

let t: TestDb;
let clock: FakeClock;
let app: FastifyInstance;
let a: TestUser;
let b: TestUser;
let c: TestUser;

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
  const now = clock.now();
  a = await createTestUser(t.db, { now, email: 'ana@example.com', displayName: 'Ana' });
  b = await createTestUser(t.db, { now, email: 'bea@example.com', displayName: 'Bea' });
  c = await createTestUser(t.db, { now, email: 'carla@example.com', displayName: 'Carla' });
  return async () => {
    await app.close();
  };
});

/** One or more rows about Ana in every table that can hold data about a user. */
async function populate(): Promise<Record<string, string>> {
  const now = clock.now();
  const later = new Date(now.getTime() + 3_600_000);
  await t.db.insert(account).values({
    id: 'acc-ana-000000000000000000000000',
    accountId: 'google-subject-123456789',
    providerId: 'google',
    userId: a.userId,
  });
  await t.db.insert(verification).values({
    id: 'ver-ana-000000000000000000000000',
    identifier: otpIdentifiers('ana@example.com')[0] ?? '',
    value: 'hashed-code:0',
    expiresAt: later,
  });
  await t.db.insert(appAuthCodes).values({
    codeHash: 'code-hash-secret-value-0000000000',
    userId: a.userId,
    challenge: 'c'.repeat(43),
    port: 50_000,
    expiresAt: later,
  });
  const [device] = await t.db
    .insert(devices)
    .values({
      userId: a.userId,
      installId: 'install-ana-000000001',
      sessionId: a.sessionId,
      name: 'Portátil',
      platform: 'win',
      appVersion: '1.0.0',
    })
    .returning();
  await t.db.insert(dailyStats).values({
    deviceId: device?.id ?? '',
    userId: a.userId,
    day: '2026-09-27',
    rev: 5,
    focusMinutes: 90,
    studyMinutes: 30,
    blocksCompleted: 2,
    studySessions: 1,
    attempts: 4,
    emergencyUnlocks: 0,
    punishments: 0,
    pointsEarned: 40,
    pointsLost: 5,
  });
  await t.db.insert(friendInvites).values({
    inviterId: a.userId,
    codeHash: 'invite-hash-secret-value-00000000',
    expiresAt: later,
  });
  await t.db.insert(friendships).values([
    { userId: a.userId, friendId: b.userId },
    { userId: b.userId, friendId: a.userId },
  ]);
  await t.db.insert(userBlocks).values({ blockerId: a.userId, blockedId: c.userId });
  await t.db
    .insert(presence)
    .values({ userId: a.userId, state: 'study', since: now, endsAt: later, expiresAt: later });
  await t.db.insert(partnerLinks).values([
    { ownerId: a.userId, partnerId: b.userId, status: 'active', requireApproval: true },
    { ownerId: b.userId, partnerId: a.userId, status: 'active', requireApproval: false },
  ]);
  await t.db.insert(accountabilityEvents).values([
    {
      ownerId: a.userId,
      clientRef: 'client-ref-ana-0000001',
      kind: 'emergency_requested',
      occurredAt: now,
      approvalStatus: 'pending',
      approvalDeadline: later,
    },
    {
      ownerId: b.userId,
      clientRef: 'client-ref-bea-0000001',
      kind: 'emergency_requested',
      occurredAt: now,
      approvalStatus: 'denied',
      approvalDeadline: later,
      decidedBy: a.userId,
      decidedAt: now,
      note: 'Aguanta un poco más',
    },
  ]);
  await t.db.insert(usageCounters).values({
    userId: a.userId,
    day: '2026-09-28',
    key: 'partner_email',
    count: 2,
  });
  await t.db.insert(aiUsage).values({
    userId: a.userId,
    day: '2026-09-28',
    feature: 'coach',
    requests: 1,
    inputTokens: 1000,
    outputTokens: 200,
  });
  return { deviceId: device?.id ?? '' };
}

describe('coverage', () => {
  it('lists every table that holds data about a user', () => {
    const tables = userColumns();
    const withUserData = tables.filter((x) => x.columns.length > 0).map((x) => x.name);
    // verification has no user column: better-auth keys the codes by email.
    expect(Object.keys(USER_DATA_COVERAGE).sort()).toEqual(
      [...withUserData, 'verification'].sort(),
    );
    const names = tables.map((x) => x.name);
    for (const name of Object.keys(USER_DATA_COVERAGE)) expect(names).toContain(name);
  });
});

describe('GET /v1/me/export', () => {
  it('contains every kind of row, and nobody else’s email, tokens or hashes', async () => {
    const { deviceId } = await populate();
    const res = await app.inject({ method: 'GET', url: '/v1/me/export', headers: a.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="centrate-datos.json"');
    const data = res.json<CloudExport>();
    expect(data.schemaVersion).toBe(1);
    expect(data.me.user.email).toBe('ana@example.com');
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) expect(value.length, key).toBeGreaterThan(0);
    }
    expect(data.presence).toMatchObject({ state: 'study' });
    expect(data.loginMethods).toEqual([{ provider: 'google', createdAt: expect.any(String) }]);
    expect(data.sessions).toEqual([
      { createdAt: expect.any(String), expiresAt: expect.any(String), current: true },
    ]);
    expect(data.devices[0]).toMatchObject({ id: deviceId, current: true });
    expect(data.dailyStats[0]).toMatchObject({ deviceId, day: '2026-09-27', focusMinutes: 90 });
    expect(data.friends).toEqual([
      { userId: b.userId, displayName: 'Bea', since: expect.any(String) },
    ]);
    expect(data.blocks).toEqual([
      { userId: c.userId, displayName: 'Carla', createdAt: expect.any(String) },
    ]);
    expect(data.partnerLinks.map((l) => l.role).sort()).toEqual(['owner', 'partner']);
    expect(data.approvalDecisions).toEqual([
      expect.objectContaining({ decision: 'denied', note: 'Aguanta un poco más' }),
    ]);
    expect(data.usageCounters).toEqual([{ day: '2026-09-28', key: 'partner_email', count: 2 }]);

    for (const secret of [
      'bea@example.com',
      'carla@example.com',
      a.token,
      a.sessionId,
      'code-hash-secret-value',
      'invite-hash-secret-value',
      'google-subject-123456789',
      'hashed-code',
    ]) {
      expect(res.body, secret).not.toContain(secret);
    }
  });
});

describe('DELETE /v1/me', () => {
  it('leaves no row about the user in any table', async () => {
    await populate();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: a.headers,
      payload: { confirm: 'BORRAR' },
    });
    expect(res.statusCode).toBe(204);

    for (const { table, name, columns } of userColumns()) {
      if (columns.length === 0) continue;
      const rows = (await t.db.select().from(table)) as Array<Record<string, unknown>>;
      const about = rows.filter((row) => Object.values(row).includes(a.userId));
      expect(about, name).toHaveLength(0);
    }
    const codes = await t.db.select().from(verification);
    expect(codes).toHaveLength(0);

    // Bea keeps her account and her event; Ana's decision on it is anonymised.
    expect(await t.db.select().from(user).where(eq(user.id, b.userId))).toHaveLength(1);
    const [event] = await t.db
      .select()
      .from(accountabilityEvents)
      .where(eq(accountabilityEvents.ownerId, b.userId));
    expect(event?.decidedBy).toBeNull();
    expect(event?.approvalStatus).toBe('denied');
  });
});
