/**
 * The Pomodoro of Study Mode (PROMPT §9 «Pomodoro integrado (25/5 y 50/10, personalizable); en
 * los descansos se pausa la vigilancia de la cámara»; ARCHITECTURE §5.4). Pure: no DOM, Node or
 * Electron imports, so the Study Mode wave can drive its tiles, its meter and the camera watcher
 * from here and every rule is unit-tested.
 *
 * - The presets are the shared `POMODORO_PRESETS` (25/5 × 4, 50/10 × 2); the custom one is
 *   `prefs.pomodoro` (`POMODORO_LIMITS`), kept within one session's 8 h by trimming rounds.
 * - A session is `cycles` work blocks with breaks between them and none after the last:
 *   `plannedMinutes = cycles × (work + break) − break` (`pomodoroPlannedMinutes`), so it can
 *   complete and earn the clean bonus.
 * - The timeline is measured in **active** time (pauses do not count), from the guardian's
 *   `plannedEndsAt`; while the guardian's `phaseEndsAt` is still ahead, its `phase` wins.
 * - The camera watches only during work: breaks, pauses and the end stop it.
 */
import type { StudyPhase, StudySession } from '@centrate/shared/domain';
import { durationLabel } from '@centrate/shared/parser';
import { POMODORO_PRESETS, STUDY_RULES, pomodoroPlannedMinutes } from '@centrate/shared/points';
import { splitCountdown } from '../../../../shared/format';
import { POMODORO_LIMITS, type PomodoroPrefs } from '../../../../shared/prefs';
import { POMODORO } from './i18n';

const MIN = 60_000;

export interface PomodoroSpec {
  workMinutes: number;
  breakMinutes: number;
  cycles: number;
}

/** «25/5 | 50/10 | Personalizado». */
export const POMODORO_CHOICE_IDS = ['25-5', '50-10', 'custom'] as const;
export type PomodoroChoiceId = (typeof POMODORO_CHOICE_IDS)[number];

