/** Multinomial logistic regression with L2 (DESIGN.md §6.6), synthetic data only. */
import { describe, expect, it } from 'vitest';
import {
  fitSoftmax,
  softmaxObjective,
  softmaxProbs,
  type SoftmaxData,
  type SoftmaxParams,
} from '../../src/classifier/softmax';
import { gaussian, mulberry32 } from '../../src/util/rng';

/** Gaussian blobs: `centres[c]` with `counts[c]` points each, sd `sd`. */
function blobs(
  centres: readonly (readonly number[])[],
  counts: readonly number[],
  sd: number,
  seed: number,
  weights: 'equal' | 'balanced' = 'equal',
): SoftmaxData {
  const rng = mulberry32(seed);
  const d = centres[0]?.length ?? 0;
  const k = centres.length;
  const n = counts.reduce((a, b) => a + b, 0);
  const X = new Float64Array(n * d);
  const y = new Uint8Array(n);
  const w = new Float64Array(n);
  let i = 0;
  centres.forEach((centre, c) => {
    for (let m = 0; m < (counts[c] as number); m += 1) {
      for (let j = 0; j < d; j += 1) X[i * d + j] = (centre[j] as number) + gaussian(rng, 0, sd);
      y[i] = c;
      w[i] = weights === 'balanced' ? 1 / (counts[c] as number) : 1;
      i += 1;
    }
  });
  return { n, d, k, X, y, w };
}

function predictAll(data: SoftmaxData, params: SoftmaxParams): number[] {
  const out = new Float64Array(data.k);
  const labels: number[] = [];
  for (let i = 0; i < data.n; i += 1) {
    softmaxProbs(params, data.d, data.k, data.X.subarray(i * data.d, (i + 1) * data.d), out);
    let best = 0;
    for (let c = 1; c < data.k; c += 1) if ((out[c] as number) > (out[best] as number)) best = c;
    labels.push(best);
  }
  return labels;
}

function accuracy(data: SoftmaxData, params: SoftmaxParams): number {
  const labels = predictAll(data, params);
  return labels.filter((l, i) => l === data.y[i]).length / data.n;
}

const FIT = { lambda: 1e-3, maxIter: 2_000, tol: 1e-6 };

