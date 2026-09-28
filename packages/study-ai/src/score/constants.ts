/**
 * Module-internal thresholds of the camera observer (owner: DECISION). DESIGN.md §7.1–7.4.
 * Cross-module values (floor, phone cap, input and distraction timings) live in
 * `STUDY_AI_CONSTANTS`.
 */

// Detector runs (evidence persistence, §7.2)
/** Longest evidence window (the E_phone hold); runs older than this never count by time. */
export const RUN_RING_MS = 8_000;
/** At slow loop levels (one run every 4 s) the last runs are kept this long anyway. */
export const RUN_MAX_AGE_MS = 12_000;
/** Hard cap on stored runs (2 Hz × 12 s). */
export const RUN_RING_MAX = 24;

/**
 * E_phone turns on with the phone in hand in ≥ 2 runs and ≥ 40 % of the runs of the last
 * max(5 s, 2 runs). The detector sees a phone in hand in about 70 % of its runs, so the
 * design's 60 % sometimes waited 8–9 s for a third hit; a false positive still has to last
 * ~20 s to produce even a DUDA.
 */
export const PHONE_SPAN_MS = 5_000;
export const PHONE_MIN_RUNS = 2;
export const PHONE_ENTER_HITS = 2;
export const PHONE_ENTER_SHARE = 0.4;
/**
 * Once on, E_phone stays on while the phone was seen in hand in any run of the last
 * max(8 s, 4 runs). The detector misses a phone in hand one run in three or so, and a
 * dropout must not turn it into «reading» (looking down gets the study floor without
 * E_phone). Eight misses in a row at 1 Hz are needed to let go; putting the phone away
 * still clears DUDA well within its 30 s.
 */
export const PHONE_HOLD_MS = 8_000;
export const PHONE_HOLD_MIN_RUNS = 4;
/** A phone box that has not moved for this long is lying on the desk, not in hand. */
export const PHONE_STILL_MS = 20_000;

/** E_book: book ≥ 0.35 in ≥ 50 % of the runs of the last max(6 s, 2 runs). */
export const BOOK_SPAN_MS = 6_000;
export const BOOK_MIN_RUNS = 2;
export const BOOK_SCORE = 0.35;
export const BOOK_SHARE = 0.5;

// Presence (§7.1)
/** A person in any of the last N detector runs keeps a face-less user `hidden`. */
export const PERSON_RUNS = 3;
/** Motion inside the last face box that still means «someone is there». */
export const MOTION_NEAR_FACE = 0.02;
/** …only if the face was seen this recently. */
export const FACE_RECENT_MS = 10_000;

// Looking down (§7.2)
export const LOOK_DOWN_DPITCH = -12;
export const LOOK_DOWN_BLEND = 0.45;
export const LOOK_DOWN_MAX_YAW = 35;
/** Without a baseline (generic classifier not ready yet): absolute pitch. */
export const LOOK_DOWN_ABS_PITCH = -20;

// Hidden face: last-pose rule (§7.3)
/** The last visible pose must be this recent when the face is lost. */
export const HIDDEN_LOOKBACK_MS = 2_000;
/** Head down (writing): the study floor for up to this much continuous hidden time. */
export const HIDDEN_DOWN_MAX_MS = 600_000;
export const HIDDEN_TURNED_YAW = 35;
/** Turned away, or any hidden stretch past its allowance. */
export const HIDDEN_LOW_VALUE = 0.2;
/** Unknown last pose: (θ + margin)/100 for this long, then `HIDDEN_LOW_VALUE`. */
export const HIDDEN_UNKNOWN_MS = 20_000;
export const HIDDEN_UNKNOWN_MARGIN = 5;

// Fusion (§7.3)
/** A distraction in the foreground keeps this share of the «looking at the screen» mass. */
export const DISTRACTION_SCREEN_KEEP = 0.1;

// Eyes (§7.4)
export const EYES_MIN_QUALITY = 0.5;
/** Eyes looking down (reading) lower the lids: never a «closed» frame. */
export const EYES_MAX_LOOK_DOWN = 0.5;
export const YAWN_JAW = 0.6;

// Stale profile (§7.4)
export const STALE_WINDOW_MS = 120_000;
export const STALE_MIN_FRAMES = 60;
export const STALE_AWAY_SHARE = 0.7;

// Hints (§7.3)
export const CANT_SEE_HIDDEN_MS = 60_000;
export const CANT_SEE_TRUNCATED = 0.3;

/** Observer time steps are capped at this (a frame never represents more than 1 s). */
export const OBSERVE_MAX_STEP_MS = 1_000;
