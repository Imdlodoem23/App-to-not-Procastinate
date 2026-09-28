/**
 * Fusion of the classifier with the rules: the instant study value s ∈ [0, 1] of one tick
 * (owner: DECISION). Pure, so every rule of DESIGN.md §7.3 is unit-tested on its own.
 *
 * Order: base value by presence → study floor (looking down; a book the head could be
 * reading) or the small book bonus → weak input bonus → phone cap (over everything) →
 * drowsy candidates stay out of the window.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { ClassProbabilities, LowCause, ObservationEvidence, Presence } from '../types';
import { clamp01 } from '../util/math';
import {
  BOOK_BONUS,
  BOOK_READING_MAX_YAW,
  DISTRACTION_SCREEN_KEEP,
  HIDDEN_DOWN_MAX_MS,
  HIDDEN_LOW_VALUE,
  HIDDEN_UNKNOWN_MARGIN,
  HIDDEN_UNKNOWN_MS,
} from './constants';

/** Where the head was just before the face was lost. */
export type HiddenPose = 'down' | 'turned' | 'unknown';

/**
 * Study floor for looking down and books: min(95, θ + 20)/100. Always ≥ θ + hysteresis, so
 * writing or reading is never «low» at any sensitivity.
 */
export function studyFloor(threshold: number): number {
  const c = STUDY_AI_CONSTANTS;
  return Math.min(c.studyFloorMax, threshold + c.studyFloorMargin) / 100;
}

/** Neutral value just above θ: a frame that says nothing either way. */
export function neutralValue(threshold: number): number {
  return clamp01((threshold + HIDDEN_UNKNOWN_MARGIN) / 100);
}

/**
 * Last-pose rule for a hidden face (no face, but someone there). `null` means the stretch is
 * past its allowance and no longer observable: the observer hands it to the absence path
 * instead of pushing a value that would blame attention for a framing or light problem.
 *
 * - `down` (writing): the floor for 10 min, then not observable;
 * - `turned`: 0.2, always (looking away is observable enough);
 * - `unknown`: neutral for 20 s, then not observable, unless `holdUnknown` (low light with
 *   recent keyboard or mouse input, judged like the no-camera mode).
 */
export function hiddenValue(
  pose: HiddenPose,
  hiddenMs: number,
  threshold: number,
  holdUnknown = false,
): number | null {
  switch (pose) {
    case 'down':
      return hiddenMs <= HIDDEN_DOWN_MAX_MS ? studyFloor(threshold) : null;
    case 'turned':
      return HIDDEN_LOW_VALUE;
    case 'unknown':
      return hiddenMs <= HIDDEN_UNKNOWN_MS || holdUnknown ? neutralValue(threshold) : null;
  }
}

export interface FusionInput {
  presence: Presence;
  /** Classifier answer for the frame (`null` for an empty frame). */
  p: ClassProbabilities | null;
  /** π: P(truly studying | predicted class). */
  trust: Readonly<{ phone: number; away: number }>;
  evidence: ObservationEvidence;
  /** Hidden face: the last-pose value and the pose it came from. */
  hidden: { value: number; pose: HiddenPose } | null;
  /**
   * Yaw of the visible face in degrees: relative to the screen baseline, or absolute before
   * one exists. `null` without a face.
   */
  faceYaw: number | null;
  /** θ, 30–80. */
  threshold: number;
  /** A closed-eyes frame (drowsy candidate). */
  eyesClosed: boolean;
}

export interface FusionResult {
  /** `null`: not pushed into the window (nobody there, camera lost, drowsy candidate). */
  study: number | null;
  cause: LowCause | null;
}

const NOT_PUSHED: FusionResult = Object.freeze({ study: null, cause: null });

function argmaxIsAway(p: ClassProbabilities): boolean {
  return (
    p.away > p.screen && p.away >= p.paper && p.away >= p.phone && p.away >= p.absent && p.away > 0
  );
}

function finite01(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : 0;
}

/**
 * The head could be reading a book in view: looking down; or, visible, facing the desk area
 * (|yaw| < 35°) without the model saying «away»; or, hidden, lost with the head down.
 */
export function readingPose(input: FusionInput): boolean {
  if (input.evidence.lookingDown) return true;
  if (input.presence === 'hidden') return input.hidden?.pose === 'down';
  if (input.presence !== 'visible') return false;
  const yaw = input.faceYaw;
  if (yaw === null || !Number.isFinite(yaw) || Math.abs(yaw) >= BOOK_READING_MAX_YAW) return false;
  return !(input.p && argmaxIsAway(input.p));
}

export function fuse(input: FusionInput): FusionResult {
  const { presence, p, trust, evidence, threshold } = input;
  if (presence !== 'visible' && presence !== 'hidden') return NOT_PUSHED;
  const c = STUDY_AI_CONSTANTS;
  const phone = evidence.phone;
  const dist = evidence.distractionApp;
  const screenKeep = dist ? DISTRACTION_SCREEN_KEEP : 1;

  let s: number;
  if (presence === 'visible') {
    s = p
      ? finite01(p.screen) * screenKeep +
        finite01(p.paper) +
        finite01(trust.away) * finite01(p.away) +
        (phone ? 0 : finite01(trust.phone) * finite01(p.phone))
      : neutralValue(threshold);
  } else {
    const hidden = input.hidden;
    const fromModel = p ? finite01(p.screen) * screenKeep + finite01(p.paper) : 0;
    // The unknown-pose value stands in for «looking at the screen»: a distraction discounts
    // it like p.screen. Head down (writing) keeps its floor with music in the foreground.
    const rule = hidden ? hidden.value * (hidden.pose === 'unknown' ? screenKeep : 1) : 0;
    s = Math.max(fromModel, rule);
  }
  s = finite01(s);

  // 1. Writing or reading: never under the floor without a phone in hand. A book lifts only
  //    a head that could be reading it; elsewhere it is a small positive signal.
  if (!phone) {
    if (evidence.lookingDown || (evidence.book && readingPose(input))) {
      s = Math.max(s, studyFloor(threshold));
    } else if (evidence.book) {
      s = Math.min(1, s + BOOK_BONUS);
    }
  }
  // 2. Keyboard and mouse: a weak signal.
  if (evidence.inputActive && !dist && !phone) s = Math.min(1, s + c.activityBonus);
  // 3. A phone in hand overrides everything.
  if (phone) s = Math.min(s, c.phoneCap);
  // 4. Closed eyes: out of the window, the timers freeze (drowsiness never strikes).
  if (input.eyesClosed && !phone && !dist) return NOT_PUSHED;

  let cause: LowCause | null = null;
  if (s < threshold / 100) {
    if (phone) cause = 'phone';
    else if (dist) cause = 'distraction_app';
    else if ((p && argmaxIsAway(p)) || (presence === 'hidden' && input.hidden?.pose === 'turned'))
      cause = 'looking_away';
    else cause = 'unknown';
  }
  return { study: s, cause };
}
