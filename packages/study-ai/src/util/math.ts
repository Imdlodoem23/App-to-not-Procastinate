/** Small numeric helpers shared by every module (pure, allocation-light). */

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** `value` if finite, otherwise `fallback`. */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i] as number;
  return sum / values.length;
}

/** Linear-interpolated quantile (q in [0, 1]) of a copy of `values`; NaN when empty. */
export function quantile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = clamp01(q) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function median(values: ArrayLike<number>): number {
  return quantile(values, 0.5);
}

/** Interquartile range (p75 − p25); NaN when empty. */
export function iqr(values: ArrayLike<number>): number {
  return quantile(values, 0.75) - quantile(values, 0.25);
}

/** Rounds to a fixed step (e.g. 0.1 or 0.001) so JSON round trips are exact. */
export function quantize(value: number, step: number): number {
  const q = Math.round(value / step) * step;
  // Remove binary noise such as 0.30000000000000004.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(q.toFixed(decimals));
}

export const DEG = 180 / Math.PI;
