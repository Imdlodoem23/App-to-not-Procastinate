/**
 * The Pomodoro (PROMPT §9: 25/5 and 50/10, customisable; breaks pause camera watching): presets,
 * the custom one within its limits and 8 h, the start fields the guardian takes, the timeline
 * in active time, the guardian's own phase, and the labels in both languages.
 */
import { describe, expect, it } from 'vitest';
import type { StudySession } from '@centrate/shared/domain';
import { pomodoroPlannedMinutes } from '@centrate/shared/points';
import { withLocale } from '../../../src/shared/i18n/locale';
import { DEFAULT_FEATURE_PREFS } from '../../../src/shared/prefs';
import {
  POMODORO_CHOICE_IDS,
  cameraWatches,
  clampPomodoro,
  isPomodoroChoiceId,
  maxPomodoroCycles,
  nextPhaseDelay,
  parsePomodoroField,
  pomodoroAt,
  pomodoroChoices,
  pomodoroMomentLabel,
  pomodoroPatch,
  pomodoroSpec,
  pomodoroStartFields,
  sessionElapsedMs,
  sessionPomodoro,
  sessionPomodoroSpec,
} from '../../../src/renderer/src/features/pomodoro/timer';

const MIN = 60_000;
const NOW = Date.parse('2026-09-28T15:00:00.000Z');
const CUSTOM = DEFAULT_FEATURE_PREFS.pomodoro;

describe('Pomodoro presets', () => {
  it('offers 25/5, 50/10 and the user’s own', () => {
    expect(POMODORO_CHOICE_IDS).toEqual(['25-5', '50-10', 'custom']);
    expect(isPomodoroChoiceId('50-10')).toBe(true);
    expect(isPomodoroChoiceId('1h')).toBe(false);
    expect(pomodoroSpec('25-5', CUSTOM)).toEqual({ workMinutes: 25, breakMinutes: 5, cycles: 4 });
    expect(pomodoroSpec('50-10', CUSTOM)).toEqual({ workMinutes: 50, breakMinutes: 10, cycles: 2 });
    const own = { workMinutes: 40, breakMinutes: 8, cycles: 3 };
    expect(pomodoroSpec('custom', own)).toEqual(own);
    const choices = pomodoroChoices(own);
    expect(choices.map((c) => [c.label, c.help, c.plannedMinutes])).toEqual([
      ['25/5', '4 × 25 min con 5 min de descanso · 1 h 55 min', 115],
      ['50/10', '2 × 50 min con 10 min de descanso · 1 h 50 min', 110],
      ['40/8', 'Personalizado: 3 × 40 min con 8 min de descanso · 2 h 16 min', 136],
    ]);
    // A custom preset equal to 25/5 reads «Personalizado» (never two «25/5» tiles).
    expect(pomodoroChoices(CUSTOM)[2]?.label).toBe('Personalizado');
    withLocale('en', () => {
      expect(pomodoroChoices(own)[0]?.help).toBe('4 × 25 min with 5 min breaks · 1 h 55 min');
      expect(pomodoroChoices(CUSTOM)[2]?.label).toBe('Custom');
    });
  });

  it('keeps the custom one within its limits and one 8 h session', () => {
    expect(clampPomodoro({ workMinutes: 2, breakMinutes: 0, cycles: 0 })).toEqual({
      workMinutes: 5,
      breakMinutes: 1,
      cycles: 1,
    });
    expect(maxPomodoroCycles(120, 60)).toBe(3);
    const long = clampPomodoro({ workMinutes: 120, breakMinutes: 60, cycles: 12 });
    expect(long).toEqual({ workMinutes: 120, breakMinutes: 60, cycles: 3 });
    expect(pomodoroPlannedMinutes(long)).toBeLessThanOrEqual(480);
    const capped = pomodoroChoices({ workMinutes: 120, breakMinutes: 60, cycles: 12 })[2];
    expect(capped).toMatchObject({
      capped: true,
      plannedMinutes: 480,
      note: 'Como mucho 3 rondas: una sesión dura hasta 8 h',
    });
    expect(pomodoroChoices({ workMinutes: 40, breakMinutes: 8, cycles: 3 })[2]?.capped).toBe(false);
    expect(clampPomodoro({ workMinutes: Number.NaN, breakMinutes: 5, cycles: 4 }).workMinutes).toBe(
      5,
    );
  });

  it('gives the guardian what a session start needs', () => {
    expect(pomodoroStartFields(pomodoroSpec('25-5', CUSTOM))).toEqual({
      plannedMinutes: 115,
      pomodoro: { workMinutes: 25, breakMinutes: 5 },
    });
    expect(pomodoroStartFields({ workMinutes: 120, breakMinutes: 60, cycles: 9 })).toEqual({
      plannedMinutes: 480,
      pomodoro: { workMinutes: 120, breakMinutes: 60 },
    });
  });

  it('reads and patches the custom fields', () => {
    expect(parsePomodoroField('workMinutes', ' 40 ')).toEqual({ ok: true, value: 40 });
    expect(parsePomodoroField('workMinutes', '4')).toEqual({ ok: false, error: 'Entre 5 y 120' });
    expect(parsePomodoroField('breakMinutes', '61')).toEqual({ ok: false, error: 'Entre 1 y 60' });
    expect(parsePomodoroField('cycles', 'tres')).toEqual({ ok: false, error: 'Escribe un número' });
    expect(parsePomodoroField('cycles', '-2')).toEqual({ ok: false, error: 'Escribe un número' });
    expect(pomodoroPatch('cycles', 3)).toEqual({ pomodoro: { cycles: 3 } });
    withLocale('en', () =>
      expect(parsePomodoroField('cycles', '13')).toEqual({ ok: false, error: 'Between 1 and 12' }),
    );
  });
});

