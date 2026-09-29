import {
  emptyTargets,
  isDailyLimit,
  isListLimitsResponse,
  isStateResponse,
  isUsageReportResponse,
  isWireEvent,
  type DailyLimitInput,
} from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { HARNESS_NOW, harnessFixture, makeLimits } from '../../../src/shared/fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;

function input(patch: Partial<DailyLimitInput> = {}): DailyLimitInput {
  return {
    name: 'Mi juego',
    enabled: true,
    targets: { ...emptyTargets(), customProcesses: ['mygame'] },
    dailyMinutes: 30,
    days: [1, 2, 3, 4, 5, 6, 7],
    mode: 'strict',
    reason: 'Quiero dormir',
    acknowledgeNoEmergency: false,
    ...patch,
  };
}

function setup(now = HARNESS_NOW) {
  const clock = createManualClock(now);
  const mock = new MockGuardian({ clock });
  return { clock, mock };
}

async function stateOf(mock: MockGuardian) {
  const r = await mock.getState();
  if (r.notModified) throw new Error('unexpected 304');
  return r.state;
}

/** `minutes` of usage of `name`, reported every 30 s like the app does. */
async function use(
  mock: MockGuardian,
  clock: ReturnType<typeof createManualClock>,
  name: string,
  minutes: number,
) {
  for (let i = 0; i < minutes * 2; i += 1) {
    clock.advance(30_000);
    await mock.reportUsage({
      intervalMs: 30_000,
      items: [{ type: 'process', value: name, seconds: 30 }],
    });
  }
}

