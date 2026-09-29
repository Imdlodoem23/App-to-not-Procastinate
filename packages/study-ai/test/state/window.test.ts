/** Time-weighted smoothing window (DESIGN.md §7.5). */
import { describe, expect, it } from 'vitest';
import { ScoreWindow } from '../../src/state/window';
import { mulberry32, uniform } from '../../src/util/rng';

/** Pushes `value(t)` every `interval` ms (± jitter) for `ms`, returns the final time. */
function fill(
  w: ScoreWindow,
  from: number,
  ms: number,
  interval: number,
  value: (t: number) => number,
  jitter = 0,
  seed = 1,
): number {
  const rng = mulberry32(seed);
  let t = from;
  while (t < from + ms) {
    w.push(t, value(t), 1, null, interval);
    t += interval + (jitter ? uniform(rng, -jitter, jitter) : 0);
  }
  return t;
}

describe('ScoreWindow', () => {
  it('gives the same mean at 2, 3 and 4 fps (time, not frames)', () => {
    const value = (t: number): number => (Math.floor(t / 5_000) % 2 === 0 ? 1 : 0.2);
    const scores = [500, 333, 250].map((interval) => {
      const w = new ScoreWindow();
      fill(w, 0, 30_000, interval, value);
      return w.score(30_000, 15_000).score as number;
    });
    for (const s of scores) expect(Math.abs(s - (scores[0] as number))).toBeLessThanOrEqual(2);
  });

  it('weights irregular gaps by the time each sample represents (capped at 1 s)', () => {
    const w = new ScoreWindow();
    w.push(0, 1, 1, null, 250);
    w.push(250, 1, 1, null, 250);
    w.push(3_250, 0, 1, null, 250); // 3 s gap → counts as 1 s
    w.push(3_500, 0, 1, null, 250);
    // 0.5 s of ones, 1.25 s of zeros
    expect(w.score(3_500, 15_000).score).toBe(Math.round((100 * 0.5) / 1.75));
    const irregular = new ScoreWindow();
    fill(irregular, 0, 20_000, 333, () => 0.6, 120, 7);
    expect(irregular.score(20_000, 15_000).score).toBe(60);
  });

  it('weights samples by quality', () => {
    const w = new ScoreWindow();
    w.push(0, 1, 1, null, 500);
    w.push(500, 0, 0.2, null, 500);
    expect(w.score(500, 15_000).score).toBe(Math.round(100 / 1.2));
  });

  it('reports the time fill and forgets old samples', () => {
    const w = new ScoreWindow();
    fill(w, 0, 7_500, 250, () => 1);
    expect(w.score(7_250, 15_000).fill).toBeCloseTo(0.5, 1);
    w.prune(30_000, 15_000);
    expect(w.size).toBe(0);
    expect(w.score(30_000, 15_000)).toEqual({ score: null, fill: 0 });
  });

  it('short window sees only the last 3 s', () => {
    const w = new ScoreWindow();
    fill(w, 0, 12_000, 250, () => 0);
    fill(w, 12_000, 3_000, 250, () => 1);
    expect(w.score(14_750, 3_000).score).toBe(100);
    expect(w.score(14_750, 15_000).score).toBeLessThan(30);
  });

  it('rescore replaces values and drops nulls', () => {
    const w = new ScoreWindow();
    fill(w, 0, 2_000, 500, () => 0);
    w.rescore((s) => (s.at === 0 ? null : 1));
    expect(w.size).toBe(3);
    expect(w.score(1_500, 15_000).score).toBe(100);
  });

  it('ignores non-finite values and weights', () => {
    const w = new ScoreWindow();
    w.push(0, Number.NaN, Number.NaN, null, 500);
    w.push(500, 1, 1, null, 500);
    expect(w.score(500, 15_000).score).toBe(100);
  });
});
