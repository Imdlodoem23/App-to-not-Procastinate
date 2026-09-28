/**
 * Reminders (PROMPT §9): «Es tu hora de estudiar» before each schedule, from the guardian's
 * `nextSchedule`, and the 20-20-20 eye breaks while blocks run.
 */
import type { GuardianStateResponse, NextScheduleInfo } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import type { NotificationContent } from '../../../src/main/notifications/types';
import { eyeBreakReminder, nextReminder, scheduleReminder } from '../../../src/main/reminders/plan';
import { ReminderScheduler, isStale, reminderContent } from '../../../src/main/reminders/scheduler';
import { HARNESS_NOW, makeBlock, makeGuardianState } from '../../../src/shared/fixtures';
import type { ReminderPrefs } from '../../../src/shared/prefs';
import { run } from '../guardian/helpers';

const NOW = HARNESS_NOW; // 17:00 Madrid
const MIN = 60_000;
const PREFS: ReminderPrefs = { schedules: true, leadMinutes: 5, eyeBreaks: true };

function next(startsInMin: number, id = 'sch_fixture0000000001'): NextScheduleInfo {
  return {
    scheduleId: id as NextScheduleInfo['scheduleId'],
    name: 'Tardes de estudio',
    startsAt: new Date(NOW + startsInMin * MIN).toISOString(),
    endsAt: new Date(NOW + (startsInMin + 120) * MIN).toISOString(),
  };
}

function blockState(elapsedMin: number, leftMin: number): GuardianStateResponse {
  return makeGuardianState(NOW, {
    blocks: [
      makeBlock(
        {
          n: 1,
          services: ['youtube'],
          mode: 'normal',
          leftMs: leftMin * MIN,
          elapsedMs: elapsedMin * MIN,
        },
        NOW,
      ),
    ],
  });
}

describe('schedule reminder', () => {
  it('comes `leadMinutes` before the start, once', () => {
    const r = scheduleReminder(next(60), PREFS, NOW, new Set());
    expect(r).toMatchObject({ kind: 'schedule', at: NOW + 55 * MIN });
    expect(scheduleReminder(next(60), PREFS, NOW, new Set([r?.key ?? '']))).toBeNull();
  });

  it('shows at once inside the lead window, never after the start', () => {
    expect(scheduleReminder(next(3), PREFS, NOW, new Set())?.at).toBe(NOW);
    expect(scheduleReminder(next(0), PREFS, NOW, new Set())).toBeNull();
    expect(scheduleReminder(next(-10), PREFS, NOW, new Set())).toBeNull();
  });

  it('respects the switch and the lead', () => {
    expect(scheduleReminder(next(60), { ...PREFS, schedules: false }, NOW, new Set())).toBeNull();
    expect(scheduleReminder(next(60), { ...PREFS, leadMinutes: 0 }, NOW, new Set())?.at).toBe(
      NOW + 60 * MIN,
    );
    expect(scheduleReminder(null, PREFS, NOW, new Set())).toBeNull();
  });

  it('reads like the brief', () => {
    const r = scheduleReminder(next(60), PREFS, NOW, new Set());
    if (!r) throw new Error('no reminder');
    expect(reminderContent(r)).toEqual({
      title: 'Es tu hora de estudiar',
      body: 'Tardes de estudio empieza a las 18:00',
      kinds: ['reminder_schedule'],
    });
    const now0 = scheduleReminder(next(60), { ...PREFS, leadMinutes: 0 }, NOW, new Set());
    if (!now0) throw new Error('no reminder');
    expect(reminderContent(now0).body).toBe('Tardes de estudio empieza ahora');
  });
});

