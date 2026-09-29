/**
 * LEARNING-internal constants of the classifier (DESIGN.md §6.3–6.9). Cross-module values
 * live in `STUDY_AI_CONSTANTS`; these are tuned here and covered by test/classifier.
 */
import type { ClassifierThresholds, EyeModel } from '../types';

// ---------------------------------------------------------------------------------------
// Stored rows (§6.3)
// ---------------------------------------------------------------------------------------

/** Angles are stored at 0.1° … */
export const ROW_ANGLE_STEP = 0.1;
/** … and every other value at 0.001, so a JSON round trip is exact. */
export const ROW_VALUE_STEP = 0.001;
/** `lumaMean` / `lumaStd` when the frame carried no luma sample. */
export const LUMA_UNKNOWN = -1;
/** Angles are clamped to ±180° and box values to this range before storage. */
export const ROW_BOX_LIMIT = 4;

// ---------------------------------------------------------------------------------------
// Classifier vector x (§6.5)
// ---------------------------------------------------------------------------------------

/** Order of the 16 entries of the classifier vector x. */
export const X_COLUMNS = [
  'face',
  'dyaw',
  'dpitch',
  'droll',
  'gazeX',
  'gazeY',
  'dcx',
  'dcy',
  'logScale',
  'blink',
  'phone',
  'phoneNear',
  'phoneMoving',
  'book',
  'person',
  'hiddenPerson',
] as const;
export const X_DIM = X_COLUMNS.length;

/** Indices into x. */
export const XI = Object.freeze({
  face: 0,
  dyaw: 1,
  dpitch: 2,
  droll: 3,
  gazeX: 4,
  gazeY: 5,
  dcx: 6,
  dcy: 7,
  logScale: 8,
  blink: 9,
  phone: 10,
  phoneNear: 11,
  phoneMoving: 12,
  book: 13,
  person: 14,
  hiddenPerson: 15,
});

/** Entries that only mean something with a face: standardised values are multiplied by face. */
export const FACE_DEPENDENT: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
/** Angle entries (scale floor in degrees). */
export const ANGLE_ENTRIES: readonly number[] = [1, 2, 3];

/** Robust scale floors: max(IQR / 1.349, floor). */
export const SCALE_FLOOR_ANGLE = 3;
export const SCALE_FLOOR_FACE = 0.05;
/**
 * Horizontal gaze: reading across one screen moves the eyes by about ±0.3, so a calibration
 * that looked at one spot (IQR ≈ 0) must not turn a 0.1 eye movement into several units.
 */
export const SCALE_FLOOR_GAZE = 0.15;
/**
 * Detector scores and indicators (face, phone, book, person…) are mostly 0 or mostly 1, so
 * their IQR is often 0. A 0.25 floor keeps a 0.8 score at ~3 standard units instead of 16.
 */
export const SCALE_FLOOR_SCORE = 0.25;
/** Standardised values are clipped here, so a ±1e6 input still gives sane probabilities. */
export const Z_CLIP = 8;
/** Quadratic terms dyaw², dpitch², dyaw·dpitch are divided by this (keeps φ well scaled). */
export const QUAD_DIVISOR = 4;

/** RBF anchors over the standardised (dyaw, dpitch, gazeX) of study rows. */
export const MAX_ANCHORS = 4;
export const RBF_ENTRIES: readonly number[] = [1, 2, 4];
export const SIGMA_FACTOR = 1.5;
export const SIGMA_FLOOR = 0.5;
export const KMEANS_ITERATIONS = 25;
export const KMEANS_SEED = 0x5eed_c3a7;

/** φ dimension for K anchors: x, three quadratic terms and K RBF terms. */
export function phiDim(anchors: number): number {
  return X_DIM + 3 + anchors;
}

// ---------------------------------------------------------------------------------------
// Training (§6.6–6.8)
// ---------------------------------------------------------------------------------------

/** λ grid, from the most to the least regularised (the CV path warm-starts along it). */
export const LAMBDA_GRID: readonly number[] = [1e-1, 1e-2, 1e-3, 1e-4];
export const CV_FOLDS = 4;
export const TRAIN_MAX_ITER = 2_000;
export const TRAIN_TOL = 1e-5;
/** CV fits only rank λ values, so they stop earlier. */
export const CV_MAX_ITER = 400;
export const CV_TOL = 1e-4;
/** «¡Estaba estudiando!» warm retrain. */
export const FEEDBACK_MAX_ITER = 300;

