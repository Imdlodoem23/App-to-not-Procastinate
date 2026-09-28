/**
 * PERCEPTION-internal thresholds (DESIGN.md §5). Cross-module values (hold times) live in
 * `STUDY_AI_CONSTANTS`; everything here only changes how features are measured.
 */

// ---------------------------------------------------------------------------------------
// MediaPipe task options (§5.3, §5.4)
// ---------------------------------------------------------------------------------------

export const FACE_LANDMARKER_OPTIONS = Object.freeze({
  runningMode: 'VIDEO' as const,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  minFaceDetectionConfidence: 0.4,
  minFacePresenceConfidence: 0.4,
  minTrackingConfidence: 0.4,
});

/** The only COCO labels the object detector reports (all three exist in EfficientDet-Lite0). */
export const OBJECT_CATEGORIES = Object.freeze(['person', 'cell phone', 'book'] as const);
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

export const OBJECT_DETECTOR_OPTIONS = Object.freeze({
  runningMode: 'VIDEO' as const,
  scoreThreshold: 0.3,
  maxResults: 6,
});

// ---------------------------------------------------------------------------------------
// Face selection and measures (§5.3)
// ---------------------------------------------------------------------------------------

/** Faces whose landmark box is shorter than this (share of the frame height) are ignored. */
export const MIN_FACE_BOX_H = 0.08;
/** Continuity bonus: score = area × (1 + this × IoU with the previous user box). */
export const FACE_CONTINUITY_WEIGHT = 2;
/** The last user face box is remembered this long (face choice, phone and motion rules). */
export const FACE_MEMORY_MS = 10_000;
/** Below this IoU with the previous frame's box, the face is a new one: jitter restarts at 0. */
export const JITTER_SAME_FACE_IOU = 0.3;
/** Landmarks are clamped to this range before the box is computed (a truncated face). */
export const LANDMARK_MIN = -1;
export const LANDMARK_MAX = 2;

/**
 * About 20 landmarks of the 478-point mesh that barely move with expressions: eye corners,
 * nose bridge and tip, forehead and the sides of the face. Jitter is measured on these.
 */
export const STABLE_LANDMARKS = Object.freeze([
  1, 2, 4, 5, 6, 8, 9, 10, 33, 127, 133, 151, 168, 195, 197, 234, 263, 356, 362, 454,
]);

// ---------------------------------------------------------------------------------------
// Objects and the phone tracker (§5.4)
// ---------------------------------------------------------------------------------------

/** A phone box must cover at least this share of the frame (0.4 %). */
export const MIN_PHONE_AREA = 0.004;
/** A person box must cover at least this share of the frame (5 %). */
export const MIN_PERSON_AREA = 0.05;
/** Near the face: centre within cx ± this × face width… */
export const PHONE_NEAR_X = 2.5;
/** …and between cy − UP × face height and cy + DOWN × face height (or overlapping it). */
export const PHONE_NEAR_UP = 0.5;
export const PHONE_NEAR_DOWN = 3;
/** Moving: the centre moved more than this × the box diagonal since the previous sighting… */
export const PHONE_MOVE_DIAG = 0.25;
/** …or the area changed by more than this share. */
export const PHONE_MOVE_AREA = 0.3;
/** Still: IoU with the previous sighting at least this (a phone lying on the desk). */
export const PHONE_STILL_IOU = 0.8;
/**
 * A phone missed by a few detector runs is still the same phone when it reappears within
 * this time, so a flickering detection on a phone lying on the desk keeps its `stillMs`.
 */
export const PHONE_TRACK_MS = 5_000;

// ---------------------------------------------------------------------------------------
// Luma (§5.5)
// ---------------------------------------------------------------------------------------

export const LUMA_THUMB_WIDTH = 32;
export const LUMA_THUMB_HEIGHT = 24;
/** Covered: spatialStd < this ∧ (mean < COVERED_DARK ∨ temporalDiff < COVERED_STATIC). */
export const COVERED_STD = 0.025;
export const COVERED_DARK = 0.08;
export const COVERED_STATIC = 0.004;
/** Low light: mean < this and not covered. */
export const LOW_LIGHT_MEAN = 0.18;
/** The face box is enlarged by this factor for `motionNearFace`. */
export const MOTION_BOX_SCALE = 2;
/** Low light must hold this long before detector inputs are brightened. */
export const LOW_LIGHT_BOOST_AFTER_MS = 5_000;
/** Brightness gain g = clamp(TARGET / mean, 1, MAX_GAIN). */
export const LOW_LIGHT_TARGET_MEAN = 0.4;
export const LOW_LIGHT_MAX_GAIN = 3;
export const LOW_LIGHT_CONTRAST = 1.1;

// ---------------------------------------------------------------------------------------
// Frame quality (§5.6)
// ---------------------------------------------------------------------------------------

export const QUALITY_MIN = 0.2;
export const QUALITY_MAX = 1;
export const QUALITY_TRUNCATED_WEIGHT = 0.5;
/** Jitter at which the jitter penalty reaches its cap. */
export const QUALITY_JITTER_SCALE = 0.02;
export const QUALITY_JITTER_CAP = 0.4;
export const QUALITY_LOW_LIGHT_PENALTY = 0.2;
/** No face but a person in view. */
export const QUALITY_PERSON_ONLY = 0.6;

// ---------------------------------------------------------------------------------------
// Camera (§5.8)
// ---------------------------------------------------------------------------------------

export const CAMERA_DEFAULT_WIDTH = 320;
export const CAMERA_DEFAULT_HEIGHT = 240;
export const CAMERA_DEFAULT_FPS = 5;
export const CAMERA_MAX_FPS = 10;
/** `next()` resolves to `null` when no frame arrives within this time. */
export const FRAME_TIMEOUT_MS = 2_000;
/** Status `stalled` after this long without frames (or while the track is muted). */
export const STALL_AFTER_MS = 3_000;
/** A camera that has not delivered its first frame after this long is `stalled`. */
export const FIRST_FRAME_TIMEOUT_MS = 5_000;
/** Largest frame side the extractor accepts as real (larger values are broken inputs). */
export const MAX_FRAME_SIDE = 16_384;
/** Frames larger than this × the requested size are scaled down before analysis. */
export const DOWNSCALE_OVER = 1.5;