describe('20-20-20 eye breaks', () => {
  it('every 20 min from the first block start, until the end', () => {
    const state = blockState(30, 45); // started 16:30, ends 17:45
    const r = eyeBreakReminder(state, PREFS, NOW, new Set());
    expect(r?.at).toBe(NOW + 10 * MIN); // 16:30 + 40 min = 17:10
    const later = eyeBreakReminder(state, PREFS, NOW + 10 * MIN, new Set());
    expect(later?.at).toBe(NOW + 30 * MIN);
    expect(eyeBreakReminder(state, PREFS, NOW + 31 * MIN, new Set())).toBeNull(); // 17:50 > end
  });

  it('only with the rule on and a block running', () => {
    expect(
      eyeBreakReminder(blockState(30, 45), { ...PREFS, eyeBreaks: false }, NOW, new Set()),
    ).toBeNull();
    expect(eyeBreakReminder(makeGuardianState(NOW), PREFS, NOW, new Set())).toBeNull();
    expect(eyeBreakReminder(null, PREFS, NOW, new Set())).toBeNull();
    const r = eyeBreakReminder(blockState(30, 45), PREFS, NOW, new Set());
    if (!r) throw new Error('no break');
    expect(reminderContent(r)).toEqual({
      title: 'Descanso para la vista',
      body: 'Mira algo a 6 metros durante 20 segundos',
      kinds: ['reminder_eye_break'],
    });
  });

  it('the earliest of both comes first', () => {
    const state = { ...blockState(30, 45), nextSchedule: next(60) };
    expect(nextReminder(state, PREFS, NOW, new Set())?.kind).toBe('eye-break');
    expect(nextReminder(state, { ...PREFS, eyeBreaks: false }, NOW, new Set())?.kind).toBe(
      'schedule',
    );
  });
});

describe('scheduler', () => {
  it('shows each reminder when due and plans the next', async () => {
    const clock = createManualClock(NOW);
    const shown: NotificationContent[] = [];
    const s = new ReminderScheduler({ clock, show: (c) => shown.push(c) });
    const state = { ...blockState(30, 45), nextSchedule: next(60) };
    s.sync(state, PREFS, true);
    await run(clock, 10 * MIN - 1);
    expect(shown).toEqual([]);
    await run(clock, 1);
    expect(shown.map((c) => c.kinds[0])).toEqual(['reminder_eye_break']);
    await run(clock, 20 * MIN);
    expect(shown.map((c) => c.kinds[0])).toEqual(['reminder_eye_break', 'reminder_eye_break']);
    // The block is over at 17:45: the schedule reminder at 17:55 comes next.
    s.sync({ ...makeGuardianState(NOW), nextSchedule: next(60) }, PREFS, true);
    await run(clock, 25 * MIN);
    expect(shown.at(-1)?.kinds).toEqual(['reminder_schedule']);
    // Not twice for the same occurrence.
    s.sync({ ...makeGuardianState(NOW), nextSchedule: next(60) }, PREFS, true);
    await run(clock, 4 * MIN);
    expect(shown.filter((c) => c.kinds[0] === 'reminder_schedule')).toHaveLength(1);
    s.stop();
  });

  it('does nothing with the flag off', async () => {
    const clock = createManualClock(NOW);
    const shown: NotificationContent[] = [];
    const s = new ReminderScheduler({ clock, show: (c) => shown.push(c) });
    s.sync({ ...blockState(30, 45), nextSchedule: next(10) }, PREFS, false);
    expect(s.next()).toBeNull();
    await run(clock, 60 * MIN);
    expect(shown).toEqual([]);
  });

  it('drops a reminder whose moment passed during a suspend', () => {
    const r = scheduleReminder(next(60), PREFS, NOW, new Set());
    if (!r) throw new Error('no reminder');
    expect(isStale(r, NOW + 55 * MIN)).toBe(false);
    expect(isStale(r, NOW + 61 * MIN)).toBe(true);
    const eye = eyeBreakReminder(blockState(30, 45), PREFS, NOW, new Set());
    if (!eye) throw new Error('no break');
    expect(isStale(eye, eye.at + 30_000)).toBe(false);
    expect(isStale(eye, eye.at + 5 * MIN)).toBe(true);
  });
});