describe('Pomodoro timeline', () => {
  const spec = { workMinutes: 25, breakMinutes: 5, cycles: 4 };

  it('walks work, break, …, the last work and the end', () => {
    expect(pomodoroAt(spec, 0)).toEqual({
      phase: 'work',
      cycle: 1,
      cycles: 4,
      remainingMs: 25 * MIN,
      cameraWatching: true,
    });
    expect(pomodoroAt(spec, 25 * MIN)).toMatchObject({
      phase: 'break',
      cycle: 1,
      remainingMs: 5 * MIN,
      cameraWatching: false,
    });
    expect(pomodoroAt(spec, 31 * MIN)).toMatchObject({
      phase: 'work',
      cycle: 2,
      remainingMs: 24 * MIN,
    });
    // No break after the last round: the session ends at 115 min.
    expect(pomodoroAt(spec, 114 * MIN)).toMatchObject({
      phase: 'work',
      cycle: 4,
      remainingMs: MIN,
    });
    expect(pomodoroAt(spec, 115 * MIN)).toEqual({
      phase: 'done',
      cycle: 4,
      cycles: 4,
      remainingMs: 0,
      cameraWatching: false,
    });
    expect(pomodoroAt(spec, -5)).toMatchObject({ phase: 'work', cycle: 1 });
  });

  it('never has the camera watching outside work', () => {
    for (let minute = 0; minute <= 120; minute += 1) {
      const m = pomodoroAt(spec, minute * MIN);
      expect(m.cameraWatching, `${minute} min`).toBe(m.phase === 'work');
    }
    expect(cameraWatches('work')).toBe(true);
    for (const phase of ['break', 'paused', 'ended', 'done'] as const) {
      expect(cameraWatches(phase)).toBe(false);
    }
  });

  it('schedules one timer per phase change', () => {
    expect(nextPhaseDelay(pomodoroAt(spec, 10 * MIN))).toBe(15 * MIN);
    expect(nextPhaseDelay(pomodoroAt(spec, 200 * MIN))).toBeNull();
  });

  it('labels the meter', () => {
    expect(pomodoroMomentLabel(pomodoroAt(spec, 31 * MIN + 1_500))).toBe(
      'Concentración 2 de 4 · 23:59',
    );
    expect(pomodoroMomentLabel(pomodoroAt(spec, 25 * MIN + 48_000))).toBe(
      'Descanso 4:12 · la cámara no vigila',
    );
    expect(pomodoroMomentLabel(pomodoroAt(spec, 999 * MIN))).toBe('Pomodoro terminado');
    withLocale('en', () =>
      expect(pomodoroMomentLabel(pomodoroAt(spec, 25 * MIN + 48_000))).toBe(
        'Break 4:12 · the camera is not watching',
      ),
    );
  });
});