describe('fitSoftmax', () => {
  it('separates well-separated blobs (≥ 98 %)', () => {
    const data = blobs(
      [
        [0, 0],
        [4, 0],
        [0, 4],
      ],
      [100, 100, 100],
      0.7,
      1,
    );
    const fit = fitSoftmax(data, FIT);
    expect(fit.converged).toBe(true);
    expect(accuracy(data, fit.params)).toBeGreaterThanOrEqual(0.98);
    const test = blobs(
      [
        [0, 0],
        [4, 0],
        [0, 4],
      ],
      [100, 100, 100],
      0.7,
      2,
    );
    expect(accuracy(test, fit.params)).toBeGreaterThanOrEqual(0.98);
  });

  it('reaches close to the Bayes rate on overlapping classes, with sane probabilities', () => {
    // Two unit-variance Gaussians 2 apart: Bayes accuracy Φ(1) ≈ 0.841.
    const data = blobs([[-1], [1]], [2_000, 2_000], 1, 3);
    const fit = fitSoftmax(data, FIT);
    const test = blobs([[-1], [1]], [2_000, 2_000], 1, 4);
    const acc = accuracy(test, fit.params);
    expect(acc).toBeGreaterThan(0.82);
    expect(acc).toBeLessThan(0.87);
    // At x = 0 both classes are equally likely; at x = 1 the true posterior is e²/(1+e²).
    const p = new Float64Array(2);
    softmaxProbs(fit.params, 1, 2, [0], p);
    expect(p[1]).toBeCloseTo(0.5, 1);
    softmaxProbs(fit.params, 1, 2, [1], p);
    expect(p[1]).toBeCloseTo(Math.exp(2) / (1 + Math.exp(2)), 1);
  });

  it('matches a finite-difference gradient', () => {
    const data = blobs(
      [
        [0, 0, 1],
        [1, 2, 0],
        [2, -1, 1],
      ],
      [20, 20, 20],
      1,
      5,
    );
    const rng = mulberry32(9);
    const size = data.k * data.d + data.k;
    const theta = Float64Array.from({ length: size }, () => rng() - 0.5);
    const grad = new Float64Array(size);
    const lambda = 0.05;
    softmaxObjective(data, theta, lambda, grad);
    const h = 1e-6;
    for (let p = 0; p < size; p += 1) {
      const plus = theta.slice();
      const minus = theta.slice();
      plus[p] = (plus[p] as number) + h;
      minus[p] = (minus[p] as number) - h;
      const numeric =
        (softmaxObjective(data, plus, lambda, null) - softmaxObjective(data, minus, lambda, null)) /
        (2 * h);
      expect(Math.abs(numeric - (grad[p] as number))).toBeLessThan(1e-7);
    }
  });

  it('is bit-identical across runs', () => {
    const data = blobs(
      [
        [0, 0],
        [2, 1],
      ],
      [80, 60],
      1.2,
      6,
    );
    const a = fitSoftmax(data, FIT);
    const b = fitSoftmax(data, FIT);
    expect(Array.from(a.params.W)).toEqual(Array.from(b.params.W));
    expect(Array.from(a.params.b)).toEqual(Array.from(b.params.b));
    expect(a.iterations).toBe(b.iterations);
    expect(Object.is(a.loss, b.loss)).toBe(true);
  });

  it('warm-starts in fewer iterations to the same optimum (within 1e-6)', () => {
    const data = blobs(
      [
        [0, 0],
        [3, 0],
        [0, 3],
      ],
      [60, 60, 60],
      1.5,
      7,
    );
    const options = { lambda: 1e-2, maxIter: 5_000, tol: 1e-9 };
    const previous = fitSoftmax(
      blobs(
        [
          [0, 0],
          [3, 0],
          [0, 3],
        ],
        [60, 60, 60],
        1.5,
        8,
      ),
      options,
    );
    const cold = fitSoftmax(data, options);
    const warm = fitSoftmax(data, { ...options, init: previous.params });
    expect(warm.iterations).toBeLessThan(cold.iterations);
    for (let p = 0; p < cold.params.W.length; p += 1) {
      expect(Math.abs((warm.params.W[p] as number) - (cold.params.W[p] as number))).toBeLessThan(
        1e-6,
      );
    }
    for (let c = 0; c < 3; c += 1) {
      expect(Math.abs((warm.params.b[c] as number) - (cold.params.b[c] as number))).toBeLessThan(
        1e-6,
      );
    }
  });

  it('keeps minority recall ≥ 0.9 with a 10:1 imbalance when classes are weighted', () => {
    const centres = [
      [0, 0],
      [2.5, 2.5],
    ] as const;
    const data = blobs(centres, [1_000, 100], 1, 10, 'balanced');
    const fit = fitSoftmax(data, FIT);
    const test = blobs(centres, [1_000, 1_000], 1, 11);
    const labels = predictAll(test, fit.params);
    const minority = labels.slice(1_000);
    expect(minority.filter((l) => l === 1).length / minority.length).toBeGreaterThanOrEqual(0.9);
  });

  it('gives no NaN with zero-variance features', () => {
    const data = blobs(
      [
        [0, 5, 0],
        [2, 5, 0],
      ],
      [50, 50],
      1,
      12,
    );
    for (let i = 0; i < data.n; i += 1) {
      data.X[i * 3 + 1] = 5;
      data.X[i * 3 + 2] = 0;
    }
    const fit = fitSoftmax(data, FIT);
    expect(Array.from(fit.params.W).every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(fit.loss)).toBe(true);
  });

  it('returns finite probabilities summing to 1 for ±1e6 inputs', () => {
    const data = blobs([[0], [3]], [50, 50], 1, 13);
    const fit = fitSoftmax(data, FIT);
    const p = new Float64Array(2);
    for (const x of [1e6, -1e6, 1e300, -1e300]) {
      softmaxProbs(fit.params, 1, 2, [x], p);
      expect(p.every(Number.isFinite)).toBe(true);
      expect((p[0] as number) + (p[1] as number)).toBeCloseTo(1, 12);
    }
  });

  it('agrees with the design’s Nesterov optimiser', () => {
    const data = blobs(
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
      [50, 50, 50],
      1.3,
      14,
    );
    const lbfgs = fitSoftmax(data, { lambda: 1e-2, maxIter: 5_000, tol: 1e-8 });
    const nag = fitSoftmax(data, { lambda: 1e-2, maxIter: 20_000, tol: 1e-8, method: 'nag' });
    expect(lbfgs.converged && nag.converged).toBe(true);
    expect(Math.abs(lbfgs.loss - nag.loss)).toBeLessThan(1e-9);
    expect(lbfgs.iterations).toBeLessThan(nag.iterations);
  });

  it('rejects a training set without weight', () => {
    const data = blobs([[0], [1]], [3, 3], 1, 15);
    data.w.fill(0);
    expect(() => fitSoftmax(data, FIT)).toThrow(RangeError);
  });
});