export const PSEUDO_ROW_WEIGHT = 0.3;
/**
 * `phone` rows where the detector saw no phone (score under the learned threshold) weigh this
 * much: they only show a posture, usually the reading one, and looking down is studying unless
 * a phone is visible (PROMPT.md §8).
 */
export const PHONE_UNSEEN_WEIGHT = 0.2;
/** Mirrored `away` rows (the other side of the room) count as much as recorded ones. */
export const MIRROR_ROW_WEIGHT = 1;
export const FEEDBACK_ROW_WEIGHT = 1.5;
/** A class's feedback weight is capped at this share of its calibration weight. */
export const FEEDBACK_CAP_SHARE = 0.5;
export const AUGMENT_SEED = 0xa11ce5;
/** Augmentation pose noise (degrees, sd) and blendshape noise (× the class sd). */
export const AUGMENT_POSE_SD = 3;
export const AUGMENT_EYE_FACTOR = 0.5;
/**
 * Reading across the screen or the page: copies of `screen`/`paper` face rows with the eyes
 * shifted uniformly within ±`AUGMENT_SCAN_GAZE` and the head within ±`AUGMENT_SCAN_YAW`°,
 * same label. The `screen` clip is usually recorded looking at one spot (often the wizard's
 * own preview), so without them a sustained eyes-only shift to one side of the same screen
 * (a PDF on one half, notes in a side window) reads as looking away.
 */
export const AUGMENT_SCAN_GAZE = 0.3;
export const AUGMENT_SCAN_YAW = 10;
export const AUGMENT_SCAN_SEED = 0x5ca9_9a2e;
/** Synthetic phone copies of study rows. */
export const AUGMENT_PHONE_SCORE = 0.8;
/** Book toggled to this value (or to 0) on copies of paper rows. */
export const AUGMENT_BOOK_SCORE = 0.7;

/** Trust π: additive smoothing towards `TRUST_PRIOR` with `TRUST_PSEUDO` counts, capped. */
export const TRUST_PRIOR = 0.1;
export const TRUST_PSEUDO = 10;
export const TRUST_CAP = 0.8;

/** CV binary balanced accuracy under this adds `weak_separation`. */
export const WEAK_SEPARATION = 0.85;

// ---------------------------------------------------------------------------------------
// Thresholds and eyes (§6.4)
// ---------------------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS: Readonly<ClassifierThresholds> = Object.freeze({
  phone: 0.5,
  person: 0.5,
});
export const THRESHOLD_MARGIN = 0.1;
export const PHONE_THRESHOLD_MIN = 0.45;
export const PHONE_THRESHOLD_MAX = 0.8;
export const PERSON_THRESHOLD_MIN = 0.4;
export const PERSON_THRESHOLD_MAX = 0.8;

export const PROFILE_CLOSED_DELTA = 0.35;
export const EYES_UNRELIABLE_SD = 0.15;
export const EYES_UNRELIABLE_MEDIAN = 0.5;
/** Theil–Sen: at most this many points (evenly subsampled), pairs at least this far apart. */
export const THEIL_SEN_MAX_POINTS = 200;
export const THEIL_SEN_MIN_DX = 0.5;
export const BLINK_SLOPE_LIMIT = 0.02;

/**
 * Generic eye model (DESIGN.md §6.9). The generic classifier judges the eyes online from
 * the session's calm frames with the profile's glare rule; its intercept follows their
 * median. Until it has 20 values the eyes are unknown and drowsiness is off.
 */
export const GENERIC_EYES: Readonly<EyeModel> = Object.freeze({
  reliable: true,
  blinkFit: Object.freeze([0.15, -0.004] as const),
  closedDelta: 0.45,
});
export const GENERIC_EYES_UNKNOWN: Readonly<EyeModel> = Object.freeze({
  ...GENERIC_EYES,
  reliable: false,
});
/** A normal distribution's IQR is 1.349 sd (robust sd = IQR / 1.349). */
export const IQR_PER_SD = 1.349;

// ---------------------------------------------------------------------------------------
// Personal classifier runtime (§6.5)
// ---------------------------------------------------------------------------------------

/** Slow in-memory baseline drift: ±10°, time constant 10 min. */
export const DRIFT_MAX_DEG = 10;
export const DRIFT_TAU_MS = 600_000;
/** Only frames this close to the baseline, and this sure of `screen`, move the drift. */
export const DRIFT_MAX_DYAW = 20;
export const DRIFT_MAX_DPITCH = 15;
export const DRIFT_MIN_SCREEN = 0.6;
/** dt between observed frames is capped here (a gap never jumps the drift). */
export const OBSERVE_MAX_DT_MS = 1_000;

