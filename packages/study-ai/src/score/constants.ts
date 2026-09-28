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
/**
 * Up to 60° to the side (a notebook or a textbook next to the laptop), looking down needs the
 * head clearly down (relative pitch ≤ −20°, or absolute ≤ −25° without a baseline), or
 * moderately down (≤ −12° / −20°) with the eyes down too: relative to a typing pose (itself
 * ~15° down) writing at the side is only ~−24°. Writing or reading there is studying; the
 * generic rule alone would call it «away» (pStudy 0.37 at 40°). Eyes down with a level head
 * keep the 35° gate. The phone cap still overrides the floor.
 */
export const LOOK_DOWN_SIDE_DPITCH = -20;
export const LOOK_DOWN_SIDE_ABS_PITCH = -25;
export const LOOK_DOWN_SIDE_MAX_YAW = 60;

// Hidden face: last-pose rule (§7.3)
/** The last visible pose must be this recent when the face is lost. */
export const HIDDEN_LOOKBACK_MS = 2_000;
/** Head down (writing): the study floor for up to this much continuous hidden time. */
export const HIDDEN_DOWN_MAX_MS = 600_000;
/**
 * …but only while the user shows signs of life: keyboard or mouse, or motion where the face
 * was (`motionNearFace` ≥ `HIDDEN_ACTIVE_MOTION`). After `HIDDEN_STILL_MS` without either,
 * a head down on the desk is asleep, not writing: its frames become drowsy candidates (not
 * pushed, timers frozen, `suggest_break{eyes_closed}`, no focus credit), and only after
 * `HIDDEN_ASLEEP_MAX_MS` of hidden time does the absence path take over.
 */
export const HIDDEN_STILL_MS = 90_000;
export const HIDDEN_ACTIVE_MOTION = 0.01;
export const HIDDEN_ASLEEP_MAX_MS = 1_200_000;
/**
 * A book held up in front of the face (reading while leaning back): E_book whose last box
 * covers at least `BOOK_OVER_FACE_SHARE` of the last face box keeps the hidden stretch at
 * the study floor for `HIDDEN_BOOK_MAX_MS`, like head down. The book pose holds
 * `BOOK_UP_HOLD_MS` through detector misses. A phone in hand or a distraction app in the
 * foreground turn the rule off.
 */
export const HIDDEN_BOOK_MAX_MS = 600_000;
export const BOOK_OVER_FACE_SHARE = 0.5;
export const BOOK_UP_HOLD_MS = 10_000;
export const HIDDEN_TURNED_YAW = 35;
/** Turned away (and a hidden stretch with a phone or a distraction past its allowance). */
export const HIDDEN_LOW_VALUE = 0.2;
/**
 * Unknown last pose: (θ + margin)/100 for this long. After that the stretch is not
 * observable (leaning back out of the frame, a hand over the face, a light the landmarker
 * cannot work with): nothing is pushed and the observer reports `absent`, so the absence
 * path (warning at half, strike at `noFaceStrikeMs`) takes over instead of a DUDA that
 * blames attention. In low light the value holds while keyboard or mouse were used within
 * `noCameraIdleMs` (judged like the no-camera mode).
 */
export const HIDDEN_UNKNOWN_MS = 20_000;
export const HIDDEN_UNKNOWN_MARGIN = 5;

// Fusion (§7.3)
/** A distraction in the foreground keeps this share of the «looking at the screen» mass. */
export const DISTRACTION_SCREEN_KEEP = 0.1;
/**
 * A book is a positive signal, not an override: it lifts the value to the study floor only
 * when the head could be reading it (looking down, or facing the desk within this yaw
 * without the model saying «away»; hidden with the head down). Otherwise it adds at most
 * `BOOK_BONUS`: a textbook lying on the desk must not hide watching TV to the side.
 */
export const BOOK_READING_MAX_YAW = 35;
/** …or up to this yaw when the head or the eyes look down toward the desk (a book at the side). */
export const BOOK_READING_SIDE_MAX_YAW = 60;
export const BOOK_BONUS = 0.1;

// Eyes (§7.4)
export const EYES_MIN_QUALITY = 0.5;
/** Eyes looking down (reading) lower the lids: never a «closed» frame. */
export const EYES_MAX_LOOK_DOWN = 0.5;
export const YAWN_JAW = 0.6;

// Stale profile (§7.4)
/**
 * Rolling, for the whole session: within any `STALE_WINDOW_MS` of observed work time, among
 * face frames with keyboard or mouse input and no distraction app, ≥ `STALE_MIN_FRAMES`
 * frames of which ≥ `STALE_AWAY_SHARE` are «away» for the profile while the fallback (fed
 * with the same fresh input) calls them study. A profile matched by camera can still be stale
 * later on: another desk with an external monitor, a camera bumped mid-session.
 */
export const STALE_WINDOW_MS = 120_000;
export const STALE_MIN_FRAMES = 60;
export const STALE_AWAY_SHARE = 0.7;

// Hints (§7.3)
/** Any hidden stretch this long raises `camera_cant_see_you`. */
export const CANT_SEE_HIDDEN_MS = 60_000;
/** …and one with an unknown last pose already after this long (before the absence path). */
export const CANT_SEE_UNKNOWN_MS = 5_000;
/** A face cut this much by the frame edge (also just before the face was lost). */
export const CANT_SEE_TRUNCATED = 0.3;

// «¡Estaba estudiando!» for a phone lying on the desk (desk-phone.ts)
/** A phone episode names a spot only with this many detector sightings… */
export const DESK_SPOT_MIN_SIGHTINGS = 3;
/** …of which at least this share were at the spot (the median box). */
export const DESK_SPOT_SHARE = 0.8;
/**
 * At the spot: centre within max(4 px, 0.15 × the spot's diagonal)… (PERCEPTION's «still»
 * tolerance: detector jitter on a phone lying down stays inside, a phone in a hand drifts
 * out and counts again).
 */
export const DESK_SPOT_MIN_PX = 4;
export const DESK_SPOT_DIAG = 0.15;
/** …and area within 30 %, plus 3 px of edge jitter on every side. */
export const DESK_SPOT_AREA = 0.3;
export const DESK_SPOT_EDGE_PX = 3;
/** A spot the phone was not seen at for this much observed time is forgotten (it left). */
export const DESK_SPOT_FORGET_MS = 60_000;
/** At most this many vouched spots (a phone and a calculator, say); the oldest goes. */
export const DESK_SPOT_MAX = 2;

/** Observer time steps are capped at this (a frame never represents more than 1 s). */
export const OBSERVE_MAX_STEP_MS = 1_000;
