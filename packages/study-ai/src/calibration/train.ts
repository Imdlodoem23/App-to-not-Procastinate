/**
 * Training pipeline of the personal classifier (owner: LEARNING). DESIGN.md §6.5–6.8.
 *
 * samples (absolute rows) + baseline → x → robust standardisation + RBF anchors → φ,
 * seeded augmentation (pseudo-rows weigh 0.3), class-equalised weights (feedback rows 1.5,
 * capped at 50 % of their class's calibration weight; `phone` rows with no visible phone
 * 0.2, so posture alone never means «phone»), blocked 4-fold CV over the λ grid
 * (out-of-fold binary log-likelihood), trust π from the out-of-fold predictions, and a final
 * fit on everything. Deterministic end to end.
 */
import {
  AUGMENT_BOOK_SCORE,
  AUGMENT_EYE_FACTOR,
  AUGMENT_PHONE_SCORE,
  AUGMENT_POSE_SD,
  AUGMENT_SEED,
  CV_FOLDS,
  CV_MAX_ITER,
  CV_TOL,
  FEEDBACK_CAP_SHARE,
  FEEDBACK_MAX_ITER,
  FEEDBACK_ROW_WEIGHT,
  KMEANS_ITERATIONS,
  KMEANS_SEED,
  LAMBDA_GRID,
  MAX_ANCHORS,
  MIRROR_ROW_WEIGHT,
  PHONE_UNSEEN_WEIGHT,
  PSEUDO_ROW_WEIGHT,
  SIGMA_FACTOR,
  SIGMA_FLOOR,
  TRAIN_MAX_ITER,
  TRAIN_TOL,
  TRUST_CAP,
  TRUST_PRIOR,
  TRUST_PSEUDO,
  WEAK_SEPARATION,
  X_DIM,
  phiDim,
} from '../classifier/constants';
import {
  expand,
  fitStandardisation,
  wrapDeg,
  rbfPoint,
  rowToX,
  type FeatureSpace,
} from '../classifier/features';
import { kmeansPlusPlus, medianNearestDistance } from '../classifier/kmeans';
import { COL } from '../classifier/rows';
import {
  fitSoftmax,
  softmaxProbs,
  type SoftmaxData,
  type SoftmaxParams,
} from '../classifier/softmax';
import { CALIBRATION_CLASSES } from '../types';
import type {
  CalibrationClass,
  CalibrationReport,
  ClassifierThresholds,
  Clock,
  FeatureRow,
  ScreenBaseline,
  SoftmaxModelData,
  TrainReport,
} from '../types';
import { clamp, clamp01 } from '../util/math';
import { gaussian, mulberry32, uniform } from '../util/rng';

export const K_CLASSES = CALIBRATION_CLASSES.length;
export const CLASS_INDEX: Readonly<Record<CalibrationClass, number>> = Object.freeze({
  screen: 0,
  paper: 1,
  phone: 2,
  away: 3,
  absent: 4,
});
export const isStudyIndex = (c: number): boolean => c === 0 || c === 1;

/** Sample source codes: stored rows are 0 (calibration) or 1 (feedback); 2 is a pseudo-row. */
export const SRC_CALIBRATION = 0;
export const SRC_FEEDBACK = 1;
export const SRC_PSEUDO = 2;

/** The stored samples of a profile (parallel arrays). */
export interface SampleSet {
  cls: readonly number[];
  src: readonly number[];
  rows: readonly FeatureRow[];
}

/** Every row the optimiser sees, with its bookkeeping. */
export interface Assembled {
  data: SoftmaxData;
  /** CV fold of each row (pseudo-rows inherit their parent's fold). */
  fold: Int8Array;
  /** 0 calibration, 1 feedback, 2 pseudo. */
  src: Uint8Array;
  /** Index of the stored sample a row comes from (itself for real rows). */
  parent: Int32Array;
  /** Face, or a person above the threshold: rows `predict` would answer for. */
  nonEmpty: Uint8Array;
}

// ---------------------------------------------------------------------------------------
// Feature space
// ---------------------------------------------------------------------------------------

