/**
 * The in-memory guardian's schedule guards (ARCHITECTURE §8.8 «Guards for PUT and DELETE»,
 * §10.3), which the dev mock and the harness's fake guardian share: `nextOccurrence` and
 * `activeBlockId` on the mock clock, 409 `schedule_in_progress` with `{ blockId, endsAt }`,
 * 409 `schedule_starting_soon` with `{ startsAt }` for a delete or a weakening edit in the
 * 10 min before a start.
 */
import type { Block, Schedule } from '@centrate/shared/domain';
import { GuardianApiError, type ScheduleInput } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { MockGuardian } from '../../../src/main/guardian/mock';
import {
  currentOccurrence,
  nextOccurrence,
  scheduleEditWeakens,
  zonedInstant,
} from '../../../src/main/guardian/mock-schedules';
import { HARNESS_NOW, makeSchedules } from '../../../src/shared/fixtures';

const MIN = 60_000;
/** «Tardes de estudio», L–V 18:00–20:00 Madrid; HARNESS_NOW is Monday 17:00 there. */
const TARDES = makeSchedules(HARNESS_NOW)[0] as Schedule;

function input(s: Schedule, patch: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: s.name,
    enabled: s.enabled,
    days: [...s.days],
    start: s.start,
    end: s.end,
    timezone: s.timezone,
    targets: structuredClone(s.targets),
    whitelistOnly: s.whitelistOnly,
    allow: structuredClone(s.allow),
    mode: s.mode,
    reason: s.reason,
    acknowledgeNoEmergency: false,
    ...patch,
  };
}

async function blocksOf(guardian: MockGuardian): Promise<Block[]> {
  const r = await guardian.getState();
  if (r.notModified) throw new Error('expected a state body');
  return r.state.blocks;
}

async function refusal(run: () => Promise<unknown>): Promise<GuardianApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GuardianApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('occurrences', () => {
  it('finds the next start in the schedule’s time zone (the fixture’s own)', () => {
    const next = nextOccurrence(TARDES.id, TARDES, HARNESS_NOW);
    expect(next && new Date(next.start).toISOString()).toBe(TARDES.nextOccurrence?.startsAt);
    expect(next && new Date(next.end).toISOString()).toBe(TARDES.nextOccurrence?.endsAt);
    expect(nextOccurrence(TARDES.id, { ...TARDES, enabled: false }, HARNESS_NOW)).toBeNull();
    // Friday 19:00 → the next one is Monday.
    const friday = HARNESS_NOW + 4 * 24 * 60 * MIN + 2 * 60 * MIN;
    const monday = nextOccurrence(TARDES.id, TARDES, friday);
    expect(monday && new Date(monday.start).toISOString()).toBe('2026-10-05T16:00:00.000Z');
  });

  it('knows the one in progress, overnight windows included', () => {
    expect(currentOccurrence(TARDES.id, TARDES, HARNESS_NOW)).toBeNull();
    const at1830 = HARNESS_NOW + 90 * MIN;
    expect(currentOccurrence(TARDES.id, TARDES, at1830)?.key).toBe(`${TARDES.id}@2026-09-28`);
    const night = { ...TARDES, days: [1 as const], start: '23:00', end: '01:00' };
    // Tuesday 00:30 Madrid belongs to Monday's occurrence.
    const tuesday0030 = Date.parse('2026-09-28T22:30:00.000Z');
    expect(currentOccurrence(TARDES.id, night, tuesday0030)?.key).toBe(`${TARDES.id}@2026-09-28`);
  });

  it('reads wall times across DST changes', () => {
    // Madrid, 25 Oct 2026: 03:00 CEST → 02:00 CET. 02:30 happens twice: the earliest.
    expect(
      new Date(
        zonedInstant({ year: 2026, month: 10, day: 25 }, 150, 'Europe/Madrid'),
      ).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    // 29 Mar 2026: 02:00 CET → 03:00 CEST. 02:30 does not exist: after the gap.
    const gap = zonedInstant({ year: 2026, month: 3, day: 29 }, 150, 'Europe/Madrid');
    expect(gap).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00.000Z'));
  });
});

describe('weakening edits', () => {
  it('follows the guardian’s list', () => {
    expect(scheduleEditWeakens(TARDES, input(TARDES, { name: 'Otro', reason: 'x' }))).toBe(false);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { days: [1, 2, 3, 4, 5, 6] }))).toBe(false);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { mode: 'strict' }))).toBe(false);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { start: '17:30' }))).toBe(false);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { enabled: false }))).toBe(true);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { days: [1, 2, 3, 4] }))).toBe(true);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { end: '19:30' }))).toBe(true);
    expect(scheduleEditWeakens(TARDES, input(TARDES, { timezone: 'Europe/London' }))).toBe(true);
    expect(
      scheduleEditWeakens(
        TARDES,
        input(TARDES, { targets: { ...TARDES.targets, categoryIds: [] } }),
      ),
    ).toBe(true);
    const strict = { ...TARDES, mode: 'strict' as const };
    expect(scheduleEditWeakens(strict, input(strict, { mode: 'normal' }))).toBe(true);
  });
});

