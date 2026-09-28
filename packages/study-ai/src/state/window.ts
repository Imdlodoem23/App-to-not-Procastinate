/**
 * Time-weighted score window (owner: DECISION). DESIGN.md §7.5.
 *
 * Each sample weighs its quality × the time it represents (the gap since the previous
 * sample, capped at 1 s), so the score means the same at 2, 3 or 4 fps and a drowsy or
 * absent stretch (no samples) does not stretch the next one.
 */
import type { MonoMs, Observation } from '../types';
import { clamp01 } from '../util/math';
import { SAMPLE_MAX_SPAN_MS } from './constants';

export interface WindowSample {
  at: MonoMs;
  span: number;
  weight: number;
  value: number;
  /** Kept to re-score after a feedback retrain (numbers only, dropped with the sample). */
  obs: Observation | null;
}

export interface WindowScore {
  /** Integer 0–100, or `null` without weighted samples. */
  score: number | null;
  /** Covered time / window length, 0–1. */
  fill: number;
}

export class ScoreWindow {
  private samples: WindowSample[] = [];
  private lastAt: MonoMs | null = null;

  /**
   * Adds a sample. `fallbackSpan` is used for the first sample after a clear (normally the
   * tick's own duration).
   */
  push(at: MonoMs, value: number, weight: number, obs: Observation | null, fallbackSpan: number) {
    const gap = this.lastAt === null ? fallbackSpan : at - this.lastAt;
    const span = Math.max(0, Math.min(SAMPLE_MAX_SPAN_MS, Number.isFinite(gap) ? gap : 0));
    this.lastAt = at;
    this.samples.push({
      at,
      span,
      weight: Number.isFinite(weight) ? clamp01(weight) : 0,
      value: Number.isFinite(value) ? clamp01(value) : 0,
      obs,
    });
  }

  /** Drops samples outside the longest window. */
  prune(now: MonoMs, windowMs: number): void {
    const from = now - windowMs;
    let drop = 0;
    while (drop < this.samples.length && (this.samples[drop] as WindowSample).at <= from) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  /** Weighted mean over the samples of the last `spanMs`. */
  score(now: MonoMs, spanMs: number): WindowScore {
    const from = now - spanMs;
    let num = 0;
    let den = 0;
    let covered = 0;
    for (let i = this.samples.length - 1; i >= 0; i -= 1) {
      const s = this.samples[i] as WindowSample;
      if (s.at <= from) break;
      const w = s.weight * s.span;
      num += w * s.value;
      den += w;
      covered += s.span;
    }
    return {
      score: den > 0 ? Math.round((100 * num) / den) : null,
      fill: spanMs > 0 ? clamp01(covered / spanMs) : 0,
    };
  }

  /** Re-scores every sample; `null` removes it. */
  rescore(fn: (sample: WindowSample) => number | null): void {
    const kept: WindowSample[] = [];
    for (const s of this.samples) {
      const value = fn(s);
      if (value === null || !Number.isFinite(value)) continue;
      kept.push({ ...s, value: clamp01(value) });
    }
    this.samples = kept;
  }

  clear(): void {
    this.samples = [];
    this.lastAt = null;
  }

  get size(): number {
    return this.samples.length;
  }
}
