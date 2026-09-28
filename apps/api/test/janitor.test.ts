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
  rateCounters,
  session,
  usageCounters,
  user,
  verification,
} from '../src/db/schema';
import { DEAD_AI_HOLD_AFTER_MS, runJanitor, startJanitor } from '../src/jobs/janitor';
import { reserve } from '../src/coach/quota';
import { createTestUser, testConfig } from './helpers/app';
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
    await db.insert(rateCounters).values([
      { key: 'signin_email:global', windowStart: at(-1), count: 3, expiresAt: at(0) },
      { key: 'signin_email:global', windowStart: at(0), count: 1, expiresAt: at(1) },
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

    // A sign-up whose hook stopped after the profile: the name is cleared. Without a profile
    // the name still has to seed the display name, so it stays.
    await db.update(user).set({ name: 'Ana' }).where(eq(user.id, a.userId));
    await db.insert(user).values({ id: 'no-profile-user', name: 'Luis', email: 'l@example.com' });

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
      rateCounters: 1,
      aiUsage: 1,
      aiGlobalDaily: 1,
      aiDeadHolds: 0,
      dailyStats: 1,
      userNames: 1,
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
    expect((await db.select().from(rateCounters)).map((r) => r.expiresAt)).toEqual([at(1)]);
    expect((await db.select().from(aiUsage)).map((r) => r.day)).toEqual(['2026-06-30']);
    expect((await db.select().from(aiGlobalDaily)).map((r) => r.day)).toEqual(['2026-06-30']);
    expect((await db.select().from(dailyStats)).map((r) => r.day)).toEqual(['2024-09-27']);
    expect(await readMeta(db, 'janitor_last_run')).toBe(NOW.toISOString());
    const names = await db.select({ id: user.id, name: user.name }).from(user);
    expect(names.find((u) => u.id === a.userId)?.name).toBe('');
    expect(names.find((u) => u.id === 'no-profile-user')?.name).toBe('Luis');
    // Live sessions stay.
    expect(await db.select().from(session).where(eq(session.id, a.sessionId))).toHaveLength(1);
  });

  it('frees the quota holds of coach calls whose process died, and only those', async () => {
    const db = t.db;
    const c = await createTestUser(db, { now: NOW });
    const d = await createTestUser(db, { now: NOW });
    const today = '2026-09-28';
    const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
    const held = (
      userId: string,
      feature: 'coach' | 'interpret',
      micro: number,
      until: Date | null,
    ) => ({
      userId,
      day: today,
      feature,
      requests: 2,
      inputTokens: 1000,
      outputTokens: 500,
      costMicroUsd: 50_000,
      reservedTokens: 20_000,
      reservedMicroUsd: micro,
      reservedUntil: until,
    });
    await db.insert(aiUsage).values([
      // Dead: its deadline passed long ago (the process died mid-call).
      held(a.userId, 'coach', 400_000, minutes(-11)),
      // Dead: a later call on the same row settled and cleared `reserved_until`.
      held(b.userId, 'coach', 250_000, null),
      // In flight, or only just past its hold: left alone.
      held(c.userId, 'coach', 300_000, minutes(1)),
      held(d.userId, 'interpret', 10_000, minutes(-5)),
      // Settled rows: nothing held.
      { ...held(d.userId, 'coach', 0, null), reservedTokens: 0 },
    ]);
    await db.insert(aiGlobalDaily).values({
      day: today,
      requests: 8,
      costMicroUsd: 200_000,
      reservedMicroUsd: 960_000,
    });

    // Before the sweep the dead hold blocks the user for the rest of the day.
    const config = testConfig({ ANTHROPIC_API_KEY: 'test-key' });
    const call = (userId: string) =>
      reserve(db, config, {
        userId,
        feature: 'coach',
        now: NOW,
        tokens: 30_000,
        costMicroUsd: 250_000,
        holdMs: 60_000,
      });
    expect(await call(a.userId)).toMatchObject({ ok: false, reason: 'quota' });

    const report = await runJanitor(db, NOW);
    expect(report?.aiDeadHolds).toBe(2);

    const rows = await db.select().from(aiUsage);
    const row = (userId: string, feature = 'coach') =>
      rows.find((r) => r.userId === userId && r.feature === feature);
    for (const freed of [row(a.userId), row(b.userId)]) {
      // The hold is given back; the request, the tokens and the cost already booked stay.
      expect(freed).toMatchObject({
        requests: 2,
        inputTokens: 1000,
        outputTokens: 500,
        costMicroUsd: 50_000,
        reservedTokens: 0,
        reservedMicroUsd: 0,
        reservedUntil: null,
      });
    }
    expect(row(c.userId)).toMatchObject({ reservedMicroUsd: 300_000, reservedUntil: minutes(1) });
    expect(row(d.userId, 'interpret')).toMatchObject({
      reservedMicroUsd: 10_000,
      reservedUntil: minutes(-5),
    });
    // The global budget books the dead holds as spent (what the provider billed is unknown).
    const [global] = await db.select().from(aiGlobalDaily);
    expect(global).toMatchObject({
      requests: 8,
      costMicroUsd: 200_000 + 400_000 + 250_000,
      reservedMicroUsd: 960_000 - 400_000 - 250_000,
    });

    // The user whose call died can use the coach again the same day; a call in flight still
    // blocks a second one.
    expect((await call(a.userId)).ok).toBe(true);
    expect(await call(c.userId)).toMatchObject({ ok: false, reason: 'busy' });

    // A second sweep finds nothing more to free (the new reservation is in flight).
    expect((await runJanitor(db, NOW))?.aiDeadHolds).toBe(0);
    expect(DEAD_AI_HOLD_AFTER_MS).toBeGreaterThanOrEqual(5 * 60_000);
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