/** Standardisation on every real row; RBF anchors (seeded k-means++) on the study face rows. */
export function fitFeatureSpace(samples: SampleSet, baseline: ScreenBaseline): FeatureSpace {
  const xs = samples.rows.map((row) => rowToX(row, baseline, new Float64Array(X_DIM)));
  const { center, scale } = fitStandardisation(xs);
  const partial: FeatureSpace = { center, scale, anchors: [], sigma: SIGMA_FLOOR };
  const points: number[][] = [];
  xs.forEach((x, i) => {
    if (isStudyIndex(samples.cls[i] ?? -1) && x[0] === 1) points.push(rbfPoint(x, partial));
  });
  const anchors = kmeansPlusPlus(points, MAX_ANCHORS, KMEANS_SEED, KMEANS_ITERATIONS);
  const spread = medianNearestDistance(points, anchors);
  const sigma = Number.isFinite(spread)
    ? Math.max(SIGMA_FLOOR, SIGMA_FACTOR * spread)
    : SIGMA_FLOOR;
  return { center, scale, anchors, sigma };
}

// ---------------------------------------------------------------------------------------
// Augmentation (§6.8)
// ---------------------------------------------------------------------------------------

export interface PseudoRow {
  row: number[];
  cls: number;
  /** Stored sample it was derived from (it shares that sample's CV fold). */
  parent: number;
  /** Raw weight before class equalisation. */
  weight: number;
}

const EYE_COLUMNS = [COL.blink, COL.lookDown, COL.lookUp, COL.gazeX, COL.jawOpen] as const;
const FACE_COLUMNS = [
  COL.yaw,
  COL.pitch,
  COL.roll,
  COL.cx,
  COL.cy,
  COL.w,
  COL.h,
  COL.truncated,
  ...EYE_COLUMNS,
] as const;

function classEyeSd(samples: SampleSet): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < K_CLASSES; c += 1) {
    out.push(
      EYE_COLUMNS.map((column) => {
        let n = 0;
        let s = 0;
        let s2 = 0;
        samples.rows.forEach((row, i) => {
          if (samples.cls[i] !== c || (row[COL.face] ?? 0) < 0.5) return;
          const v = row[column] ?? 0;
          n += 1;
          s += v;
          s2 += v * v;
        });
        if (n < 2) return 0;
        const m = s / n;
        return Math.sqrt(Math.max(0, s2 / n - m * m));
      }),
    );
  }
  return out;
}

/**
 * Seeded pseudo-rows from calibration rows only:
 * - pose (±3°) and blendshape (0.5 × class σ) noise on every 2nd face row;
 * - study face rows with a phone near the face (0.8), labelled `phone` (every 2nd);
 * - paper rows with the book toggled between 0 and 0.7 (every row);
 * - absent rows pinned at face = 0 and a person below the threshold (every 2nd);
 * - away rows mirrored around the screen baseline (yaw, roll, gazeX, cx), at full weight:
 *   looking away to the other side is away too, and without them the linear yaw term would
 *   extrapolate the unseen side into «studying»;
 * - phone face rows with the phone removed, labelled `paper`: the mirror image of the phone
 *   copies above. Looking down is studying unless a phone is visible (PROMPT.md §8).
 */
