/**
 * Classifier built from a calibration profile (owner: LEARNING). DESIGN.md §6.4–6.8.
 *
 * predict: frame → quantised row → x (relative to the screen baseline plus the slow drift)
 * → φ → softmax. `null` for an empty frame (no face and no person above the learned
 * threshold). Without a face the study share is capped at 0.2 (the excess goes to `away`):
 * calibration loses the face mostly while writing, but a hidden face must be judged by
 * DECISION's last-pose rule, not vouched for here. observe: a slow in-memory baseline drift
 * (±10°, τ 10 min) that follows the user's screen pose only on frames that clearly look like
 * studying at the screen.
 */
import type {
  AttentionClassifier,
  CalibrationProfile,
  ClassProbabilities,
  ClassifierObserveHint,
  FaceFeatures,
  FrameFeatures,
  RelativePose,
} from '../types';
import { clamp } from '../util/math';
import {
  DRIFT_MAX_DEG,
  DRIFT_MAX_DPITCH,
  DRIFT_MAX_DYAW,
  DRIFT_MIN_SCREEN,
  DRIFT_TAU_MS,
  HIDDEN_STUDY_CAP,
  OBSERVE_MAX_DT_MS,
  X_DIM,
  phiDim,
} from './constants';
import { expand, relativeFromFace, rowToX, type FeatureSpace, type PoseDrift } from './features';
import { frameToRow } from './rows';
import { softmaxProbs, type SoftmaxParams } from './softmax';

const K = 5;

/** Frozen `ClassProbabilities` from a K-vector in `CALIBRATION_CLASSES` order. */
export function toProbabilities(p: ArrayLike<number>): ClassProbabilities {
  return Object.freeze({
    screen: p[0] as number,
    paper: p[1] as number,
    phone: p[2] as number,
    away: p[3] as number,
    absent: p[4] as number,
  });
}

/** True when the frame holds a face or a person above `personThreshold`. */
export function frameHasSomeone(frame: FrameFeatures, personThreshold: number): boolean {
  if (frame.face) return true;
  const person = frame.objects?.person?.score ?? 0;
  return Number.isFinite(person) && person >= personThreshold;
}

/** Caps p.screen + p.paper at `HIDDEN_STUDY_CAP`, moving the excess to `away` (in place). */
export function capHiddenStudy(p: Float64Array): void {
  const study = (p[0] as number) + (p[1] as number);
  if (!(study > HIDDEN_STUDY_CAP)) return;
  const keep = HIDDEN_STUDY_CAP / study;
  p[0] = (p[0] as number) * keep;
  p[1] = (p[1] as number) * keep;
  p[3] = (p[3] as number) + study - HIDDEN_STUDY_CAP;
}

export function createPersonalClassifier(profile: CalibrationProfile): AttentionClassifier {
  const model = profile.model;
  const d = phiDim(model.anchors.length);
  const space: FeatureSpace = {
    center: model.center,
    scale: model.scale,
    anchors: model.anchors,
    sigma: model.sigma,
  };
  const W = new Float64Array(K * d);
  model.W.forEach((row, c) => W.set(row.slice(0, d), c * d));
  const params: SoftmaxParams = { W, b: Float64Array.from(model.b) };
  const baseline = profile.baseline;
  const thresholds = Object.freeze({ ...profile.thresholds });
  const trust = Object.freeze({ ...profile.trust });
  const eyes = Object.freeze({
    reliable: profile.eyes.reliable,
    blinkFit: Object.freeze([profile.eyes.blinkFit[0], profile.eyes.blinkFit[1]] as const),
    closedDelta: profile.eyes.closedDelta,
  });

  const drift: PoseDrift = { yaw: 0, pitch: 0, roll: 0 };
  let lastT: number | null = null;
  const x = new Float64Array(X_DIM);
  const phi = new Float64Array(d);
  const probs = new Float64Array(K);

  const predict = (frame: FrameFeatures): ClassProbabilities | null => {
    if (!frameHasSomeone(frame, thresholds.person)) return null;
    rowToX(frameToRow(frame), baseline, x, drift);
    expand(x, space, phi);
    softmaxProbs(params, d, K, phi, probs);
    if (!frame.face) capHiddenStudy(probs);
    return toProbabilities(probs);
  };

  const relativePose = (face: FaceFeatures): RelativePose =>
    relativeFromFace(face, baseline, drift);

  const observe = (frame: FrameFeatures, hint: ClassifierObserveHint): void => {
    const t = frame.t;
    const dt = lastT === null || !Number.isFinite(t) ? 0 : clamp(t - lastT, 0, OBSERVE_MAX_DT_MS);
    if (Number.isFinite(t)) lastT = t;
    const face = frame.face;
    if (!face || dt === 0 || !hint.inputActive || hint.distraction || hint.phone) return;
    const p = predict(frame);
    if (!p || p.screen < DRIFT_MIN_SCREEN) return;
    const rel = relativePose(face);
    if (Math.abs(rel.dyaw) > DRIFT_MAX_DYAW || Math.abs(rel.dpitch) > DRIFT_MAX_DPITCH) return;
    const a = 1 - Math.exp(-dt / DRIFT_TAU_MS);
    drift.yaw = clamp(drift.yaw + a * rel.dyaw, -DRIFT_MAX_DEG, DRIFT_MAX_DEG);
    drift.pitch = clamp(drift.pitch + a * rel.dpitch, -DRIFT_MAX_DEG, DRIFT_MAX_DEG);
    drift.roll = clamp(drift.roll + a * rel.droll, -DRIFT_MAX_DEG, DRIFT_MAX_DEG);
  };

  return Object.freeze({
    kind: 'personal' as const,
    ready: true,
    thresholds,
    trust,
    eyes,
    predict,
    relativePose,
    observe,
  });
}
