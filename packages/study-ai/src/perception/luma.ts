/**
 * Luma statistics of the 32×24 grey thumbnail (pure, DESIGN.md §5.5): brightness, contrast,
 * temporal change, motion where the face was, «covered» and «low light». The previous
 * thumbnail (768 grey values) is kept in memory only for the temporal difference; it never
 * leaves this object and `reset()` wipes it.
 */
import type { Box, GrayThumbnail, LumaFeatures } from '../types';
import { clamp, clamp01 } from '../util/math';
import {
  COVERED_DARK,
  COVERED_STATIC,
  COVERED_STD,
  LOW_LIGHT_BOOST_AFTER_MS,
  LOW_LIGHT_MAX_GAIN,
  LOW_LIGHT_MEAN,
  LOW_LIGHT_TARGET_MEAN,
  MOTION_BOX_SCALE,
} from './constants';
import { scaleBox } from './geometry';

export interface LumaStats {
  mean: number;
  spatialStd: number;
  temporalDiff: number;
  motionNearFace: number;
  covered: boolean;
  lowLight: boolean;
}

/** True when the thumbnail has a usable size and enough values. */
export function isValidThumbnail(gray: GrayThumbnail | null | undefined): gray is GrayThumbnail {
  return (
    !!gray &&
    Number.isInteger(gray.width) &&
    Number.isInteger(gray.height) &&
    gray.width > 0 &&
    gray.height > 0 &&
    !!gray.data &&
    gray.data.length >= gray.width * gray.height
  );
}

/** Mean absolute difference (0–1) inside the normalised `region`, or over all pixels. */
function meanAbsDiff(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  region: Box | null,
): number {
  let x0 = 0;
  let x1 = width;
  let y0 = 0;
  let y1 = height;
  if (region !== null) {
    x0 = clamp(Math.floor((region.cx - region.w / 2) * width), 0, width);
    x1 = clamp(Math.ceil((region.cx + region.w / 2) * width), 0, width);
    y0 = clamp(Math.floor((region.cy - region.h / 2) * height), 0, height);
    y1 = clamp(Math.ceil((region.cy + region.h / 2) * height), 0, height);
  }
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * width + x;
      sum += Math.abs((a[i] as number) - (b[i] as number));
      n += 1;
    }
  }
  return n > 0 ? sum / n / 255 : 0;
}

/**
 * Statistics of one thumbnail. `previous` must have the same size (otherwise the temporal
 * values are 0); `face` is the last user face box, enlarged ×2 for `motionNearFace`.
 */
export function lumaStats(
  gray: GrayThumbnail,
  previous: ArrayLike<number> | null,
  face: Box | null,
): LumaStats {
  const { width, height, data } = gray;
  const n = width * height;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = data[i] as number;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n / 255;
  const variance = Math.max(0, sumSq / n / (255 * 255) - mean * mean);
  const spatialStd = Math.sqrt(variance);

  let temporalDiff = 0;
  let motionNearFace = 0;
  if (previous !== null && previous.length >= n) {
    temporalDiff = meanAbsDiff(data, previous, width, height, null);
    if (face !== null) {
      motionNearFace = meanAbsDiff(data, previous, width, height, scaleBox(face, MOTION_BOX_SCALE));
    }
  }

  const covered =
    spatialStd < COVERED_STD && (mean < COVERED_DARK || temporalDiff < COVERED_STATIC);
  return {
    mean: clamp01(mean),
    spatialStd: clamp01(spatialStd),
    temporalDiff: clamp01(temporalDiff),
    motionNearFace: clamp01(motionNearFace),
    covered,
    lowLight: mean < LOW_LIGHT_MEAN && !covered,
  };
}

/**
 * Samples at ~1 Hz, holds the last values ≤ `holdMs` and tracks how long low light lasted,
 * which decides the brightness gain applied to detector inputs.
 */
export class LumaTracker {
  private previous: Uint8Array | null = null;
  private previousSize = '';
  private latest: LumaFeatures | null = null;
  private lowLightSince: number | null = null;
  private gainValue = 1;

  /** Brightness gain for detector inputs: 1, or clamp(0.4 / mean, 1, 3) after 5 s of low light. */
  get gain(): number {
    return this.gainValue;
  }

  sample(t: number, gray: GrayThumbnail, face: Box | null): LumaFeatures {
    const size = `${gray.width}x${gray.height}`;
    const previous = this.previous !== null && this.previousSize === size ? this.previous : null;
    const stats = lumaStats(gray, previous, face);

    const n = gray.width * gray.height;
    if (this.previous === null || this.previous.length !== n) this.previous = new Uint8Array(n);
    this.previous.set(gray.data.length === n ? gray.data : gray.data.subarray(0, n));
    this.previousSize = size;

    if (stats.lowLight) {
      if (this.lowLightSince === null) this.lowLightSince = t;
      this.gainValue =
        t - this.lowLightSince >= LOW_LIGHT_BOOST_AFTER_MS
          ? clamp(LOW_LIGHT_TARGET_MEAN / Math.max(stats.mean, 1e-6), 1, LOW_LIGHT_MAX_GAIN)
          : 1;
    } else {
      this.lowLightSince = null;
      this.gainValue = 1;
    }

    this.latest = { at: t, ...stats };
    return this.latest;
  }

  /** The held values at `t`, or `null` after `holdMs` (or before any sample). */
  at(t: number, holdMs: number): LumaFeatures | null {
    const latest = this.latest;
    if (latest === null) return null;
    if (!(t - latest.at <= holdMs)) {
      this.latest = null;
      return null;
    }
    return latest;
  }

  reset(): void {
    if (this.previous !== null) this.previous.fill(0);
    this.previous = null;
    this.previousSize = '';
    this.latest = null;
    this.lowLightSince = null;
    this.gainValue = 1;
  }
}
