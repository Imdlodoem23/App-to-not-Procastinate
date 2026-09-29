/**
 * LEARNING-internal constants of calibration and profiles (DESIGN.md §6.1–6.2, §6.11).
 */

/** Row cap per clip (20 s at 4 fps minus settle and tail is 68). */
export const CLIP_MAX_ROWS = 80;
/** Hard cap of frames buffered while recording (a runaway frame rate cannot grow memory). */
export const CLIP_BUFFER_LIMIT = 1_000;

// Issue thresholds (§6.2)
export const MIN_CLIP_ROWS = 40;
/** `no_face`: face or person present in fewer rows than this share. */
export const MIN_PRESENT_SHARE = 0.7;
/** A person score this high counts as someone there for the per-clip checks. */
export const PERSON_PRESENT_SCORE = 0.5;
/**
 * `still_visible` (absent clip): face, or a person above what the learned person threshold
 * can absorb (p95 + 0.1 ≤ 0.8), in more than this share of rows.
 */
export const ABSENT_MAX_SHARE = 0.2;
export const ABSENT_PERSON_SCORE = 0.7;
export const DARK_MEDIAN_LUMA = 0.1;
export const MAX_COVERED_SHARE = 0.3;
/** `phone_not_seen`: phone ≥ 0.3 in fewer detector runs than this share. */
export const PHONE_SEEN_SCORE = 0.3;
export const PHONE_SEEN_SHARE = 0.2;
/** `same_as_screen`: away median |dyaw| and |dpitch| both under these. */
export const AWAY_MIN_DYAW = 12;
export const AWAY_MIN_DPITCH = 10;
/** `unstable`: screen yaw or pitch IQR above this. */
export const SCREEN_MAX_IQR = 15;
/**
 * `narrow_gaze`: screen `gazeX` IQR under this. The eyes stayed on one spot (often the
 * wizard's own preview) instead of reading across the screen. Training copes with it (scan
 * augmentation, gaze scale floor), but a clip that reads across the screen is better: the
 * wizard asks to follow a moving target or to read from one edge to the other.
 */
export const SCREEN_MIN_GAZE_IQR = 0.05;
/** Live issues are reported once this many rows (or detector runs) exist. */
export const LIVE_MIN_ROWS = 8;
export const LIVE_MIN_RUNS = 10;

// Profile file (§6.11)
export const PROFILE_FORMAT = 'centrate-study-ai-profile';
export const PROFILE_VERSION = 1;
export const PROFILE_MAX_BYTES = 512 * 1024;
export const PROFILE_MAX_ROWS = 5_000;
export const CAMERA_KEY_RE = /^sha256:[0-9a-f]{64}$/;
/** `IsoUtc` of @centrate/shared: exactly millisecond precision, UTC. */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Same camera: the frame aspect may differ by this much. */
export const CAMERA_ASPECT_TOLERANCE = 0.02;