// ---------------------------------------------------------------------------------------
// Generic classifier (§6.9)
// ---------------------------------------------------------------------------------------

/** The opening baseline is the median of the first 20 s of face frames (per level). */
export const GENERIC_BASELINE_MS = 20_000;
export const GENERIC_READY_MS = 3_000;
/** Samples kept per opening-baseline buffer (20 s at 4 fps is 80). */
export const GENERIC_MAX_SAMPLES = 400;
export const GENERIC_NEUTRAL_SCREEN = 0.8;
/**
 * A calm frame faces a screen: the eyes are not looking down and the head is not pitched
 * down (absolute pitch, as DECISION's looking-down rule without a baseline). Writing or
 * reading right after the click on «Empezar» therefore never becomes the screen pose.
 */
export const GENERIC_CALM_MAX_LOOK_DOWN = 0.45;
export const GENERIC_CALM_MIN_PITCH = -20;
/**
 * Study directions (one per screen): at most this many at once, the opening baseline
 * included. The least recently looked-at one makes room for a new one.
 */
export const GENERIC_MAX_DIRECTIONS = 3;
/** Input is fresh under this idle time: the user is at the keyboard or mouse right now. */
export const GENERIC_FRESH_INPUT_MS = 2_000;
/** A new direction counts after this much calm face time with fresh input… */
export const GENERIC_DIRECTION_CONFIRM_MS = 3_000;
/** …without a gap longer than this between its samples (otherwise it starts over). */
export const GENERIC_CANDIDATE_GAP_MS = 5_000;
/** Unconfirmed candidate directions kept at once. */
export const GENERIC_MAX_CANDIDATES = 2;
/**
 * Angular radius (degrees, yaw/pitch) of a direction: samples this close feed it, and two
 * directions whose centres get this close merge. Two screens 30° apart stay apart.
 */
export const GENERIC_DIRECTION_RADIUS = 12;
/** Samples per direction: its centre is a rolling median of the last 20 s at 4 fps. */
export const GENERIC_DIRECTION_SAMPLES = 80;
/** Blink values kept for the online eye model, and how many it needs to judge the eyes. */
export const GENERIC_EYE_SAMPLES = 240;
export const GENERIC_EYE_MIN_SAMPLES = 20;
/** pStudy = exp(−(max(0,|dyaw|−10)/30)⁴ − (max(0,dpitch−15)/15)⁴). */
export const GENERIC_YAW_FREE = 10;
export const GENERIC_YAW_SCALE = 30;
export const GENERIC_UP_FREE = 15;
export const GENERIC_UP_SCALE = 15;
/** Below this dpitch the pose is implausible and pStudy decays again. */
export const GENERIC_DOWN_LIMIT = -70;
export const GENERIC_DOWN_SCALE = 15;
/** Paper share of pStudy ramps from 0 at dpitch −6° to 1 at −18°. */
export const GENERIC_PAPER_FROM = -6;
export const GENERIC_PAPER_TO = -18;
/**
 * A pose more than this many degrees below every best-fitting direction (where it already
 * starts to count as paper against each of them) looks at the desk, below all the screens:
 * it is judged against the highest of them, the one closest to eye level. Against the
 * nearest (the lowest) a direction learned from typing below the screen would make writing
 * in a notebook «not down».
 */
export const GENERIC_BELOW_MARGIN = -GENERIC_PAPER_FROM;
/**
 * Directions whose rule cost is within this of the best one fit about as well (pStudy within
 * 5 %): the head faces each of them (|dyaw| up to about 24°).
 */
export const GENERIC_FIT_TOLERANCE = 0.05;
/**
 * No face but a person (both classifiers): the study share is at most this, so DECISION's
 * last-pose rule (head down writing → floor, turned → 0.2), the book and the keyboard decide.
 * A classifier never vouches for studying without seeing a face: otherwise turning round or
 * hiding the face would read as «writing», whatever the observer's `max(p, last pose)` says.
 */
export const HIDDEN_STUDY_CAP = 0.2;
/** Visible phone evidence → p_phone = this. */
export const GENERIC_PHONE_P = 0.9;
/** A phone lying still this long is on the desk, not in hand. */
export const PHONE_STILL_MS = 20_000;
