/**
 * Rule-based scorer for an uncalibrated user, an unknown camera or a stale profile
 * (owner: LEARNING). Learns its baseline in the first ~20 s. DESIGN.md §6.9.
 *
 * Baseline: medians of the first 20 s of face frames with keyboard/mouse active, no
 * distraction in the foreground and no phone; until 3 s of those exist, the first face frames
 * of any kind stand in. Before 3 s of face frames, `ready` is false and `predict` gives a
 * neutral, study-leaning answer.
 *
 * Rules (face frames): pStudy = exp(−(max(0,|dyaw|−10)/30)⁴ − (max(0,dpitch−15)/15)⁴), so
 * looking down (writing, reading) is study; below −70° the pose is implausible and pStudy
 * decays again. pStudy is split between screen and paper by how far down the head is.
 * A visible phone in hand takes 0.9 of the mass; the rest of the non-study mass is `away`.
 * No face but a person: study share 0.2, so DECISION's last-pose rule decides.
 */
import type {
  AttentionClassifier,
  ClassProbabilities,
  ClassifierObserveHint,
  FaceFeatures,
  FrameFeatures,
  RelativePose,
  ScreenBaseline,
} from '../types';
import { clamp, clamp01, median } from '../util/math';
import {
  DEFAULT_THRESHOLDS,
  GENERIC_BASELINE_MS,
  GENERIC_DOWN_LIMIT,
  GENERIC_DOWN_SCALE,
  GENERIC_EYES,
  GENERIC_MAX_SAMPLES,
  GENERIC_NEUTRAL_SCREEN,
  GENERIC_PAPER_FROM,
  GENERIC_PAPER_TO,
  GENERIC_PHONE_P,
  GENERIC_READY_MS,
  GENERIC_UP_FREE,
  GENERIC_UP_SCALE,
  GENERIC_YAW_FREE,
  GENERIC_YAW_SCALE,
  HIDDEN_STUDY_CAP,
  OBSERVE_MAX_DT_MS,
  PHONE_STILL_MS,
} from './constants';
import { relativeFromFace } from './features';
import { frameHasSomeone, toProbabilities } from './personal';

export interface GenericClassifierOptions {
  /** Face time needed for the session baseline (20 000). */
  baselineMs?: number;
}

interface BaselineBuffer {
  ms: number;
  samples: ScreenBaseline[];
}

/** Study probability of a relative pose under the generic rules. */
export function genericStudyProbability(dyaw: number, dpitch: number): number {
  const yawTerm = Math.max(0, Math.abs(dyaw) - GENERIC_YAW_FREE) / GENERIC_YAW_SCALE;
  const upTerm = Math.max(0, dpitch - GENERIC_UP_FREE) / GENERIC_UP_SCALE;
  const downTerm = Math.max(0, GENERIC_DOWN_LIMIT - dpitch) / GENERIC_DOWN_SCALE;
  const p = Math.exp(-(yawTerm ** 4) - upTerm ** 4 - downTerm ** 4);
  return Number.isFinite(p) ? clamp01(p) : 0;
}

/** Share of pStudy that is `paper`: 0 at dpitch ≥ −6°, 1 at ≤ −18°. */
export function genericPaperShare(dpitch: number): number {
  return clamp01((GENERIC_PAPER_FROM - dpitch) / (GENERIC_PAPER_FROM - GENERIC_PAPER_TO));
}

/** Phone in hand on this frame: over the threshold, near the face or moving, not lying still. */
export function phoneInHand(frame: FrameFeatures, threshold: number): boolean {
  const phone = frame.objects?.phone;
  if (!phone || !(phone.score >= threshold)) return false;
  return (phone.nearFace || phone.moving) && phone.stillMs < PHONE_STILL_MS;
}

function baselineOf(samples: readonly ScreenBaseline[]): ScreenBaseline {
  const m = (key: keyof ScreenBaseline): number =>
    median(Float64Array.from(samples, (s) => s[key]));
  return {
    yaw: m('yaw'),
    pitch: m('pitch'),
    roll: m('roll'),
    cx: m('cx'),
    cy: m('cy'),
    w: Math.max(m('w'), 1e-3),
    h: Math.max(m('h'), 1e-3),
  };
}