describe('MockGuardian daily limits', () => {
  it('creates a limit (valid shapes, a limit_created event) and lists it', async () => {
    const { mock } = setup();
    const r = await mock.createLimit(input(), { idempotencyKey: 'k1' });
    expect(isDailyLimit(r.limit)).toBe(true);
    expect(r.limit).toMatchObject({
      name: 'Mi juego',
      dailyMinutes: 30,
      usedTodaySeconds: 0,
      remainingTodaySeconds: 1800,
      appliesToday: true,
      reachedAt: null,
      pendingChange: null,
    });
    // Same key, same body: the same limit.
    const again = await mock.createLimit(input(), { idempotencyKey: 'k1' });
    expect(again.limit.id).toBe(r.limit.id);
    const list = await mock.listLimits();
    expect(isListLimitsResponse(list)).toBe(true);
    expect(list.limits).toHaveLength(1);
    const events = mock.allEvents();
    expect(events.every(isWireEvent)).toBe(true);
    expect(events.map((e) => e.type)).toContain('limit_created');
    const state = await stateOf(mock);
    expect(isStateResponse(state)).toBe(true);
    expect(state.limits).toHaveLength(1);
  });

  it('refuses hardcore without the acknowledgement, and a bad body', async () => {
    const { mock } = setup();
    await expect(mock.createLimit(input({ mode: 'hardcore' }))).rejects.toMatchObject({
      code: 'confirmation_required',
    });
    await expect(mock.createLimit(input({ dailyMinutes: 2 }))).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      mock.createLimit(input({ targets: { ...emptyTargets(), serviceIds: ['nope'] } })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/validation_failed|unknown_id/) });
  });

  it('counts the app’s usage, warns 5 min before and blocks until midnight when used up', async () => {
    const { clock, mock } = setup();
    const { limit } = await mock.createLimit(input());
    // Not a limited process: nothing is counted.
    clock.advance(30_000);
    const other = await mock.reportUsage({
      intervalMs: 30_000,
      items: [{ type: 'process', value: 'code', seconds: 30 }],
    });
    expect(isUsageReportResponse(other)).toBe(true);
    expect(other.limits[0]).toMatchObject({ usedTodaySeconds: 0, creditedSeconds: 0 });

    await use(mock, clock, 'mygame', 25);
    const warned = mock.allEvents().filter((e) => e.type === 'limit_warning');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ data: { name: 'Mi juego', remainingSeconds: 300 } });

    await use(mock, clock, 'mygame', 5);
    const reached = mock.allEvents().find((e) => e.type === 'limit_reached');
    expect(reached).toMatchObject({ data: { limitId: limit.id, dailyMinutes: 30 } });
    const state = await stateOf(mock);
    const block = state.blocks.find((b) => b.limitId === limit.id);
    expect(block).toMatchObject({ kind: 'limit', mode: 'strict', reason: 'Quiero dormir' });
    // 17:00 + 30.5 min in Madrid → blocked until 00:00 (22:00 UTC).
    expect(block?.endsAt).toBe('2026-09-28T22:00:00.000Z');
    const created = mock
      .allEvents()
      .find((e) => e.type === 'block_created' && e.data.source === 'limit');
    expect(created).toBeDefined();
    expect(state.limits?.[0]).toMatchObject({
      reachedAt: expect.any(String),
      activeBlockId: block?.id,
      remainingTodaySeconds: 0,
    });
    // More usage never makes a second block the same day.
    await use(mock, clock, 'mygame', 2);
    const again = await stateOf(mock);
    expect(again.blocks.filter((b) => b.limitId === limit.id)).toHaveLength(1);
  });

  it('never credits more than the wall time since the last report', async () => {
    const { clock, mock } = setup();
    await mock.createLimit(input());
    clock.advance(30_000);
    await mock.reportUsage({
      intervalMs: 30_000,
      items: [{ type: 'process', value: 'mygame', seconds: 30 }],
    });
    // A report claiming 2 min right after the previous one is clamped to ~1 s + slack.
    clock.advance(1_000);
    const r = await mock.reportUsage({
      intervalMs: 120_000,
      items: [{ type: 'process', value: 'mygame', seconds: 120 }],
    });
    expect(r.limits[0]?.usedTodaySeconds).toBeLessThanOrEqual(33);
  });

  it('refuses domain items from the app token', async () => {
    const { mock } = setup();
    await expect(
      mock.reportUsage({
        intervalMs: 30_000,
        items: [{ type: 'domain', value: 'www.youtube.com', seconds: 30 }],
      }),
    ).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('applies a stricter edit at once and keeps a softer one pending until the next day', async () => {
    const { clock, mock } = setup();
    const { limit } = await mock.createLimit(input());
    const stricter = await mock.updateLimit(limit.id, input({ dailyMinutes: 20 }));
    expect(stricter.limit).toMatchObject({ dailyMinutes: 20, pendingChange: null });
    const softer = await mock.updateLimit(limit.id, input({ dailyMinutes: 60, mode: 'normal' }));
    expect(softer.limit.dailyMinutes).toBe(20);
    expect(softer.limit.mode).toBe('strict');
    expect(softer.limit.pendingChange?.definition).toMatchObject({
      dailyMinutes: 60,
      mode: 'normal',
    });
    const due = Date.parse(softer.limit.pendingChange?.effectiveAt ?? '');
    expect(due).toBeGreaterThanOrEqual(HARNESS_NOW + 24 * HOUR);
    // Re-sending the effective definition cancels it.
    const cancelled = await mock.updateLimit(limit.id, input({ dailyMinutes: 20 }));
    expect(cancelled.limit.pendingChange).toBeNull();
    // A softer edit again, then time passes: it applies.
    await mock.updateLimit(limit.id, input({ dailyMinutes: 45 }));
    clock.advance(25 * HOUR);
    const list = await mock.listLimits();
    expect(list.limits[0]).toMatchObject({ dailyMinutes: 45, pendingChange: null });
    expect(
      mock
        .allEvents()
        .some((e) => e.type === 'limit_updated' && e.data.cause === 'pending_applied'),
    ).toBe(true);
  });

  it('deletes only after the wait, and never ends today’s limit block', async () => {
    const { clock, mock } = setup();
    const { limit } = await mock.createLimit(input({ dailyMinutes: 5 }));
    await use(mock, clock, 'mygame', 5);
    const blocked = await stateOf(mock);
    expect(blocked.blocks.some((b) => b.limitId === limit.id)).toBe(true);
    const r = await mock.deleteLimit(limit.id);
    expect(r.limit.pendingChange).toMatchObject({ definition: null });
    const still = await stateOf(mock);
    expect(still.limits).toHaveLength(1);
    expect(still.blocks.some((b) => b.limitId === limit.id)).toBe(true);
    clock.advance(25 * HOUR);
    const later = await mock.listLimits();
    expect(later.limits).toHaveLength(0);
    expect(mock.allEvents().some((e) => e.type === 'limit_deleted')).toBe(true);
  });

  it('closes the day with the minutes used (limit_day_closed) and starts again at 0', async () => {
    const { clock, mock } = setup();
    const { limit } = await mock.createLimit(input());
    await use(mock, clock, 'mygame', 3);
    clock.advance(8 * HOUR);
    const list = await mock.listLimits();
    expect(list.limits[0]).toMatchObject({ usedTodaySeconds: 0, day: '2026-09-29' });
    const closed = mock.allEvents().find((e) => e.type === 'limit_day_closed');
    expect(closed).toMatchObject({
      data: {
        limitId: limit.id,
        day: '2026-09-28',
        usedSeconds: 180,
        applied: true,
        reached: false,
      },
    });
  });

  it('serves the state floored to whole minutes, GET /v1/limits exact', async () => {
    const { clock, mock } = setup();
    await mock.createLimit(input());
    clock.advance(30_000);
    await mock.reportUsage({
      intervalMs: 30_000,
      items: [{ type: 'process', value: 'mygame', seconds: 30 }],
    });
    clock.advance(45_000);
    await mock.reportUsage({
      intervalMs: 45_000,
      items: [{ type: 'process', value: 'mygame', seconds: 45 }],
    });
    const exact = (await mock.listLimits()).limits[0];
    expect(exact?.usedTodaySeconds).toBe(75);
    const state = await stateOf(mock);
    expect(state.limits?.[0]?.usedTodaySeconds).toBe(60);
  });

  it('seeds the fixtures’ limits (exact from GET, the fixture state as is)', async () => {
    const fixture = harnessFixture('limits');
    const clock = createManualClock(fixture.nowMs);
    const mock = new MockGuardian({
      clock,
      seed: { state: fixture.snapshot.state, limits: fixture.fake.limits },
    });
    const list = await mock.listLimits();
    expect(list.limits.map((l) => l.id)).toEqual(makeLimits(HARNESS_NOW).map((l) => l.id));
    expect(list.limits[0]?.usedTodaySeconds).toBe(12 * 60 + 20);
    expect(list.limits[1]?.reachedAt).not.toBeNull();
    expect(list.limits[1]?.activeBlockId).toBe(fixture.snapshot.state?.blocks[0]?.id);
    expect(list.limits[2]?.pendingChange?.definition?.dailyMinutes).toBe(60);
    const state = await stateOf(mock);
    expect(state.limits).toEqual(fixture.snapshot.state?.limits);
  });
});
