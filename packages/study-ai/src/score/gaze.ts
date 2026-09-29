/**
 * What the observer learns about the user's own eyes during a session (owner: DECISION).
 * DESIGN.md §7.2 and §7.4.
 *
 * - `ScreenGaze`: how far down the eyes look when the user looks at the screen. A laptop
 *   placed low, or progressive lenses, read `lookDown` ≈ 0.5 at the screen; the absolute
 *   «eyes down» threshold (0.45) would then call every screen frame «looking down» and give
 *   it the study floor, even with a distraction in the foreground.
 * - `OnlineEyes`: the glare rule of the profile (median > 0.5 or spread > 0.15), judged on
 *   the session's calm frames with fresh input. A personal profile judges its eyes once, at
 *   calibration; glasses glare from a lamp turned on later, or heavy eyelids at night, must
 *   not read as «eyes closed» for the rest of the session.
 *
 * Deterministic and allocation-free per tick: fixed rings read through histograms.
 */
import { EYES_UNRELIABLE_MEDIAN, EYES_UNRELIABLE_SD, IQR_PER_SD } from '../classifier/constants';
import type { EyeModel } from '../types';
import { clamp01 } from '../util/math';
import {
  EYES_ONLINE_MIN_SAMPLES,
  EYES_ONLINE_SAMPLES,
  GAZE_REF_MIN_SAMPLES,
  GAZE_REF_QUANTILE,
  GAZE_REF_SAMPLES,
  LOOK_DOWN_BLEND,
  LOOK_DOWN_REF_MARGIN,
} from './constants';

/**
 * The latest `size` values in [0, 1], kept as a histogram of `BINS` bins over a ring, so a
 * push and a quantile cost O(1) and O(BINS) on every tick (no sort, no allocation). Values
 * are read back at the bin resolution (0.01), plenty for thresholds of 0.15–0.5.
 */
class RingHistogram {
  private static readonly BINS = 101;
  private readonly ring: Uint8Array;
  private readonly bins = new Uint32Array(RingHistogram.BINS);
  private count = 0;
  private next = 0;

  constructor(size: number) {
    this.ring = new Uint8Array(size);
  }

  get length(): number {
    return this.count;
  }

  push(value: number): void {
    const bin = Math.round(clamp01(value) * (RingHistogram.BINS - 1));
    if (this.count === this.ring.length) {
      const old = this.ring[this.next] as number;
      this.bins[old] = (this.bins[old] as number) - 1;
    } else {
      this.count += 1;
    }
    this.ring[this.next] = bin;
    this.bins[bin] = (this.bins[bin] as number) + 1;
    this.next = (this.next + 1) % this.ring.length;
  }

  /** Nearest-rank quantile (q in [0, 1]); NaN when empty. */
  quantile(q: number): number {
    if (this.count === 0) return Number.NaN;
    const rank = Math.round(clamp01(q) * (this.count - 1));
    let seen = 0;
    for (let bin = 0; bin < RingHistogram.BINS; bin += 1) {
      seen += this.bins[bin] as number;
      if (seen > rank) return bin / (RingHistogram.BINS - 1);
    }
    return 1;
  }
}

/**
 * The user's `lookDown` at the screen: a low quantile (p25) of the latest frames with the
 * head at a screen direction, no fresh input (a hunt-and-peck typist looks at the keyboard
 * then), no phone and a study answer from the classifier. The low quantile keeps a stretch
 * of reading with the eyes only (head level) from raising it, unless it fills three quarters
 * of the ring.
 */
export class ScreenGaze {
  private readonly ring = new RingHistogram(GAZE_REF_SAMPLES);
  private cached: number | null = null;
  private dirty = false;

  push(lookDown: number): void {
    if (!Number.isFinite(lookDown)) return;
    this.ring.push(lookDown);
    this.dirty = true;
  }

  /** `lookDown` at the screen, or `null` until `GAZE_REF_MIN_SAMPLES` were seen. */
  get reference(): number | null {
    if (this.dirty) {
      this.dirty = false;
      this.cached =
        this.ring.length >= GAZE_REF_MIN_SAMPLES ? this.ring.quantile(GAZE_REF_QUANTILE) : null;
    }
    return this.cached;
  }

  /** «Eyes down» for this user: max(0.45, reference + 0.25). */
  get eyesDownAt(): number {
    const ref = this.reference;
    return ref === null ? LOOK_DOWN_BLEND : Math.max(LOOK_DOWN_BLEND, ref + LOOK_DOWN_REF_MARGIN);
  }
}

/**
 * The classifier's eye model, corrected by the session's own open-eye blink values (calm
 * face frames with fresh keyboard or mouse input): unreliable when their median is > 0.5 or
 * their robust spread (IQR / 1.349) is > 0.15, and the fit's intercept is raised to their
 * median when that is higher. With fewer than 20 values the classifier's model stands.
 */
export class OnlineEyes {
  private readonly ring = new RingHistogram(EYES_ONLINE_SAMPLES);
  private base: Readonly<EyeModel> | null = null;
  private cached: Readonly<EyeModel> | null = null;
  private dirty = false;

  push(blink: number): void {
    if (!Number.isFinite(blink)) return;
    this.ring.push(blink);
    this.dirty = true;
  }

  /** Values seen so far (tests, diagnostics). */
  get samples(): number {
    return this.ring.length;
  }

  model(classifier: Readonly<EyeModel>): Readonly<EyeModel> {
    if (this.ring.length < EYES_ONLINE_MIN_SAMPLES) return classifier;
    if (!this.dirty && this.base === classifier && this.cached) return this.cached;
    this.dirty = false;
    this.base = classifier;
    const ring = this.ring;
    const med = ring.quantile(0.5);
    const spread = (ring.quantile(0.75) - ring.quantile(0.25)) / IQR_PER_SD;
    const glare = !(med <= EYES_UNRELIABLE_MEDIAN) || !(spread <= EYES_UNRELIABLE_SD);
    const [a, b] = classifier.blinkFit;
    this.cached = Object.freeze({
      reliable: classifier.reliable && !glare,
      blinkFit: Object.freeze([Math.max(a, med), b] as const),
      closedDelta: classifier.closedDelta,
    });
    return this.cached;
  }
}