function session(patch: Partial<StudySession> = {}): StudySession {
  return {
    id: 'stu_fixture0000000001',
    task: 'historia',
    plannedMinutes: 115,
    pomodoro: { workMinutes: 25, breakMinutes: 5 },
    camera: true,
    status: 'active',
    phase: 'work',
    phaseEndsAt: null,
    startedAt: new Date(NOW - 40 * MIN).toISOString(),
    // 40 min in: 75 min of active time left.
    plannedEndsAt: new Date(NOW + 75 * MIN).toISOString(),
    endedAt: null,
    activeMinutes: 40,
    focusedMinutes: 35,
    strikes: 0,
    attempts: 0,
    cooldownUntil: null,
    pausesLeft: 2,
    nextPauseAvailableAt: null,
    lastHeartbeatAt: null,
    lastHeartbeatSeq: 0,
    warnings: 0,
    policy: { level: 'distractions', minutes: 60 },
    achieved: null,
    ...patch,
  };
}

describe('Pomodoro of a guardian session', () => {
  it('derives the rounds and the active time from the session', () => {
    expect(sessionPomodoroSpec(session())).toEqual({
      workMinutes: 25,
      breakMinutes: 5,
      cycles: 4,
    });
    expect(sessionPomodoroSpec(session({ pomodoro: null }))).toBeNull();
    expect(sessionElapsedMs(session(), NOW)).toBe(40 * MIN);
    expect(sessionElapsedMs(session(), NOW + 500 * MIN)).toBe(115 * MIN);
    expect(sessionElapsedMs(session({ plannedEndsAt: 'x' }), NOW)).toBe(0);
    expect(sessionPomodoro(session({ pomodoro: null }), NOW)).toBeNull();
  });

  it('follows the timeline, and the guardian’s phase while its end is ahead', () => {
    // 40 min in: round 2, 15 min of work left.
    expect(sessionPomodoro(session(), NOW)).toMatchObject({
      phase: 'work',
      cycle: 2,
      remainingMs: 15 * MIN,
      cameraWatching: true,
    });
    const onBreak = session({
      phase: 'break',
      phaseEndsAt: new Date(NOW + 3 * MIN).toISOString(),
    });
    expect(sessionPomodoro(onBreak, NOW)).toMatchObject({
      phase: 'break',
      remainingMs: 3 * MIN,
      cameraWatching: false,
    });
    // Its end passed before the next poll: the timeline takes over.
    expect(sessionPomodoro(onBreak, NOW + 4 * MIN)?.phase).toBe('work');
  });

  it('stops watching while paused and once over', () => {
    const paused = session({
      status: 'paused',
      phase: 'paused',
      phaseEndsAt: new Date(NOW + 2 * MIN).toISOString(),
    });
    expect(sessionPomodoro(paused, NOW)).toMatchObject({
      phase: 'paused',
      remainingMs: 2 * MIN,
      cameraWatching: false,
    });
    const moment = sessionPomodoro(paused, NOW);
    if (!moment) throw new Error('no Pomodoro');
    expect(pomodoroMomentLabel(moment)).toBe('En pausa · la cámara no vigila');
    expect(sessionPomodoro(session({ status: 'completed', phase: 'ended' }), NOW)).toMatchObject({
      phase: 'done',
      cameraWatching: false,
    });
    expect(sessionPomodoro(session({ phase: 'ended' }), NOW)?.phase).toBe('done');
  });
});
