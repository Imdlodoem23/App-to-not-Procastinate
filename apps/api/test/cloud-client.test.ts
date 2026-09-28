/**
 * The shared typed client and offline outbox (packages/shared/src/cloud-api.ts) against the
 * real app, through a fetch adapter over `app.inject`: every method hits the route it names,
 * errors map to the right `CloudError`, and the outbox's replays are idempotent on the server.
 */
import type { CloudDayStats, CloudFetch, CloudClient } from '@centrate/shared/cloud-api';
import {
  CLOUD_TIMEOUTS,
  CloudError,
  addDays,
  approvalOutcome,
  createCloudClient,
  createOutbox,
  daysToReupload,
  memoryOutboxStorage,
  newClientRef,
} from '@centrate/shared/cloud-api';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { ENDPOINTS } from '../src/coach/service';
import { loadConfig } from '../src/config';
import { accountabilityEvents, dailyStats, devices } from '../src/db/schema';
import { buildTestApp, createTestUser, fakeClock, testConfig } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { fakeCoachModel, ok } from './helpers/coach';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { befriend, linkPartners } from './helpers/social';

const BASE = 'https://centrate-api.example.com';
const NOW = '2026-09-28T10:00:00.000Z';
const TODAY = '2026-09-28';

/** `fetch` over `app.inject`: the client runs unchanged against the in-process app. */
function injectFetch(app: FastifyInstance): CloudFetch {
  return async (url, init) => {
    const target = new URL(url);
    expect(target.origin).toBe(BASE);
    const res = await app.inject({
      method: init.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: `${target.pathname}${target.search}`,
      headers: init.headers,
      ...(init.body === undefined ? {} : { payload: init.body }),
    });
    return {
      status: res.statusCode,
      headers: {
        get: (name: string) => {
          const value = res.headers[name.toLowerCase()];
          if (value === undefined) return null;
          return Array.isArray(value) ? value.join(', ') : String(value);
        },
      },
      text: async () => res.body,
    };
  };
}

function clientFor(
  app: FastifyInstance,
  token: string | null,
  onUnauthorized?: () => void,
): CloudClient {
  return createCloudClient({
    baseUrl: BASE,
    getToken: () => token,
    fetch: injectFetch(app),
    ...(onUnauthorized ? { onUnauthorized } : {}),
  });
}

async function failure(promise: Promise<unknown>): Promise<CloudError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudError);
    return error as CloudError;
  }
  throw new Error('expected the call to fail');
}

function stats(day: string, rev: number, focusMinutes = 60): CloudDayStats {
  return {
    day,
    rev,
    focusMinutes,
    studyMinutes: Math.floor(focusMinutes / 2),
    blocksCompleted: 1,
    studySessions: 1,
    attempts: 2,
    emergencyUnlocks: 0,
    punishments: 0,
    pointsEarned: 40,
    pointsLost: 10,
  };
}

describe('without a database', () => {
  it('reports every feature off and answers feature_disabled, not retryable', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    const c = clientFor(app, 'any-token');
    const health = await c.health();
    expect(health.db).toBe('unconfigured');
    expect(health.capabilities.accounts).toEqual({ enabled: false, reason: 'missing_key' });
    const error = await failure(c.getMe());
    expect(error).toMatchObject({
      kind: 'http',
      status: 503,
      code: 'feature_disabled',
      retryable: false,
    });
    expect(error.details).toMatchObject({ feature: 'accounts', reason: 'missing_key' });
    await app.close();
  });
});

