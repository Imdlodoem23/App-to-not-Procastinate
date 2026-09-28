/**
 * Profile statistics from calibration rows (owner: LEARNING): screen baseline, learned
 * thresholds and the eye model. DESIGN.md §6.4.
 */
import { COL } from '../classifier/rows';
import {
  BLINK_SLOPE_LIMIT,
  DEFAULT_THRESHOLDS,
  EYES_UNRELIABLE_MEDIAN,
  EYES_UNRELIABLE_SD,
  PERSON_THRESHOLD_MAX,
  PERSON_THRESHOLD_MIN,
  PHONE_THRESHOLD_MAX,
  PHONE_THRESHOLD_MIN,
  PROFILE_CLOSED_DELTA,
  THEIL_SEN_MAX_POINTS,
  THEIL_SEN_MIN_DX,
  THRESHOLD_MARGIN,
} from '../classifier/constants';
import type { ClassifierThresholds, EyeModel, FeatureRow, ScreenBaseline } from '../types';
import { clamp, median, quantile, quantize } from '../util/math';

const col = (rows: readonly FeatureRow[], index: number): Float64Array =>
  Float64Array.from(rows, (r) => r[index] ?? 0);

export const faceRows = (rows: readonly FeatureRow[]): FeatureRow[] =>
  rows.filter((r) => (r[COL.face] ?? 0) >= 0.5);

/** Medians of the screen face rows; `null` without any. */
export function screenBaseline(screenRows: readonly FeatureRow[]): ScreenBaseline | null {
  const rows = faceRows(screenRows);
  if (rows.length === 0) return null;
  const m = (index: number): number => median(col(rows, index));
  return {
    yaw: m(COL.yaw),
    pitch: m(COL.pitch),
    roll: m(COL.roll),
    cx: m(COL.cx),
    cy: m(COL.cy),
    w: Math.max(m(COL.w), 1e-3),
    h: Math.max(m(COL.h), 1e-3),
  };
}

/**
 * phone: clamp(p95 of phone in screen + paper rows + 0.1, 0.45, 0.8) (a calculator seen
 * during calibration). person: clamp(p95 of person in absent rows + 0.1, 0.4, 0.8) (a coat
 * on the chair). Quantised to 0.001.
 */
export function learnThresholds(
  studyRows: readonly FeatureRow[],
  absentRows: readonly FeatureRow[],
): ClassifierThresholds {
  const phone =
    studyRows.length > 0
      ? clamp(
          quantile(col(studyRows, COL.phone), 0.95) + THRESHOLD_MARGIN,
          PHONE_THRESHOLD_MIN,
          PHONE_THRESHOLD_MAX,
        )
      : DEFAULT_THRESHOLDS.phone;
  const person =
    absentRows.length > 0
      ? clamp(
          quantile(col(absentRows, COL.person), 0.95) + THRESHOLD_MARGIN,
          PERSON_THRESHOLD_MIN,
          PERSON_THRESHOLD_MAX,
        )
      : DEFAULT_THRESHOLDS.person;
  return { phone: quantize(phone, 0.001), person: quantize(person, 0.001) };
}

/** Theil–Sen line y ≈ a + b·x (median of pairwise slopes, then median intercept). */
export function theilSen(xs: ArrayLike<number>, ys: ArrayLike<number>): [number, number] {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return [0, 0];
  // Even subsample bounds the O(n²) pair count.
  const step = Math.max(1, n / THEIL_SEN_MAX_POINTS);
  const px: number[] = [];
  const py: number[] = [];
  for (let f = 0; Math.floor(f) < n; f += step) {
    px.push(xs[Math.floor(f)] as number);
    py.push(ys[Math.floor(f)] as number);
  }
  const slopes: number[] = [];
  for (let i = 0; i < px.length; i += 1) {
    for (let j = i + 1; j < px.length; j += 1) {
      const dx = (px[j] as number) - (px[i] as number);
      if (Math.abs(dx) < THEIL_SEN_MIN_DX) continue;
      slopes.push(((py[j] as number) - (py[i] as number)) / dx);
    }
  }
  const b = slopes.length > 0 ? median(slopes) : 0;
  const a = median(Float64Array.from(px, (x, i) => (py[i] as number) - b * x));
  return [a, b];
}

function sd(values: Float64Array): number {
  if (values.length === 0) return 0;
  let m = 0;
  for (const v of values) m += v;
  m /= values.length;
  let s = 0;
  for (const v of values) s += (v - m) ** 2;
  return Math.sqrt(s / values.length);
}

/**
 * blinkFit on screen + paper face rows (reading lowers the eyelids); unreliable when the
 * screen blink is noisy (sd > 0.15) or high (median > 0.5): glasses glare.
 */
export function learnEyes(
  screenRows: readonly FeatureRow[],
  paperRows: readonly FeatureRow[],
  baseline: ScreenBaseline,
): EyeModel {
  const study = faceRows([...screenRows, ...paperRows]);
  const dpitch = Float64Array.from(study, (r) => (r[COL.pitch] ?? 0) - baseline.pitch);
  const blink = col(study, COL.blink);
  const [a, b] = theilSen(dpitch, blink);
  const screenBlink = col(faceRows(screenRows), COL.blink);
  const reliable =
    screenBlink.length > 0 &&
    sd(screenBlink) <= EYES_UNRELIABLE_SD &&
    median(screenBlink) <= EYES_UNRELIABLE_MEDIAN;
  return {
    reliable,
    blinkFit: [
      quantize(clamp(Number.isFinite(a) ? a : 0, 0, 1), 1e-6),
      quantize(clamp(Number.isFinite(b) ? b : 0, -BLINK_SLOPE_LIMIT, BLINK_SLOPE_LIMIT), 1e-6),
    ],
    closedDelta: PROFILE_CLOSED_DELTA,
  };
}
