/**
 * The calibration checklist the wizard shows (owner: LEARNING; exported from the pure entry
 * for Electron main): the five situations as rows «Pendiente → Grabando 12 s → Hecho»
 * (PROMPT.md §10), from the saved profile, this wizard's recordings and the recording in
 * progress. Strings live in the desktop i18n; this returns states and numbers only.
 *
 * Main never parses a profile (`parseProfile` may retrain it: seconds of CPU, HANDOFF §5), so
 * `profileStatus` reads the saved clips from the JSON without training anything, and
 * `calibrationSteps` takes that status and the `CalibrationRecordingSummary`s that cross IPC.
 */
import { CALIBRATION_CLASSES } from '../types';
import type {
  CalibrationClass,
  CalibrationIssue,
  CalibrationProfile,
  CalibrationProgress,
  IsoUtc,
} from '../types';
import {
  CAMERA_KEY_RE,
  ISO_RE,
  PROFILE_FORMAT,
  PROFILE_MAX_BYTES,
  PROFILE_VERSION,
} from './constants';

/** What main can know about `profile.json` without parsing it for real. */
export interface ProfileStatus {
  /**
   * The file looks like a profile of the current format and version, for a known camera. A
   * cheap check: the analysis window may still reject it (then the `recalibrate` hint).
   */
  ok: boolean;
  /** Situations with a saved clip (all false when not `ok`). */
  clips: Readonly<Record<CalibrationClass, boolean>>;
  /** Last training (`updatedAt`), or `null`. */
  updatedAt: IsoUtc | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function clipsOf(saved: (cls: CalibrationClass) => boolean): Record<CalibrationClass, boolean> {
  return Object.fromEntries(CALIBRATION_CLASSES.map((cls) => [cls, saved(cls)])) as Record<
    CalibrationClass,
    boolean
  >;
}

/**
 * The saved clips of `profile.json` (its content, or `null`), for the wizard rows and the
 * «Con cámara · calibrado» header. One `JSON.parse`, never a retrain: safe on main's thread.
 */
export function profileStatus(profileJson: string | null | undefined): ProfileStatus {
  const none: ProfileStatus = { ok: false, clips: clipsOf(() => false), updatedAt: null };
  if (typeof profileJson !== 'string' || profileJson.length > PROFILE_MAX_BYTES) return none;
  let raw: unknown;
  try {
    raw = JSON.parse(profileJson);
  } catch {
    return none;
  }
  if (!isRecord(raw) || raw.format !== PROFILE_FORMAT || raw.version !== PROFILE_VERSION) {
    return none;
  }
  const camera = raw.camera;
  const clips = raw.clips;
  if (!isRecord(camera) || typeof camera.key !== 'string' || !CAMERA_KEY_RE.test(camera.key)) {
    return none;
  }
  if (!isRecord(clips)) return none;
  const updatedAt =
    typeof raw.updatedAt === 'string' && ISO_RE.test(raw.updatedAt) ? raw.updatedAt : null;
  return { ok: true, clips: clipsOf((cls) => isRecord(clips[cls])), updatedAt };
}

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

/** A recording of this wizard run: a `SituationRecording`, or the IPC `CalibrationRecordingSummary`. */
export interface RecordedSituation {
  issues: readonly CalibrationIssue[];
}

export interface CalibrationStepsInput {
  /** The saved profile (`profileStatus` in main, or a parsed profile), or `null`. */
  profile: Pick<CalibrationProfile, 'clips'> | ProfileStatus | null;
  /** Recordings made in this wizard run (`calibration_recorded` summaries in main). */
  recordings: Readonly<Partial<Record<CalibrationClass, RecordedSituation>>>;
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
    const clip: unknown = input.profile?.clips[cls];
    const saved = !input.fresh && (clip === true || (typeof clip === 'object' && clip !== null));
    const done = recording !== undefined ? recordedOk : saved;
    return { cls, state: done ? 'done' : 'pending', remainingS: null, issues };
  });
}

/** The first situation still pending, in recording order, or `null` when all are done. */
export function nextPendingSituation(steps: readonly CalibrationStep[]): CalibrationClass | null {
  return steps.find((s) => s.state === 'pending')?.cls ?? null;
}
