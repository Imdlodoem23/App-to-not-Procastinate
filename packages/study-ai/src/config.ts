/**
 * Settings resolution and the cross-module constants of DESIGN.md. Module-internal thresholds
 * (pose degrees, detector scores, luma limits…) live in each owner's folder, not here.
 */
import { STUDY_RULES, clampTunable, type TunableRange } from '@centrate/shared/points';
import type { StudyAiSettings } from './types';

/** Ranges this package adds to `STUDY_RULES` (candidates to move to shared later). */
export const STUDY_AI_RANGES: Readonly<{
  focusWindowMs: Readonly<TunableRange>;
  noCameraIdleMs: Readonly<TunableRange>;
}> = Object.freeze({
  focusWindowMs: Object.freeze({ min: 10_000, max: 20_000, default: 15_000 }),
  noCameraIdleMs: Object.freeze({ min: 180_000, max: 1_200_000, default: 480_000 }),
});

/** Clamps every field; missing or non-finite values take the default. */
export function resolveStudyAiSettings(
  input?: Partial<StudyAiSettings>,
): Readonly<StudyAiSettings> {
  const value = (key: keyof StudyAiSettings): number => {
    const raw = input?.[key];
    return typeof raw === 'number' ? raw : Number.NaN;
  };
  return Object.freeze({
    doubtAfterMs: clampTunable(value('doubtAfterMs'), STUDY_RULES.doubtAfterMs),
    strikeAfterDoubtMs: clampTunable(value('strikeAfterDoubtMs'), STUDY_RULES.strikeAfterDoubtMs),
    noFaceStrikeMs: clampTunable(value('noFaceStrikeMs'), STUDY_RULES.noFaceStrikeMs),
    focusScoreThreshold: clampTunable(
      value('focusScoreThreshold'),
      STUDY_RULES.focusScoreThreshold,
    ),
    focusWindowMs: clampTunable(value('focusWindowMs'), STUDY_AI_RANGES.focusWindowMs),
    noCameraIdleMs: clampTunable(value('noCameraIdleMs'), STUDY_AI_RANGES.noCameraIdleMs),
  });
}

export const DEFAULT_STUDY_AI_SETTINGS: Readonly<StudyAiSettings> = resolveStudyAiSettings();

/**
 * Fixed values shared by more than one module (not user-tunable). Tests across modules rely
 * on them, so change them only through the coordinator.
 */
export const STUDY_AI_CONSTANTS = Object.freeze({
  // Score and hysteresis (DECISION)
  /** Score points above θ needed to leave `low`. */
  hysteresis: 8,
  /** Short window for fast recovery. */
  shortWindowMs: 3_000,
  /** Short score ≥ min(θ + this, 90) also leaves `low`. */
  fastRecoveryMargin: 16,
  /** `low` needs the long window at least this full. */
  minWindowFill: 0.5,
  /** Looking down / book floor = min(studyFloorMax, θ + studyFloorMargin) / 100. */
  studyFloorMargin: 20,
  studyFloorMax: 95,
  /** Keyboard/mouse weak signal: +0.10 to the instant value. */
  activityBonus: 0.1,
  /** Idle under this = input active. */
  inputActiveMs: 15_000,
  /** Foreground distraction this long = F_dist. */
  distractionConfirmMs: 5_000,
  /** Phone in hand caps the instant value here, over every floor. */
  phoneCap: 0.1,
  /** Share of the low period that names the strike cause (phone, then distraction app). */
  causeShare: 0.4,

  // State machine timing (DECISION)
  warmupMs: 10_000,
  returnWarmupMs: 3_000,
  /** Absent/covered this long → `away` («No te veo»). */
  awayEnterMs: 3_000,
  /** Present this long → leave `away`. */
  presentConfirmMs: 2_000,
  /** The absence accumulator resets only after this much continuous presence. */
  absenceResetMs: 10_000,
  /** A stalled or failed camera counts as absent after this long (fails closed). */
  cameraLostMs: 10_000,
  /** A tick gap longer than this (suspend, frozen renderer) resets timers; never punished. */
  gapResetMs: 5_000,
  /** Credit per tick is capped at this. */
  maxStepMs: 2_000,
  /** Local grace after a strike (same as the guardian cooldown). */
  strikeGraceMs: STUDY_RULES.strikeCooldownMs,

  // Eyes (DECISION)
  eyesClosedMs: 20_000,
  eyesClosedShare: 0.8,
  perclosWindowMs: 60_000,
  perclosLimit: 0.3,
  yawnMinMs: 2_000,
  yawnsForBreak: 3,
  yawnWindowMs: 300_000,
  breakSuggestEveryMs: 600_000,

  // Hints (DECISION debounces, RUNTIME adds its own)
  hintOnMs: 5_000,
  hintOffMs: 5_000,

  // «¡Estaba estudiando!» (DECISION selects, LEARNING retrains)
  feedbackPerSession: 5,
  feedbackBufferMs: 90_000,
  feedbackEpisodeMaxMs: 60_000,
  feedbackMaxFrames: 30,
  feedbackRowsPerClass: 300,

  // Perception holds (PERCEPTION)
  objectHoldMs: 4_000,
  lumaHoldMs: 2_000,

  // Calibration (LEARNING + RUNTIME)
  calibrationDurationMs: 20_000,
  calibrationSettleMs: 2_000,
  calibrationTailMs: 1_000,
  calibrationIntervalMs: 250,
  calibrationObjectEvery: 2,

  // Runtime (RUNTIME)
  reportEveryMs: 1_000,
  noCameraTickMs: 1_000,
  lumaEveryMs: 1_000,
  /** Phase ≠ work this long → camera track stopped («la cámara no vigila»). */
  breakCameraOffMs: 10_000,
  cameraRetryMs: 10_000,
  /** Camera failing this long → offer «Continuar sin cámara». */
  cameraOfferNoCameraMs: 30_000,
  /** Main stops heartbeating after this long without loop progress. */
  deadLoopMs: 60_000,
  minFps: 2,
  maxFps: 4,
});

export type StudyAiConstants = typeof STUDY_AI_CONSTANTS;
