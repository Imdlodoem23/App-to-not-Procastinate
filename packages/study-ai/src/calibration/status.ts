/**
 * The calibration checklist the wizard shows (owner: LEARNING): the five situations as rows
 * «Pendiente → Grabando 12 s → Hecho» (PROMPT.md §10), from the saved profile, this wizard's
 * recordings and the recording in progress. Strings live in the desktop i18n; this returns
 * states and numbers only.
 */
import { CALIBRATION_CLASSES } from '../types';
import type {
  CalibrationClass,
  CalibrationIssue,
  CalibrationProfile,
  CalibrationProgress,
  SituationRecording,
} from '../types';

/** Pendiente, Grabando, Hecho. */
export type CalibrationStepState = 'pending' | 'recording' | 'done';

export interface CalibrationStep {
  cls: CalibrationClass;
  state: CalibrationStepState;
  /** Whole seconds left while recording («Grabando 12 s»), else `null`. */
  remainingS: number | null;
  /** Issues of this wizard's latest recording of the situation (an error keeps it pending). */
  issues: readonly CalibrationIssue[];
}

export interface CalibrationStepsInput {
  /** The saved profile, or `null`. */
  profile: CalibrationProfile | null;
  /** Recordings made in this wizard run. */
  recordings: Readonly<Partial<Record<CalibrationClass, SituationRecording>>>;
  /** The recording in progress, or `null`. */
  active: CalibrationProgress | null;
  /** «Recalibrar» (all five): the saved clips no longer count. */
  fresh?: boolean;
}

export function calibrationSteps(input: CalibrationStepsInput): CalibrationStep[] {
  return CALIBRATION_CLASSES.map((cls): CalibrationStep => {
    const active = input.active;
    const recording = input.recordings[cls];
    const issues = recording?.issues ?? [];
    if (active && active.cls === cls && active.phase !== 'done') {
      return {
        cls,
        state: 'recording',
        remainingS: Math.max(0, Math.ceil(active.remainingMs / 1_000)),
        issues: [],
      };
    }
    const recordedOk = recording !== undefined && !issues.some((i) => i.severity === 'error');
    const saved = !input.fresh && input.profile !== null && input.profile.clips[cls] !== null;
    const done = recording !== undefined ? recordedOk : saved;
    return { cls, state: done ? 'done' : 'pending', remainingS: null, issues };
  });
}

/** The first situation still pending, in recording order, or `null` when all are done. */
export function nextPendingSituation(steps: readonly CalibrationStep[]): CalibrationClass | null {
  return steps.find((s) => s.state === 'pending')?.cls ?? null;
}
