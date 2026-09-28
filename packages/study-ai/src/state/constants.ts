/**
 * Module-internal values of the attention engine (owner: DECISION). The shared ones (warm-up,
 * absence, grace, eyes, hints, feedback) live in `STUDY_AI_CONSTANTS`. DESIGN.md §7.5–7.10.
 */
import { STUDY_RULES } from '@centrate/shared/points';

/** A window sample never represents more than this much time. */
export const SAMPLE_MAX_SPAN_MS = 1_000;
/** Short-score ceiling for the fast recovery: min(θ + margin, this). */
export const FAST_RECOVERY_MAX = 90;
/**
 * The fast-recovery condition must hold this long. A 2 s glance at the screen in the middle
 * of a phone session, or one lucky classifier streak, must not clear DUDA; coming back to
 * study still clears it in ≈ 3.5 s instead of the ≈ 7 s the long window needs.
 */
export const FAST_RECOVERY_HOLD_MS = 1_500;

/** Raw presence must hold this long before the snapshot shows it. */
export const PRESENCE_DEBOUNCE_MS = 1_000;

/** Eyes: coverage needed for a drowsiness decision, and the «eyes open again» rule. */
export const EYES_MIN_COVERAGE = 0.5;
export const EYES_OPEN_WINDOW_MS = 5_000;
export const EYES_OPEN_SHARE = 0.7;

/**
 * «¡Estaba estudiando!»: an episode whose low time had E_phone at least this share of the
 * time is a phone episode. If that phone stayed at one spot (lying on the desk), its frames
 * are offered with the phone removed and the observer learns to ignore the spot.
 */
export const FEEDBACK_PHONE_SHARE = 0.5;
/** A ring entry never weighs more than this much time (low-time shares). */
export const FEEDBACK_MAX_ENTRY_MS = 1_000;

/** Timeline pieces shorter than this are absorbed into the previous segment. */
export const TIMELINE_MIN_PIECE_MS = 5_000;

/**
 * Local pause quota (the guardian is the authority and also enforces it): at most
 * `maxPausesPerWindow` pauses may start per `pauseWindowMs` of awake time, each at most
 * `pauseMs`. A `paused` phase past the quota (a stale or forged phase) is treated as work,
 * so it cannot freeze the timers forever. `PAUSE_OVERRUN_SLACK_MS` absorbs the delay of
 * main's 1 Hz phase polling; `PAUSE_MERGE_MS` merges a pause that flickered off and on.
 */
export const PAUSE_RULES = Object.freeze({
  pauseMs: STUDY_RULES.pauseMs,
  maxPausesPerWindow: STUDY_RULES.maxPausesPerWindow,
  pauseWindowMs: STUDY_RULES.pauseWindowMs,
});
export const PAUSE_OVERRUN_SLACK_MS = 10_000;
export const PAUSE_MERGE_MS = 5_000;

/** A focus minute counts when more than this share of its work time was credited as focused. */
export const FOCUS_MINUTE_MS = 60_000;
export const FOCUS_MINUTE_SHARE = 0.5;
