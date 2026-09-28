/**
 * Retention sweep: what is old goes, what is recent stays (docs/API.md §6).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readMeta } from '../src/db/meta';
import {
  accountabilityEvents,
  aiGlobalDaily,
  aiUsage,
  appAuthCodes,
  dailyStats,
  devices,
  friendInvites,
  partnerLinks,
  presence,
  session,
  usageCounters,
  verification,
} from '../src/db/schema';
import { runJanitor, startJanitor } from '../src/jobs/janitor';
import { createTestUser } from './helpers/app';
import type { TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const NOW = new Date('2026-09-28T10:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

let t: TestDb;
let a: TestUser;
let b: TestUser;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  a = await createTestUser(t.db, { now: NOW });
  b = await createTestUser(t.db, { now: NOW });
});

const stats = (deviceId: string, userId: string, day: string) => ({
  deviceId,
  userId,
  day,
  rev: 1,
  focusMinutes: 1,
  studyMinutes: 0,
  blocksCompleted: 0,
  studySessions: 0,
  attempts: 0,
  emergencyUnlocks: 0,
  punishments: 0,
  pointsEarned: 0,
  pointsLost: 0,
});

describe('runJanitor', () => {
  it('deletes expired and old rows and keeps the rest', async () => {
    const db = t.db;
    await db.insert(presence).values([
      { userId: a.userId, state: 'focus', since: at(-1), endsAt: null, expiresAt: at(-0.001) },
      { userId: b.userId, state: 'focus', since: at(-1), endsAt: null, expiresAt: at(0.001) },
    ]);
    await db.insert(appAuthCodes).values([
      { codeHash: 'old', userId: a.userId, challenge: 'x', port: 5000, expiresAt: at(-0.001) },
      { codeHash: 'new', userId: a.userId, challenge: 'x', port: 5000, expiresAt: at(0.001) },
    ]);
    await db.insert(verification).values([
      { id: 'v-old', identifier: 'sign-in-otp-a@x', value: 'h', expiresAt: at(-0.001) },
      { id: 'v-new', identifier: 'sign-in-otp-b@x', value: 'h', expiresAt: at(0.001) },
    ]);
    await db.insert(session).values({
      id: 'expired-session',
      token: 'expired-session-token-000000000',
      userId: a.userId,
      expiresAt: at(-1),
    });
    await db.insert(friendInvites).values([
      { inviterId: a.userId, codeHash: 'i-old', expiresAt: at(-31), createdAt: at(-38) },
      { inviterId: a.userId, codeHash: 'i-recent', expiresAt: at(-29), createdAt: at(-36) },
      { inviterId: a.userId, codeHash: 'i-live', expiresAt: at(3), createdAt: at(-4) },
    ]);
    const c = await createTestUser(db, { now: NOW });
    const [ended, cooling, offDue, offLater] = await db
      .insert(partnerLinks)
      .values([
        { ownerId: a.userId, partnerId: b.userId, status: 'active', endsAt: at(-0.001) },
        { ownerId: b.userId, partnerId: a.userId, status: 'active', endsAt: at(0.5) },
        {
          ownerId: c.userId,
          partnerId: a.userId,
          status: 'active',
          requireApproval: true,
          approvalOffAt: at(-0.001),
        },
        {
          ownerId: c.userId,
          partnerId: b.userId,
          status: 'active',
          requireApproval: true,
          approvalOffAt: at(0.5),
        },
      ])
      .returning();
    await db.insert(accountabilityEvents).values([
      {
        ownerId: a.userId,
        clientRef: 'old-event-0000000001',
        kind: 'study_abandoned',
        occurredAt: at(-31),
        createdAt: at(-31),
      },
      {
        ownerId: a.userId,
        clientRef: 'new-event-0000000001',
        kind: 'study_abandoned',
        occurredAt: at(-29),
        createdAt: at(-29),
      },
    ]);
    await db.insert(usageCounters).values([
      { userId: a.userId, day: '2026-09-20', key: 'partner_email', count: 1 },
      { userId: a.userId, day: '2026-09-21', key: 'partner_email', count: 1 },
    ]);
    await db.insert(aiUsage).values([
      { userId: a.userId, day: '2026-06-29', feature: 'coach' },
      { userId: a.userId, day: '2026-06-30', feature: 'coach' },
    ]);
    await db.insert(aiGlobalDaily).values([{ day: '2026-06-29' }, { day: '2026-06-30' }]);
    const [device] = await db
      .insert(devices)
      .values({
        userId: a.userId,
        installId: 'install-janitor-000001',
        name: 'PC',
        platform: 'linux',
        appVersion: '1.0.0',
      })
      .returning();
    await db
      .insert(dailyStats)
      .values([
        stats(device?.id ?? '', a.userId, '2024-09-26'),
        stats(device?.id ?? '', a.userId, '2024-09-27'),
      ]);

    const report = await runJanitor(db, NOW);
    expect(report).toEqual({
      presence: 1,
      appAuthCodes: 1,
      verification: 1,
      sessions: 1,
      invites: 1,
      partnerLinksEnded: 1,
      partnerApprovalOff: 1,
      accountabilityEvents: 1,
      usageCounters: 1,
      aiUsage: 1,
      aiGlobalDaily: 1,
      dailyStats: 1,
    });

    expect((await db.select().from(presence)).map((r) => r.userId)).toEqual([b.userId]);
    expect((await db.select().from(appAuthCodes)).map((r) => r.codeHash)).toEqual(['new']);
    expect((await db.select().from(verification)).map((r) => r.id)).toEqual(['v-new']);
    expect(await db.select().from(session).where(eq(session.id, 'expired-session'))).toEqual([]);
    expect((await db.select().from(friendInvites)).map((r) => r.codeHash).sort()).toEqual([
      'i-live',
      'i-recent',
    ]);
    const links = await db.select().from(partnerLinks);
    expect(links.map((l) => l.id)).not.toContain(ended?.id);
    expect(links.map((l) => l.id)).toContain(cooling?.id);
    const off = links.find((l) => l.id === offDue?.id);
    expect(off).toMatchObject({ requireApproval: false, approvalOffAt: null });
    const later = links.find((l) => l.id === offLater?.id);
    expect(later?.requireApproval).toBe(true);
    expect((await db.select().from(accountabilityEvents)).map((e) => e.clientRef)).toEqual([
      'new-event-0000000001',
    ]);
    expect((await db.select().from(usageCounters)).map((r) => r.day)).toEqual(['2026-09-21']);
    expect((await db.select().from(aiUsage)).map((r) => r.day)).toEqual(['2026-06-30']);
    expect((await db.select().from(aiGlobalDaily)).map((r) => r.day)).toEqual(['2026-06-30']);
    expect((await db.select().from(dailyStats)).map((r) => r.day)).toEqual(['2024-09-27']);
    expect(await readMeta(db, 'janitor_last_run')).toBe(NOW.toISOString());
    // Live sessions stay.
    expect(await db.select().from(session).where(eq(session.id, a.sessionId))).toHaveLength(1);
  });

  it('runs at start and on demand without throwing', async () => {
    const logs: string[] = [];
    const handle = startJanitor(t.db, {
      now: () => NOW,
      intervalMs: 3_600_000,
      log: { info: (_o, m) => logs.push(m), warn: (_o, m) => logs.push(m) },
    });
    const report = await handle.runOnce();
    handle.stop();
    expect(report).not.toBeNull();
    expect(logs).toContain('janitor sweep');
  });
});
