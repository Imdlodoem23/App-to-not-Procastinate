/**
 * No-camera mode (owner: RUNTIME): foreground app/web + keyboard/mouse activity only, ticked
 * at 1 Hz. No absence path; strike causes are `distraction_app` or `doubt_timeout`.
 * DESIGN.md §8.4.
 *
 * | Condition                  | Instant value s        | Cause             |
 * | -------------------------- | ---------------------- | ----------------- |
 * | distraction ≥ 5 s (F_dist) | 0.05                   | `distraction_app` |
 * | idle ≤ L − 60 s            | s_base                 | —                 |
 * | L − 60 s < idle < L        | falls linearly to 0    | `idle` once low   |
 * | idle ≥ L                   | 0                      | `idle`            |
 * | idle unknown               | 0.85                   | —                 |
 *
 * L = `noCameraIdleMs` (× 1.5 while the foreground is a study app, where reading without
 * touching anything is normal) and s_base = 1.0 for a study foreground, else 0.85.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type {
  LowCause,
  MonoMs,
  Observation,
  Observer,
  StudyAiSettings,
  StudyMode,
  TickInput,
} from '../types';
import { clamp01 } from '../util/math';

/** Instant value while a distraction is in the foreground. */
export const NO_CAMERA_DISTRACTION_VALUE = 0.05;
/** Base value with a study app in the foreground, and with anything else. */
export const NO_CAMERA_STUDY_VALUE = 1;
export const NO_CAMERA_OTHER_VALUE = 0.85;
/** Idle unknown (no data from main): neutral, study-leaning. */
export const NO_CAMERA_UNKNOWN_IDLE_VALUE = 0.85;
/** Idle allowance multiplier while a study app is in the foreground. */
export const NO_CAMERA_STUDY_IDLE_FACTOR = 1.5;
/** The value ramps down to 0 over the last minute before the idle limit. */
export const NO_CAMERA_RAMP_MS = 60_000;

const NO_EYES = Object.freeze({ closed: false, yawn: false });
const NO_HINTS: readonly never[] = Object.freeze([]);

export class NoCameraObserver implements Observer {
  readonly mode: StudyMode = 'no-camera';
  private distractionSince: MonoMs | null = null;

  observe(input: TickInput, settings: Readonly<StudyAiSettings>): Observation {
    const now = input.now;
    const { foreground } = input.context;
    const idle = input.context.idleMs;
    const idleMs = typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? idle : null;

    if (foreground === 'distraction') {
      if (this.distractionSince === null || now < this.distractionSince) {
        this.distractionSince = now;
      }
    } else {
      this.distractionSince = null;
    }
    const distractionApp =
      this.distractionSince !== null &&
      now - this.distractionSince >= STUDY_AI_CONSTANTS.distractionConfirmMs;

    const study = foreground === 'study';
    const limit = settings.noCameraIdleMs * (study ? NO_CAMERA_STUDY_IDLE_FACTOR : 1);
    const base = study ? NO_CAMERA_STUDY_VALUE : NO_CAMERA_OTHER_VALUE;
    const threshold = settings.focusScoreThreshold / 100;

    let value: number;
    let cause: LowCause | null = null;
    if (distractionApp) {
      value = NO_CAMERA_DISTRACTION_VALUE;
      cause = 'distraction_app';
    } else if (idleMs === null) {
      value = NO_CAMERA_UNKNOWN_IDLE_VALUE;
    } else if (idleMs >= limit) {
      value = 0;
      cause = 'idle';
    } else if (idleMs > limit - NO_CAMERA_RAMP_MS) {
      value = base * clamp01((limit - idleMs) / NO_CAMERA_RAMP_MS);
      if (value < threshold) cause = 'idle';
    } else {
      value = base;
    }

    return {
      at: now,
      presence: 'no_camera',
      study: value,
      weight: 1,
      cause,
      evidence: {
        phone: false,
        book: false,
        lookingDown: false,
        distractionApp,
        inputActive: idleMs !== null && idleMs < STUDY_AI_CONSTANTS.inputActiveMs,
      },
      eyes: NO_EYES,
      hints: NO_HINTS,
      frame: null,
      rel: null,
    };
  }

  rescore(observation: Observation, _settings: Readonly<StudyAiSettings>): number | null {
    return observation.study;
  }

  reset(): void {
    this.distractionSince = null;
  }
}