function sampleOf(face: FaceFeatures): ScreenBaseline | null {
  const s = {
    yaw: face.pose.yaw,
    pitch: face.pose.pitch,
    roll: face.pose.roll,
    cx: face.box.cx,
    cy: face.box.cy,
    w: face.box.w,
    h: face.box.h,
  };
  return Object.values(s).every(Number.isFinite) ? s : null;
}

export function createGenericClassifier(
  options: GenericClassifierOptions = {},
): AttentionClassifier {
  const baselineMs = Math.max(GENERIC_READY_MS, options.baselineMs ?? GENERIC_BASELINE_MS);
  const thresholds = Object.freeze({ ...DEFAULT_THRESHOLDS });
  const trust = Object.freeze({ phone: 0, away: 0 });
  const good: BaselineBuffer = { ms: 0, samples: [] };
  const any: BaselineBuffer = { ms: 0, samples: [] };
  let lastT: number | null = null;
  let cached: ScreenBaseline | null = null;
  let dirty = false;

  const baseline = (): ScreenBaseline | null => {
    if (dirty) {
      dirty = false;
      if (good.ms >= GENERIC_READY_MS) cached = baselineOf(good.samples);
      else if (any.ms >= GENERIC_READY_MS) cached = baselineOf(any.samples);
      else cached = null;
    }
    return cached;
  };

  const relativePose = (face: FaceFeatures): RelativePose | null => {
    const base = baseline();
    return base ? relativeFromFace(face, base) : null;
  };

  const predict = (frame: FrameFeatures): ClassProbabilities | null => {
    if (!frameHasSomeone(frame, thresholds.person)) return null;
    const pPhone = phoneInHand(frame, thresholds.phone) ? GENERIC_PHONE_P : 0;
    const rest = 1 - pPhone;
    const face = frame.face;
    let pStudy: number;
    let paper: number;
    const rel = face ? relativePose(face) : null;
    if (face && !rel) {
      // Not ready yet: neutral and study-leaning.
      const other = (1 - GENERIC_NEUTRAL_SCREEN) / 2;
      return toProbabilities([
        GENERIC_NEUTRAL_SCREEN * rest,
        other * rest,
        pPhone,
        other * rest,
        0,
      ]);
    }
    if (rel) {
      pStudy = genericStudyProbability(rel.dyaw, rel.dpitch);
      paper = genericPaperShare(rel.dpitch);
    } else {
      // No face but a person: leave it to the observer's last-pose rule.
      pStudy = HIDDEN_STUDY_CAP;
      paper = 1;
    }
    return toProbabilities([
      pStudy * (1 - paper) * rest,
      pStudy * paper * rest,
      pPhone,
      (1 - pStudy) * rest,
      0,
    ]);
  };

  const push = (buffer: BaselineBuffer, sample: ScreenBaseline, dt: number): void => {
    if (buffer.ms >= baselineMs) return;
    buffer.ms += dt;
    if (buffer.samples.length < GENERIC_MAX_SAMPLES) buffer.samples.push(sample);
    dirty = true;
  };

  const observe = (frame: FrameFeatures, hint: ClassifierObserveHint): void => {
    const t = frame.t;
    const dt = lastT === null || !Number.isFinite(t) ? 0 : clamp(t - lastT, 0, OBSERVE_MAX_DT_MS);
    if (Number.isFinite(t)) lastT = t;
    if (!frame.face || good.ms >= baselineMs) return;
    const sample = sampleOf(frame.face);
    if (!sample) return;
    // The very first face frame still counts as a sample (dt 0), so the medians see it.
    push(any, sample, dt);
    if (
      hint.inputActive &&
      !hint.distraction &&
      !hint.phone &&
      !phoneInHand(frame, thresholds.phone)
    ) {
      push(good, sample, dt);
    }
  };

  return {
    kind: 'generic',
    get ready(): boolean {
      return baseline() !== null;
    },
    thresholds,
    trust,
    eyes: GENERIC_EYES,
    predict,
    relativePose,
    observe,
  };
}
