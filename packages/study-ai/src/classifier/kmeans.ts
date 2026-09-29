/**
 * Seeded k-means++ (owner: LEARNING): the RBF anchors of the personal classifier (§6.5).
 * Deterministic: the same points and seed always give the same anchors.
 */
import { median } from '../util/math';
import { mulberry32 } from '../util/rng';

function dist2(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

/** k-means++ seeding followed by Lloyd iterations. Returns ≤ k distinct centres. */
export function kmeansPlusPlus(
  points: readonly (readonly number[])[],
  k: number,
  seed: number,
  iterations: number,
): number[][] {
  const n = points.length;
  if (n === 0 || k <= 0) return [];
  const rng = mulberry32(seed);
  const centres: number[][] = [[...(points[Math.floor(rng() * n)] as readonly number[])]];
  const d2 = new Float64Array(n);
  while (centres.length < k) {
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      let best = Number.POSITIVE_INFINITY;
      for (const c of centres) best = Math.min(best, dist2(points[i] as readonly number[], c));
      d2[i] = best;
      total += best;
    }
    if (!(total > 1e-12)) break; // every point already sits on a centre
    let target = rng() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i += 1) {
      target -= d2[i] as number;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centres.push([...(points[pick] as readonly number[])]);
  }

  const dim = centres[0]?.length ?? 0;
  const assign = new Int32Array(n);
  for (let it = 0; it < iterations; it += 1) {
    let changed = it === 0;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centres.length; c += 1) {
        const d = dist2(points[i] as readonly number[], centres[c] as number[]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed) break; // assignments stable: the centres are already their means
    const sums = centres.map(() => new Float64Array(dim));
    const counts = new Int32Array(centres.length);
    for (let i = 0; i < n; i += 1) {
      const c = assign[i] as number;
      counts[c] = (counts[c] as number) + 1;
      const p = points[i] as readonly number[];
      const s = sums[c] as Float64Array;
      for (let j = 0; j < dim; j += 1) s[j] = (s[j] as number) + (p[j] ?? 0);
    }
    for (let c = 0; c < centres.length; c += 1) {
      const count = counts[c] as number;
      if (count === 0) continue; // an empty cluster keeps its centre
      const s = sums[c] as Float64Array;
      centres[c] = Array.from(s, (v) => v / count);
    }
  }
  return centres;
}

/** Median distance from each point to its nearest centre (NaN without points or centres). */
export function medianNearestDistance(
  points: readonly (readonly number[])[],
  centres: readonly (readonly number[])[],
): number {
  if (points.length === 0 || centres.length === 0) return Number.NaN;
  const d = Float64Array.from(points, (p) => {
    let best = Number.POSITIVE_INFINITY;
    for (const c of centres) best = Math.min(best, dist2(p, c));
    return Math.sqrt(best);
  });
  return median(d);
}