describe('with the real app', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let ana: TestUser;
  let deviceId: string;
  let c: CloudClient;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    clock = fakeClock(NOW);
    app = await buildTestApp({ db: t.db, clock });
    ana = await createTestUser(t.db, { now: clock.now(), displayName: 'Ana' });
    const [row] = await t.db
      .insert(devices)
      .values({
        userId: ana.userId,
        installId: 'install-ana-0000000001',
        sessionId: ana.sessionId,
        name: 'Portátil',
        platform: 'win',
        appVersion: '1.0.0',
      })
      .returning({ id: devices.id });
    deviceId = row?.id ?? '';
    c = clientFor(app, ana.token);
    return async () => {
      await app.close();
    };
  });

  it('reads health, the account and the devices', async () => {
    const health = await c.health();
    expect(health).toMatchObject({ ok: true, db: 'up' });
    expect(health.serverEpoch).toEqual(expect.any(String));
    expect(health.capabilities.sync.enabled).toBe(true);
    expect(health.capabilities.coach).toEqual({ enabled: false, reason: 'missing_key' });

    const me = await c.getMe();
    expect(me.profile.displayName).toBe('Ana');
    expect(me.sharing.syncStats).toBe(false);
    const updated = await c.updateMe({ sharing: { syncStats: true, ranking: true } });
    expect(updated.sharing).toMatchObject({ syncStats: true, ranking: true });

    const { devices: list } = await c.listDevices();
    expect(list).toEqual([expect.objectContaining({ id: deviceId, current: true })]);
    const renamed = await c.renameDevice(deviceId, 'Sobremesa');
    expect(renamed.name).toBe('Sobremesa');
  });

  it('uploads a backfill through the outbox and reads it back', async () => {
    await c.updateMe({ sharing: { syncStats: true } });
    const outbox = createOutbox({ storage: memoryOutboxStorage(), client: c, now: clock.now });
    const local = Array.from({ length: 250 }, (_, i) => stats(addDays(TODAY, i - 249), 10 + i));
    await outbox.addDays(deviceId, local);
    const putDays = vi.spyOn(c, 'putDays');

    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 250, dropped: 0, remaining: 0 });
    expect(putDays.mock.calls.map(([body]) => body.days.length)).toEqual([100, 100, 50]);

    const read = await c.getStats(addDays(TODAY, -249), TODAY);
    expect(read.days).toHaveLength(250);
    expect(read.days[0]).toMatchObject({ day: addDays(TODAY, -249), focusMinutes: 60 });

    // A replay of the same revs changes nothing; an older rev comes back stale and leaves
    // the queue; the server keeps the higher one.
    await outbox.addDays(deviceId, [stats(TODAY, 259), stats(addDays(TODAY, -1), 1, 5)]);
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 2, remaining: 0 });
    const state = await c.getSyncState(deviceId);
    expect(state.revs).toHaveLength(250);
    expect(state.revs.find((r) => r.day === addDays(TODAY, -1))?.rev).toBe(258);

    // After a cloud reset, only what the server lacks goes up again.
    const newer = [...local.slice(0, 249), stats(TODAY, 400)];
    expect(daysToReupload(newer, state).map((d) => d.day)).toEqual([TODAY]);
  });

  it('maps consent, validation and not-found answers', async () => {
    const consent = await failure(c.putDays({ deviceId, days: [stats(TODAY, 1)] }));
    expect(consent).toMatchObject({ status: 403, code: 'consent_required', retryable: false });
    expect(consent.details?.consent).toBe('syncStats');

    const range = await failure(c.getStats(TODAY, addDays(TODAY, -3)));
    expect(range).toMatchObject({ status: 400, code: 'validation_failed', retryable: false });
    expect(range.details?.issues?.length).toBeGreaterThan(0);

    const missing = await failure(c.getAccountabilityEvent('00000000-0000-4000-8000-000000000000'));
    expect(missing).toMatchObject({ status: 404, code: 'not_found' });

    // The outbox drops what the server refuses for good (sync turned off).
    const outbox = createOutbox({ storage: memoryOutboxStorage(), client: c, now: clock.now });
    await outbox.addDays(deviceId, [stats(TODAY, 1)]);
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 0, dropped: 1 });
  });

  it('drops only the days outside the window', async () => {
    await c.updateMe({ sharing: { syncStats: true } });
    const outbox = createOutbox({ storage: memoryOutboxStorage(), client: c, now: clock.now });
    await outbox.addDays(deviceId, [
      stats(addDays(TODAY, -401), 1),
      stats(addDays(TODAY, -1), 1),
      stats(addDays(TODAY, 5), 1),
      stats(TODAY, 1),
    ]);
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 2, dropped: 2 });
    const rows = await t.db.select({ day: dailyStats.day }).from(dailyStats);
    expect(rows.map((r) => r.day).sort()).toEqual([addDays(TODAY, -1), TODAY]);
  });

  it('signs out on 401 and empties the outbox', async () => {
    const onUnauthorized = vi.fn();
    const stale = clientFor(app, 'revoked-token', onUnauthorized);
    const error = await failure(stale.getMe());
    expect(error.isUnauthorized).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    const outbox = createOutbox({ storage: memoryOutboxStorage(), client: stale, now: clock.now });
    await outbox.addDays(deviceId, [stats(TODAY, 1)]);
    expect(await outbox.flush()).toMatchObject({ status: 'signed_out', remaining: 0 });

    await c.logout();
    expect((await failure(c.getMe())).isUnauthorized).toBe(true);
  });

  it('makes friends with an invite code', async () => {
    const bea = await createTestUser(t.db, { now: clock.now(), displayName: 'Bea' });
    const cb = clientFor(app, bea.token);
    const invite = await c.createInvite({ maxUses: 1 });
    expect(invite.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect((await c.listInvites()).invites).toHaveLength(1);

    expect(await cb.previewInvite(invite.code)).toEqual({ inviter: { displayName: 'Ana' } });
    const typed = ` ${invite.code.toLowerCase().replace('-', ' ')} `;
    const accepted = await cb.acceptInvite(typed);
    expect(accepted.friend).toMatchObject({ userId: ana.userId, displayName: 'Ana' });
    expect((await c.listFriends()).friends.map((f) => f.displayName)).toEqual(['Bea']);

    const gone = await failure(cb.previewInvite(invite.code));
    expect(gone).toMatchObject({ status: 404, code: 'not_found' });
    await c.removeFriend(bea.userId);
    expect((await cb.listFriends()).friends).toEqual([]);
  });

  it('runs an approval end to end and replays events idempotently', async () => {
    const bea = await createTestUser(t.db, { now: clock.now(), displayName: 'Bea' });
    const cb = clientFor(app, bea.token);
    await befriend(t.db, ana, bea, new Date('2026-09-01T00:00:00.000Z'));
    await linkPartners(t.db, ana, bea, {
      requireApproval: true,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });

    const request = {
      clientRef: newClientRef(),
      kind: 'emergency_requested' as const,
      occurredAt: NOW,
      countdownEndsAt: new Date(clock.now().getTime() + 10 * 60_000).toISOString(),
    };
    const first = await c.postAccountabilityEvent(request);
    expect(first.approval?.status).toBe('pending');
    const replay = await c.postAccountabilityEvent(request);
    expect(replay.eventId).toBe(first.eventId);

    // The outbox may send it again after a lost answer: still one event.
    const outbox = createOutbox({ storage: memoryOutboxStorage(), client: c, now: clock.now });
    await outbox.addEvent(request);
    await outbox.addEvent(request);
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1 });
    const [{ n } = { n: 0 }] = await t.db
      .select({ n: count() })
      .from(accountabilityEvents)
      .where(eq(accountabilityEvents.ownerId, ana.userId));
    expect(n).toBe(1);

    const owned = await c.getAccountabilityEvent(first.eventId);
    expect(approvalOutcome(owned.approval, clock.now())).toBe('wait');

    const inbox = await cb.getInbox();
    expect(inbox.items).toEqual([
      expect.objectContaining({ eventId: first.eventId, kind: 'emergency_requested' }),
    ]);
    const decided = await cb.decideApproval(first.eventId, { decision: 'deny', note: 'Tú puedes' });
    expect(decided.status).toBe('denied');
    const again = await failure(
      cb.decideApproval(first.eventId, { decision: 'approve', note: null }),
    );
    expect(again).toMatchObject({ status: 409, code: 'already_decided', retryable: false });

    const polled = await c.getAccountabilityEvent(first.eventId);
    expect(approvalOutcome(polled.approval, clock.now())).toBe('denied');
    expect(polled.approval?.note).toBe('Tú puedes');

    // Removing an active partner as the owner waits 24 hours.
    const { links } = await c.listPartners();
    const ending = await c.removePartner(links[0]?.id ?? '');
    expect(ending?.endsAt).toEqual(expect.any(String));
  });

  it('removes a pending partner at once', async () => {
    const bea = await createTestUser(t.db, { now: clock.now(), displayName: 'Bea' });
    await befriend(t.db, ana, bea);
    const link = await c.proposePartner({ friendId: bea.userId, requireApproval: false });
    expect(link).toMatchObject({ status: 'pending', role: 'owner' });
    await expect(c.removePartner(link.id)).resolves.toBeNull();
  });

  it('reports the coach as disabled without its key', async () => {
    const error = await failure(c.getCoachQuota());
    expect(error).toMatchObject({ status: 503, code: 'feature_disabled', retryable: false });
    expect(error.details).toMatchObject({ feature: 'coach', reason: 'missing_key' });
  });

  it('exports and deletes the account', async () => {
    const data = await c.exportData();
    expect(data.me.user.id).toBe(ana.userId);
    expect(data.devices).toHaveLength(1);
    await c.deleteAccount();
    expect((await failure(c.getMe())).isUnauthorized).toBe(true);
  });
  it('wakes the server once, then calls the coach directly', async () => {
    const model = fakeCoachModel(() =>
      ok({
        steps: [
          { title: 'Leer el enunciado', minutes: 10, suggestedPhrase: null },
          { title: 'Hacer un esquema', minutes: 25, suggestedPhrase: null },
        ],
        firstStepTip: 'Empieza leyendo solo el primer párrafo.',
      }),
    );
    const coachApp = await buildTestApp({
      db: t.db,
      clock,
      config: testConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-client-0000' }),
      coachModel: model,
    });
    await c.updateMe({ sharing: { coach: true } });
    const inject = injectFetch(coachApp);
    const paths: string[] = [];
    const coach = createCloudClient({
      baseUrl: BASE,
      getToken: () => ana.token,
      fetch: (url, init) => {
        paths.push(new URL(url).pathname);
        return inject(url, init);
      },
      now: clock.now,
    });
    const onWaking = vi.fn();
    const body = { task: 'Trabajo de historia', context: null, minutesAvailable: 45 };

    try {
      expect((await coach.splitTask(body, { onWaking })).steps).toHaveLength(2);
      await coach.splitTask(body, { onWaking });
      expect(paths).toEqual(['/health', '/v1/coach/split-task', '/v1/coach/split-task']);
      expect(onWaking).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    } finally {
      await coachApp.close();
    }
  });
});

describe('coach calls from the client', () => {
  it('waits longer for a coach answer than the longest server deadline', () => {
    // The client wakes the server first, so the coach timeout only has to cover the call.
    const longest = Math.max(...Object.values(ENDPOINTS).map((e) => e.deadlineMs));
    expect(CLOUD_TIMEOUTS.coachMs).toBeGreaterThanOrEqual(longest + 15_000);
    expect(CLOUD_TIMEOUTS.awakeMs).toBeLessThan(15 * 60_000);
  });
});
