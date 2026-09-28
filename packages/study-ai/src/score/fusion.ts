/**
 * Fusion of the classifier with the rules: the instant study value s ∈ [0, 1] of one tick
 * (owner: DECISION). Pure, so every rule of DESIGN.md §7.3 is unit-tested on its own.
 *
 * Order: base value by presence → study floor (looking down, book) → weak input bonus →
 * phone cap (over everything) → drowsy candidates stay out of the window.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { ClassProbabilities, LowCause, ObservationEvidence, Presence } from '../types';
import { clamp01 } from '../util/math';
import {
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

/** Last-pose rule for a hidden face (no face, but someone there). */
export function hiddenValue(pose: HiddenPose, hiddenMs: number, threshold: number): number {
  switch (pose) {
    case 'down':
      return hiddenMs <= HIDDEN_DOWN_MAX_MS ? studyFloor(threshold) : HIDDEN_LOW_VALUE;
    case 'turned':
      return HIDDEN_LOW_VALUE;
    case 'unknown':
      return hiddenMs <= HIDDEN_UNKNOWN_MS
        ? clamp01((threshold + HIDDEN_UNKNOWN_MARGIN) / 100)
        : HIDDEN_LOW_VALUE;
  }
}

export interface FusionInput {
  presence: Presence;
  /** Classifier answer for the frame (`null` for an empty frame). */
  p: ClassProbabilities | null;
  /** π: P(truly studying | predicted class). */
  trust: Readonly<{ phone: number; away: number }>;
  evidence: ObservationEvidence;
  /** Hidden face: the last-pose value and whether the head was turned away. */
  hidden: { value: number; turned: boolean } | null;
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

export function fuse(input: FusionInput): FusionResult {
  const { presence, p, trust, evidence, threshold } = input;
  if (presence !== 'visible' && presence !== 'hidden') return NOT_PUSHED;
  const c = STUDY_AI_CONSTANTS;
  const phone = evidence.phone;
  const dist = evidence.distractionApp;

  let s: number;
  if (presence === 'visible') {
    s = p
      ? finite01(p.screen) * (dist ? DISTRACTION_SCREEN_KEEP : 1) +
        finite01(p.paper) +
        finite01(trust.away) * finite01(p.away) +
        (phone ? 0 : finite01(trust.phone) * finite01(p.phone))
      : clamp01((threshold + HIDDEN_UNKNOWN_MARGIN) / 100);
  } else {
    const fromModel = p ? finite01(p.screen) + finite01(p.paper) : 0;
    s = Math.max(fromModel, input.hidden?.value ?? 0);
  }
  s = finite01(s);

  // 1. Writing, reading, a book: never under the floor without a phone in hand.
  if (!phone && (evidence.lookingDown || evidence.book)) s = Math.max(s, studyFloor(threshold));
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
    else if ((p && argmaxIsAway(p)) || (presence === 'hidden' && input.hidden?.turned))
      cause = 'looking_away';
    else cause = 'unknown';
  }
  return { study: s, cause };
}