export function augment(
  samples: SampleSet,
  thresholds: ClassifierThresholds,
  baseline: ScreenBaseline,
): PseudoRow[] {
  const rng = mulberry32(AUGMENT_SEED);
  const eyeSd = classEyeSd(samples);
  const out: PseudoRow[] = [];
  const counters = new Int32Array(K_CLASSES);
  samples.rows.forEach((source, i) => {
    if (samples.src[i] !== SRC_CALIBRATION) return;
    const cls = samples.cls[i] ?? 0;
    const nth = counters[cls] as number;
    counters[cls] = nth + 1;
    const hasFace = (source[COL.face] ?? 0) >= 0.5;
    const copy = (): number[] => Array.from(source, (v) => v);

    if (hasFace && cls !== CLASS_INDEX.absent && nth % 2 === 0) {
      const row = copy();
      row[COL.yaw] = clamp((row[COL.yaw] ?? 0) + gaussian(rng, 0, AUGMENT_POSE_SD), -180, 180);
      row[COL.pitch] = clamp((row[COL.pitch] ?? 0) + gaussian(rng, 0, AUGMENT_POSE_SD), -180, 180);
      row[COL.roll] = clamp((row[COL.roll] ?? 0) + gaussian(rng, 0, AUGMENT_POSE_SD), -180, 180);
      EYE_COLUMNS.forEach((column, e) => {
        const sd = AUGMENT_EYE_FACTOR * (eyeSd[cls]?.[e] ?? 0);
        const v = (row[column] ?? 0) + gaussian(rng, 0, sd);
        row[column] = column === COL.gazeX ? clamp(v, -1, 1) : clamp01(v);
      });
      out.push({ row, cls, parent: i, weight: PSEUDO_ROW_WEIGHT });
    }
    if (hasFace && isStudyIndex(cls) && nth % 2 === 1) {
      const row = copy();
      row[COL.phone] = AUGMENT_PHONE_SCORE;
      row[COL.phoneNear] = 1;
      row[COL.phoneMoving] = (nth >> 1) % 2;
      out.push({ row, cls: CLASS_INDEX.phone, parent: i, weight: PSEUDO_ROW_WEIGHT });
    }
    if (cls === CLASS_INDEX.paper) {
      const row = copy();
      row[COL.book] = (row[COL.book] ?? 0) >= 0.35 ? 0 : AUGMENT_BOOK_SCORE;
      out.push({ row, cls, parent: i, weight: PSEUDO_ROW_WEIGHT });
    }
    if (cls === CLASS_INDEX.absent && nth % 2 === 0) {
      const row = copy();
      row[COL.face] = 0;
      for (const column of FACE_COLUMNS) row[column] = 0;
      row[COL.person] = uniform(rng, 0, Math.max(0, thresholds.person - 0.05));
      out.push({ row, cls, parent: i, weight: PSEUDO_ROW_WEIGHT });
    }
    if (hasFace && cls === CLASS_INDEX.phone) {
      const row = copy();
      row[COL.phone] = 0;
      row[COL.phoneNear] = 0;
      row[COL.phoneMoving] = 0;
      out.push({ row, cls: CLASS_INDEX.paper, parent: i, weight: PSEUDO_ROW_WEIGHT });
    }
    if (hasFace && cls === CLASS_INDEX.away) {
      const row = copy();
      row[COL.yaw] = wrapDeg(2 * baseline.yaw - (row[COL.yaw] ?? 0));
      row[COL.roll] = wrapDeg(2 * baseline.roll - (row[COL.roll] ?? 0));
      row[COL.gazeX] = -(row[COL.gazeX] ?? 0);
      row[COL.cx] = 2 * baseline.cx - (row[COL.cx] ?? 0);
      out.push({ row, cls, parent: i, weight: MIRROR_ROW_WEIGHT });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Assembly: φ, weights, folds
// ---------------------------------------------------------------------------------------

/** Blocked folds: the k-th contiguous quarter of each (class, source) group. */
export function sampleFolds(samples: SampleSet, folds: number = CV_FOLDS): Int8Array {
  const n = samples.rows.length;
  const out = new Int8Array(n);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = (samples.cls[i] ?? 0) * 4 + (samples.src[i] ?? 0);
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  for (const list of groups.values()) {
    const m = list.length;
    list.forEach((index, position) => {
      out[index] = Math.min(folds - 1, Math.floor((folds * position) / m));
    });
  }
  return out;
}

export function assembleTraining(
  samples: SampleSet,
  baseline: ScreenBaseline,
  thresholds: ClassifierThresholds,
  space: FeatureSpace,
): Assembled {
  const pseudo = augment(samples, thresholds, baseline);
  const nReal = samples.rows.length;
  const n = nReal + pseudo.length;
  const d = phiDim(space.anchors.length);
  const X = new Float64Array(n * d);
  const y = new Uint8Array(n);
  const w = new Float64Array(n);
  const src = new Uint8Array(n);
  const parent = new Int32Array(n);
  const nonEmpty = new Uint8Array(n);
  const sampleFold = sampleFolds(samples);
  const fold = new Int8Array(n);
  const x = new Float64Array(X_DIM);
  const phi = new Float64Array(d);

  const put = (
    i: number,
    row: FeatureRow,
    cls: number,
    source: number,
    from: number,
    weight: number,
  ): void => {
    rowToX(row, baseline, x);
    expand(x, space, phi);
    X.set(phi, i * d);
    y[i] = cls;
    // A `phone` row without a visible phone only shows a posture (often the reading one):
    // it must not teach that looking down means the phone.
    const unseen = cls === CLASS_INDEX.phone && (row[COL.phone] ?? 0) < thresholds.phone;
    w[i] = unseen && source !== SRC_FEEDBACK ? weight * PHONE_UNSEEN_WEIGHT : weight;
    src[i] = source;
    parent[i] = from;
    fold[i] = sampleFold[from] as number;
    nonEmpty[i] =
      (row[COL.face] ?? 0) >= 0.5 || (row[COL.person] ?? 0) >= thresholds.person ? 1 : 0;
  };
  for (let i = 0; i < nReal; i += 1) {
    put(i, samples.rows[i] as FeatureRow, samples.cls[i] ?? 0, samples.src[i] ?? 0, i, 1);
  }
  pseudo.forEach((p, j) => put(nReal + j, p.row, p.cls, SRC_PSEUDO, p.parent, p.weight));

  // Raw weights, then the feedback cap, then equal class totals.
  const calibration = new Float64Array(K_CLASSES);
  const feedbackCount = new Float64Array(K_CLASSES);
  for (let i = 0; i < n; i += 1) {
    const c = y[i] as number;
    if (src[i] === SRC_FEEDBACK) feedbackCount[c] = (feedbackCount[c] as number) + 1;
    else calibration[c] = (calibration[c] as number) + (w[i] as number);
  }
  const feedbackWeight = Array.from(feedbackCount, (count, c) =>
    count > 0
      ? Math.min(FEEDBACK_ROW_WEIGHT, (FEEDBACK_CAP_SHARE * (calibration[c] as number)) / count)
      : 0,
  );
  const totals = new Float64Array(K_CLASSES);
  for (let i = 0; i < n; i += 1) {
    const c = y[i] as number;
    const raw = src[i] === SRC_FEEDBACK ? (feedbackWeight[c] as number) : (w[i] as number);
    w[i] = raw;
    totals[c] = (totals[c] as number) + raw;
  }
  let present = 0;
  let grand = 0;
  for (const t of totals) {
    if (t > 0) {
      present += 1;
      grand += t;
    }
  }
  for (let i = 0; i < n; i += 1) {
    const t = totals[y[i] as number] as number;
    w[i] = t > 0 ? ((w[i] as number) * grand) / (present * t) : 0;
  }

  return { data: { n, d, k: K_CLASSES, X, y, w }, fold, src, parent, nonEmpty };
}

/** Rows of `assembled` selected by `keep`, as a new training set. */
function subset(assembled: Assembled, keep: (i: number) => boolean): SoftmaxData {
  const { d, k } = assembled.data;
  const idx: number[] = [];
  for (let i = 0; i < assembled.data.n; i += 1) if (keep(i)) idx.push(i);
  const X = new Float64Array(idx.length * d);
  const y = new Uint8Array(idx.length);
  const w = new Float64Array(idx.length);
  idx.forEach((i, j) => {
    X.set(assembled.data.X.subarray(i * d, i * d + d), j * d);
    y[j] = assembled.data.y[i] as number;
    w[j] = assembled.data.w[i] as number;
  });
  return { n: idx.length, d, k, X, y, w };
}

/** Training rows of fold `k`: every row (real or pseudo) whose sample is outside fold k. */
export function foldTrainingRows(assembled: Assembled, k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < assembled.data.n; i += 1) if (assembled.fold[i] !== k) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------------------
// Cross-validation, trust and report
// ---------------------------------------------------------------------------------------

export interface CrossValidation {
  lambda: number;
  /** Out-of-fold binary log-likelihood per λ (grid order). */
  scores: number[];
  /** Out-of-fold probabilities of the real rows at the chosen λ (n × K, NaN for pseudo). */
  oof: Float64Array;
}

export function crossValidate(assembled: Assembled): CrossValidation {
  const { n, d, k } = assembled.data;
  const grid = LAMBDA_GRID;
  const oofByLambda = grid.map(() => new Float64Array(n * k).fill(Number.NaN));
  const scores = grid.map(() => 0);
  const probs = new Float64Array(k);
  for (let f = 0; f < CV_FOLDS; f += 1) {
    const train = subset(assembled, (i) => assembled.fold[i] !== f);
    const test: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (assembled.fold[i] === f && assembled.src[i] !== SRC_PSEUDO) test.push(i);
    }
    if (test.length === 0) continue;
    if (train.n === 0 || !hasWeight(train)) continue;
    let init: SoftmaxParams | null = null;
    grid.forEach((lambda, g) => {
      const fit = fitSoftmax(train, { lambda, maxIter: CV_MAX_ITER, tol: CV_TOL, init });
      init = fit.params;
      const store = oofByLambda[g] as Float64Array;
      for (const i of test) {
        softmaxProbs(fit.params, d, k, assembled.data.X.subarray(i * d, i * d + d), probs);
        store.set(probs, i * k);
        const pStudy = clamp((probs[0] as number) + (probs[1] as number), 1e-9, 1 - 1e-9);
        const ll = isStudyIndex(assembled.data.y[i] as number)
          ? Math.log(pStudy)
          : Math.log(1 - pStudy);
        scores[g] = (scores[g] as number) + (assembled.data.w[i] as number) * ll;
      }
    });
  }
  // Best score; ties go to the stronger regularisation (earlier in the grid).
  let best = 0;
  scores.forEach((s, g) => {
    if (s > (scores[best] as number) + 1e-12) best = g;
  });
  return { lambda: grid[best] as number, scores, oof: oofByLambda[best] as Float64Array };
}

function hasWeight(data: SoftmaxData): boolean {
  for (let i = 0; i < data.n; i += 1) if ((data.w[i] as number) > 0) return true;
  return false;
}

function argmax(values: Float64Array, offset: number, k: number): number {
  let best = 0;
  for (let c = 1; c < k; c += 1) {
    if ((values[offset + c] as number) > (values[offset + best] as number)) best = c;
  }
  return best;
}

/** π_c = P(truly study | predicted c) for c ∈ {phone, away}, smoothed and capped (§6.7). */
export function trustFromOof(
  assembled: Assembled,
  oof: Float64Array,
): { phone: number; away: number } {
  const k = assembled.data.k;
  const counts = { phone: [0, 0], away: [0, 0] };
  for (let i = 0; i < assembled.data.n; i += 1) {
    if (assembled.src[i] === SRC_PSEUDO || assembled.nonEmpty[i] !== 1) continue;
    if (Number.isNaN(oof[i * k] as number)) continue;
    const predicted = argmax(oof, i * k, k);
    const entry =
      predicted === CLASS_INDEX.phone
        ? counts.phone
        : predicted === CLASS_INDEX.away
          ? counts.away
          : null;
    if (!entry) continue;
    entry[0] = (entry[0] as number) + 1;
    if (isStudyIndex(assembled.data.y[i] as number)) entry[1] = (entry[1] as number) + 1;
  }
  const pi = ([n, s]: number[]): number =>
    Math.min(
      TRUST_CAP,
      ((s as number) + TRUST_PRIOR * TRUST_PSEUDO) / ((n as number) + TRUST_PSEUDO),
    );
  return { phone: pi(counts.phone), away: pi(counts.away) };
}

/** Out-of-fold report on the calibration rows (§6.2 `weak_separation`, per-class recall). */
export function reportFromOof(
  assembled: Assembled,
  oof: Float64Array,
): { report: CalibrationReport; pair: readonly [CalibrationClass, CalibrationClass] | null } {
  const k = assembled.data.k;
  const confusion = Array.from({ length: K_CLASSES }, () => new Array<number>(K_CLASSES).fill(0));
  let studyN = 0;
  let studyOk = 0;
  let otherN = 0;
  let otherOk = 0;
  for (let i = 0; i < assembled.data.n; i += 1) {
    if (assembled.src[i] !== SRC_CALIBRATION) continue;
    if (Number.isNaN(oof[i * k] as number)) continue;
    const truth = assembled.data.y[i] as number;
    const predicted = argmax(oof, i * k, k);
    const row = confusion[truth] as number[];
    row[predicted] = (row[predicted] as number) + 1;
    const pStudy = (oof[i * k] as number) + (oof[i * k + 1] as number);
    if (isStudyIndex(truth)) {
      studyN += 1;
      if (pStudy >= 0.5) studyOk += 1;
    } else {
      otherN += 1;
      if (pStudy < 0.5) otherOk += 1;
    }
  }
  const rates: number[] = [];
  if (studyN > 0) rates.push(studyOk / studyN);
  if (otherN > 0) rates.push(otherOk / otherN);
  const balanced = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const recall = {} as Record<CalibrationClass, number | null>;
  CALIBRATION_CLASSES.forEach((cls, c) => {
    const row = confusion[c] as number[];
    const total = row.reduce((a, b) => a + b, 0);
    recall[cls] = total > 0 ? (row[c] as number) / total : null;
  });
  const weak = balanced < WEAK_SEPARATION;
  let pair: readonly [CalibrationClass, CalibrationClass] | null = null;
  if (weak) {
    let worst = -1;
    for (let s = 0; s < 2; s += 1) {
      for (let o = 2; o < K_CLASSES; o += 1) {
        const ns = (confusion[s] as number[]).reduce((a, b) => a + b, 0);
        const no = (confusion[o] as number[]).reduce((a, b) => a + b, 0);
        const rate =
          (ns > 0 ? ((confusion[s] as number[])[o] as number) / ns : 0) +
          (no > 0 ? ((confusion[o] as number[])[s] as number) / no : 0);
        if (rate > worst) {
          worst = rate;
          pair = [
            CALIBRATION_CLASSES[s] as CalibrationClass,
            CALIBRATION_CLASSES[o] as CalibrationClass,
          ];
        }
      }
    }
  }
  return {
    report: { cvBinaryBalancedAccuracy: balanced, recall, confusion, weak },
    pair,
  };
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

function toModel(
  space: FeatureSpace,
  lambda: number,
  params: SoftmaxParams,
  d: number,
): SoftmaxModelData {
  const W: number[][] = [];
  for (let c = 0; c < K_CLASSES; c += 1) W.push(Array.from(params.W.subarray(c * d, c * d + d)));
  return {
    kind: 'softmax-l2',
    lambda,
    center: [...space.center],
    scale: [...space.scale],
    anchors: space.anchors.map((a) => [...a]),
    sigma: space.sigma,
    W,
    b: Array.from(params.b),
  };
}

export function modelSpace(model: SoftmaxModelData): FeatureSpace {
  return { center: model.center, scale: model.scale, anchors: model.anchors, sigma: model.sigma };
}

export function modelParams(model: SoftmaxModelData): SoftmaxParams {
  const d = phiDim(model.anchors.length);
  const W = new Float64Array(K_CLASSES * d);
  model.W.forEach((row, c) => W.set(row.slice(0, d), c * d));
  return { W, b: Float64Array.from(model.b) };
}

function rowCounts(samples: SampleSet): TrainReport['rows'] {
  let calibration = 0;
  let feedback = 0;
  for (const s of samples.src) {
    if (s === SRC_FEEDBACK) feedback += 1;
    else calibration += 1;
  }
  return { calibration, feedback };
}

export interface FullTraining {
  model: SoftmaxModelData;
  trust: { phone: number; away: number };
  report: CalibrationReport;
  pair: readonly [CalibrationClass, CalibrationClass] | null;
  train: TrainReport;
  cv: CrossValidation;
}

/** Full training: feature space, CV over λ, trust, report and the final fit from zero. */
export function trainFull(
  samples: SampleSet,
  baseline: ScreenBaseline,
  thresholds: ClassifierThresholds,
  clock: Clock | null = null,
): FullTraining {
  const started = clock?.now() ?? 0;
  const space = fitFeatureSpace(samples, baseline);
  const assembled = assembleTraining(samples, baseline, thresholds, space);
  const cv = crossValidate(assembled);
  const fit = fitSoftmax(assembled.data, {
    lambda: cv.lambda,
    maxIter: TRAIN_MAX_ITER,
    tol: TRAIN_TOL,
  });
  const { report, pair } = reportFromOof(assembled, cv.oof);
  return {
    model: toModel(space, cv.lambda, fit.params, assembled.data.d),
    trust: trustFromOof(assembled, cv.oof),
    report,
    pair,
    cv,
    train: {
      iterations: fit.iterations,
      loss: fit.loss,
      rows: rowCounts(samples),
      ms: clock ? Math.max(0, clock.now() - started) : 0,
    },
  };
}

/**
 * Warm retrain after «¡Estaba estudiando!»: fixed λ, standardisation and anchors, starts
 * from the current weights, ≤ 300 iterations. Trust and report stay as they were.
 */
export function trainWarm(
  samples: SampleSet,
  baseline: ScreenBaseline,
  thresholds: ClassifierThresholds,
  model: SoftmaxModelData,
  clock: Clock | null = null,
  maxIter: number = FEEDBACK_MAX_ITER,
): { model: SoftmaxModelData; train: TrainReport } {
  const started = clock?.now() ?? 0;
  const space = modelSpace(model);
  const assembled = assembleTraining(samples, baseline, thresholds, space);
  const fit = fitSoftmax(assembled.data, {
    lambda: model.lambda,
    maxIter,
    tol: TRAIN_TOL,
    init: modelParams(model),
  });
  return {
    model: toModel(space, model.lambda, fit.params, assembled.data.d),
    train: {
      iterations: fit.iterations,
      loss: fit.loss,
      rows: rowCounts(samples),
      ms: clock ? Math.max(0, clock.now() - started) : 0,
    },
  };
}