export function isPomodoroChoiceId(value: unknown): value is PomodoroChoiceId {
  return typeof value === 'string' && (POMODORO_CHOICE_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------

function clampInt(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** Most rounds of `work`/`rest` that fit in one study session (8 h). */
export function maxPomodoroCycles(workMinutes: number, breakMinutes: number): number {
  const max = STUDY_RULES.plannedMinutes.max;
  return Math.max(1, Math.floor((max + breakMinutes) / (workMinutes + breakMinutes)));
}

/** Every value within its limits, and the whole session within 8 h (fewer rounds). */
export function clampPomodoro(spec: PomodoroSpec): PomodoroSpec {
  const workMinutes = clampInt(spec.workMinutes, POMODORO_LIMITS.workMinutes);
  const breakMinutes = clampInt(spec.breakMinutes, POMODORO_LIMITS.breakMinutes);
  const cycles = Math.min(
    clampInt(spec.cycles, POMODORO_LIMITS.cycles),
    maxPomodoroCycles(workMinutes, breakMinutes),
  );
  return { workMinutes, breakMinutes, cycles };
}

/** The spec of a tile: a shared preset, or the user's own (`prefs.pomodoro`). */
export function pomodoroSpec(choice: PomodoroChoiceId, custom: PomodoroPrefs): PomodoroSpec {
  if (choice === 'custom') return clampPomodoro(custom);
  const preset = POMODORO_PRESETS.find((p) => p.id === choice) ?? POMODORO_PRESETS[0];
  if (!preset) return clampPomodoro(custom);
  return {
    workMinutes: preset.workMinutes,
    breakMinutes: preset.breakMinutes,
    cycles: preset.cycles,
  };
}

/** The `StartStudyRequest` fields of a Pomodoro session (`plannedMinutes` and `pomodoro`). */
export function pomodoroStartFields(spec: PomodoroSpec): {
  plannedMinutes: number;
  pomodoro: { workMinutes: number; breakMinutes: number };
} {
  const s = clampPomodoro(spec);
  return {
    plannedMinutes: pomodoroPlannedMinutes(s),
    pomodoro: { workMinutes: s.workMinutes, breakMinutes: s.breakMinutes },
  };
}

export interface PomodoroChoice {
  id: PomodoroChoiceId;
  /** «25/5», «50/10», «40/8» (or «Personalizado» when it equals a preset). */
  label: string;
  /** «4 × 25 min con 5 min de descanso · 1 h 55 min». */
  help: string;
  spec: PomodoroSpec;
  plannedMinutes: number;
  /** The custom preset asked for more rounds than fit in 8 h. */
  capped: boolean;
  /** «Como mucho 3 rondas: una sesión dura hasta 8 h» when `capped`. */
  note: string | null;
}

function choiceHelp(spec: PomodoroSpec, custom: boolean): string {
  const format = custom ? POMODORO.customHelp : POMODORO.presetHelp;
  return format(
    spec.cycles,
    durationLabel(spec.workMinutes),
    durationLabel(spec.breakMinutes),
    durationLabel(pomodoroPlannedMinutes(spec)),
  );
}

/** The tiles «25/5 | 50/10 | 40/8» with their help lines. */
export function pomodoroChoices(custom: PomodoroPrefs): PomodoroChoice[] {
  return POMODORO_CHOICE_IDS.map((id) => {
    const spec = pomodoroSpec(id, custom);
    const isCustom = id === 'custom';
    const capped = isCustom && spec.cycles < clampInt(custom.cycles, POMODORO_LIMITS.cycles);
    const sameAsPreset =
      isCustom &&
      POMODORO_PRESETS.some(
        (p) => p.workMinutes === spec.workMinutes && p.breakMinutes === spec.breakMinutes,
      );
    return {
      id,
      label: sameAsPreset ? POMODORO.custom : POMODORO.preset(spec.workMinutes, spec.breakMinutes),
      help: choiceHelp(spec, isCustom),
      spec,
      plannedMinutes: pomodoroPlannedMinutes(spec),
      capped,
      note: capped ? POMODORO.capped(spec.cycles) : null,
    };
  });
}

// ---------------------------------------------------------------------------------------
// The custom preset's fields
// ---------------------------------------------------------------------------------------

export type PomodoroField = keyof PomodoroPrefs;
export type PomodoroFieldParse = { ok: true; value: number } | { ok: false; error: string };

/** What the user typed in «Concentración», «Descanso» or «Rondas». */
export function parsePomodoroField(field: PomodoroField, text: string): PomodoroFieldParse {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return { ok: false, error: POMODORO.errors.notANumber };
  const value = Number(trimmed);
  const range = POMODORO_LIMITS[field];
  if (value < range.min || value > range.max) {
    return { ok: false, error: POMODORO.errors.range(range.min, range.max) };
  }
  return { ok: true, value };
}

/** The `prefs:set` patch of one custom field (validated by `parsePomodoroField`). */
export function pomodoroPatch(
  field: PomodoroField,
  value: number,
): { pomodoro: Partial<PomodoroPrefs> } {
  return { pomodoro: { [field]: value } };
}

// ---------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------

export type PomodoroPhase = 'work' | 'break' | 'paused' | 'done';

export interface PomodoroMoment {
  phase: PomodoroPhase;
  /** 1-based round (the last one once done). */
  cycle: number;
  cycles: number;
  /** Time left in this phase (0 once done; while paused, until it resumes by itself). */
  remainingMs: number;
  /** Whether the camera watches: only during work. */
  cameraWatching: boolean;
}

/** Only work is watched: breaks and pauses stop the camera (PROMPT §9). */
export function cameraWatches(phase: PomodoroPhase | StudyPhase): boolean {
  return phase === 'work';
}

/** Where a Pomodoro is after `elapsedMs` of **active** time since it started. */
export function pomodoroAt(spec: PomodoroSpec, elapsedMs: number): PomodoroMoment {
  const cycles = Math.max(1, Math.round(spec.cycles));
  const work = Math.max(1, spec.workMinutes) * MIN;
  const rest = Math.max(0, spec.breakMinutes) * MIN;
  const round = work + rest;
  const total = cycles * round - rest;
  const t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  if (t >= total) {
    return { phase: 'done', cycle: cycles, cycles, remainingMs: 0, cameraWatching: false };
  }
  const index = Math.floor(t / round);
  const into = t - index * round;
  if (into < work) {
    return {
      phase: 'work',
      cycle: index + 1,
      cycles,
      remainingMs: work - into,
      cameraWatching: true,
    };
  }
  return {
    phase: 'break',
    cycle: index + 1,
    cycles,
    remainingMs: round - into,
    cameraWatching: false,
  };
}

/** Delay until the phase changes (one timer for the meter), `null` when paused or done. */
export function nextPhaseDelay(moment: PomodoroMoment): number | null {
  return moment.phase === 'work' || moment.phase === 'break' ? moment.remainingMs : null;
}

type SessionTimes = Pick<
  StudySession,
  'plannedMinutes' | 'plannedEndsAt' | 'pomodoro' | 'phase' | 'phaseEndsAt' | 'status'
>;

/** A session's spec: its work and break, and the rounds its planned length holds. */
export function sessionPomodoroSpec(session: SessionTimes): PomodoroSpec | null {
  const p = session.pomodoro;
  if (!p) return null;
  const cycles = Math.max(
    1,
    Math.round((session.plannedMinutes + p.breakMinutes) / (p.workMinutes + p.breakMinutes)),
  );
  return { workMinutes: p.workMinutes, breakMinutes: p.breakMinutes, cycles };
}

/**
 * Active time a session has run: its planned length minus what `plannedEndsAt` (the guardian's
 * «now + remaining active time») says is left, within 0…planned.
 */
export function sessionElapsedMs(session: SessionTimes, nowMs: number): number {
  const planned = session.plannedMinutes * MIN;
  const ends = Date.parse(session.plannedEndsAt);
  if (!Number.isFinite(ends)) return 0;
  return Math.min(planned, Math.max(0, planned - (ends - nowMs)));
}

/**
 * Where a guardian session's Pomodoro is now (`null` without one). The guardian's `phase` and
 * `phaseEndsAt` win while that end is ahead; between two polls the timeline takes over.
 */
export function sessionPomodoro(session: SessionTimes, nowMs: number): PomodoroMoment | null {
  const spec = sessionPomodoroSpec(session);
  if (!spec) return null;
  const moment = pomodoroAt(spec, sessionElapsedMs(session, nowMs));
  if (session.status !== 'active' && session.status !== 'paused') {
    return { ...moment, phase: 'done', remainingMs: 0, cameraWatching: false };
  }
  const phaseEnd = session.phaseEndsAt ? Date.parse(session.phaseEndsAt) : Number.NaN;
  if (session.status === 'paused' || session.phase === 'paused') {
    return {
      ...moment,
      phase: 'paused',
      remainingMs: Number.isFinite(phaseEnd) ? Math.max(0, phaseEnd - nowMs) : 0,
      cameraWatching: false,
    };
  }
  if (session.phase === 'ended') {
    return { ...moment, phase: 'done', remainingMs: 0, cameraWatching: false };
  }
  if (Number.isFinite(phaseEnd) && phaseEnd > nowMs) {
    return {
      ...moment,
      phase: session.phase,
      remainingMs: phaseEnd - nowMs,
      cameraWatching: cameraWatches(session.phase),
    };
  }
  return moment;
}

/** «Concentración 2 de 4 · 12:30», «Descanso 4:12 · la cámara no vigila». */
export function pomodoroMomentLabel(moment: PomodoroMoment): string {
  const left = splitCountdown(moment.remainingMs).text;
  switch (moment.phase) {
    case 'work':
      return POMODORO.phase.work(moment.cycle, moment.cycles, left);
    case 'break':
      return POMODORO.phase.break(left);
    case 'paused':
      return POMODORO.phase.paused;
    case 'done':
      return POMODORO.phase.done;
  }
}