describe('the mock guardian’s guards', () => {
  function mock(): { guardian: MockGuardian; clock: ReturnType<typeof createManualClock> } {
    const clock = createManualClock(HARNESS_NOW);
    const guardian = new MockGuardian({
      clock,
      seed: { schedules: makeSchedules(HARNESS_NOW) },
    });
    return { guardian, clock };
  }

  it('computes nextOccurrence on its clock', async () => {
    const { guardian, clock } = mock();
    const { schedules } = await guardian.listSchedules();
    expect(schedules[0]?.nextOccurrence).toEqual(TARDES.nextOccurrence);
    clock.advance(4 * 60 * MIN); // 21:00: Tuesday's is next.
    const later = await guardian.listSchedules();
    expect(later.schedules[0]?.nextOccurrence?.startsAt).toBe('2026-09-29T16:00:00.000Z');
  });

  it('refuses a delete or a weakening edit in the 10 min before a start', async () => {
    const { guardian, clock } = mock();
    clock.advance(52 * MIN); // 17:52
    const del = await refusal(() => guardian.deleteSchedule(TARDES.id));
    expect(del.code).toBe('schedule_starting_soon');
    expect(del.status).toBe(409);
    expect(del.details).toEqual({ startsAt: TARDES.nextOccurrence?.startsAt });
    const weaker = await refusal(() =>
      guardian.updateSchedule(TARDES.id, input(TARDES, { days: [1, 2, 3, 4] })),
    );
    expect(weaker.code).toBe('schedule_starting_soon');
    // A stricter one goes through, and the answer carries the next occurrence.
    const stricter = await guardian.updateSchedule(
      TARDES.id,
      input(TARDES, { days: [1, 2, 3, 4, 5, 6] }),
    );
    expect(stricter.schedule.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stricter.schedule.nextOccurrence).toEqual(TARDES.nextOccurrence);
    // A disabled schedule has no next start: it can go.
    await guardian.deleteSchedule(makeSchedules(HARNESS_NOW)[1]?.id ?? TARDES.id);
  });

  it('turns a started occurrence into a block and refuses any change until it ends', async () => {
    const { guardian, clock } = mock();
    clock.advance(61 * MIN); // 18:01: the occurrence runs.
    const { schedules } = await guardian.listSchedules();
    const blockId = schedules[0]?.activeBlockId;
    expect(blockId).toMatch(/^blk_/);
    const block = (await blocksOf(guardian)).find((b) => b.id === blockId);
    expect(block).toMatchObject({
      kind: 'schedule',
      scheduleId: TARDES.id,
      endsAt: '2026-09-28T18:00:00.000Z',
    });

    const edit = await refusal(() =>
      guardian.updateSchedule(TARDES.id, input(TARDES, { days: [1, 2, 3, 4, 5, 6] })),
    );
    expect(edit.code).toBe('schedule_in_progress');
    expect(edit.details).toEqual({ blockId, endsAt: '2026-09-28T18:00:00.000Z' });
    const del = await refusal(() => guardian.deleteSchedule(TARDES.id));
    expect(del.code).toBe('schedule_in_progress');

    // After the end the block completes and edits are free again (next start: tomorrow).
    clock.advance(2 * 60 * MIN);
    const after = await guardian.listSchedules();
    expect(after.schedules[0]?.activeBlockId).toBeNull();
    await guardian.updateSchedule(TARDES.id, input(TARDES, { name: 'Tardes' }));
  });

  it('leaves an occurrence already running when it started alone (a seeded fixture)', async () => {
    const clock = createManualClock(HARNESS_NOW + 90 * MIN);
    const guardian = new MockGuardian({ clock, seed: { schedules: makeSchedules(HARNESS_NOW) } });
    const { schedules } = await guardian.listSchedules();
    expect(schedules[0]?.activeBlockId).toBeNull();
    expect(await blocksOf(guardian)).toEqual([]);
  });
});
