/**
 * Multinomial logistic regression with L2 (owner: LEARNING). DESIGN.md §6.6.
 *
 *   J(W, b) = −(1/Σw) Σ wᵢ log softmax(W φᵢ + b)_{yᵢ} + (λ/2)‖W‖²   (the bias is not regularised)
 *
 * Optimiser: L-BFGS with Armijo backtracking. The design named Nesterov accelerated gradient
 * with adaptive restart (still here as `method: 'nag'`), but at λ ≤ 1e-3 it needs 500–1 000
 * gradient evaluations per fit, which puts the 16 CV fits far over the 2 s budget; L-BFGS
 * reaches the same optimum (J is convex and strictly convex in W) in a few dozen.
 * L is a valid Lipschitz bound of ∇J, used for the first and the fallback step: the softmax
 * Hessian block is ≼ ½·I, so ∇²J ≼ ½·λmax(Σ w̃ᵢ φ̃ᵢφ̃ᵢᵀ) + λ with φ̃ = [φ, 1] (λmax from a
 * deterministic power iteration with a 10 % margin, capped by the trace). Starts from zero
 * (or a warm start), stops at ‖∇J‖∞ < tol or after `maxIter` steps. Pure and deterministic:
 * two runs on the same data are bit-identical.
 */

/** A training set: n rows of d features (row-major), labels in 0…k−1 and weights ≥ 0. */
export interface SoftmaxData {
  n: number;
  d: number;
  k: number;
  X: Float64Array;
  y: Uint8Array;
  w: Float64Array;
}

/** θ = [W (k × d, row-major), b (k)]. */
export interface SoftmaxParams {
  W: Float64Array;
  b: Float64Array;
}

export interface SoftmaxFitOptions {
  lambda: number;
  maxIter: number;
  tol: number;
  init?: SoftmaxParams | null;
  /** `lbfgs` (default) or the design's original `nag`. */
  method?: 'lbfgs' | 'nag';
}

const LBFGS_MEMORY = 10;
const LBFGS_MAX_BACKTRACK = 30;
const ARMIJO_C = 1e-4;

export interface SoftmaxFit {
  params: SoftmaxParams;
  iterations: number;
  loss: number;
  gradInf: number;
  converged: boolean;
}

function paramCount(d: number, k: number): number {
  return k * d + k;
}

function pack(params: SoftmaxParams, d: number, k: number): Float64Array {
  const theta = new Float64Array(paramCount(d, k));
  theta.set(params.W.subarray(0, k * d), 0);
  theta.set(params.b.subarray(0, k), k * d);
  return theta;
}

function unpack(theta: Float64Array, d: number, k: number): SoftmaxParams {
  return { W: theta.slice(0, k * d), b: theta.slice(k * d, k * d + k) };
}

/** Sum of weights (positive and finite), or throws. */
function weightSum(data: SoftmaxData): number {
  let s = 0;
  for (let i = 0; i < data.n; i += 1) s += data.w[i] as number;
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('softmax: weights must sum to > 0');
  return s;
}

/**
 * Objective J at θ; writes ∇J into `grad` when given. Log-sum-exp keeps every term finite.
 */
export function softmaxObjective(
  data: SoftmaxData,
  theta: Float64Array,
  lambda: number,
  grad: Float64Array | null,
  wsum: number = weightSum(data),
): number {
  const { n, d, k, X, y, w } = data;
  const nb = k * d;
  const z = new Float64Array(k);
  if (grad) grad.fill(0);
  let loss = 0;
  const invW = 1 / wsum;
  for (let i = 0; i < n; i += 1) {
    const wi = (w[i] as number) * invW;
    if (wi === 0) continue;
    const off = i * d;
    let max = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < k; c += 1) {
      let s = theta[nb + c] as number;
      const base = c * d;
      for (let j = 0; j < d; j += 1) s += (theta[base + j] as number) * (X[off + j] as number);
      z[c] = s;
      if (s > max) max = s;
    }
    const yi = y[i] as number;
    const logitY = z[yi] as number;
    let sum = 0;
    for (let c = 0; c < k; c += 1) {
      const e = Math.exp((z[c] as number) - max);
      z[c] = e;
      sum += e;
    }
    loss += wi * (Math.log(sum) + max - logitY);
    if (!grad) continue;
    const inv = 1 / sum;
    for (let c = 0; c < k; c += 1) {
      const g = wi * ((z[c] as number) * inv - (c === yi ? 1 : 0));
      if (g === 0) continue;
      const base = c * d;
      for (let j = 0; j < d; j += 1)
        grad[base + j] = (grad[base + j] as number) + g * (X[off + j] as number);
      grad[nb + c] = (grad[nb + c] as number) + g;
    }
  }
  let reg = 0;
  for (let p = 0; p < nb; p += 1) {
    const t = theta[p] as number;
    reg += t * t;
    if (grad) grad[p] = (grad[p] as number) + lambda * t;
  }
  return loss + 0.5 * lambda * reg;
}

/** Lipschitz bound of ∇J (see the file comment). */
export function lipschitzBound(data: SoftmaxData, lambda: number, wsum = weightSum(data)): number {
  const { n, d, X, w } = data;
  const m = d + 1;
  // M = Σ w̃ φ̃ φ̃ᵀ (m × m, symmetric)
  const M = new Float64Array(m * m);
  const invW = 1 / wsum;
  for (let i = 0; i < n; i += 1) {
    const wi = (w[i] as number) * invW;
    if (wi === 0) continue;
    const off = i * d;
    for (let a = 0; a < m; a += 1) {
      const xa = a < d ? (X[off + a] as number) : 1;
      if (xa === 0) continue;
      const wa = wi * xa;
      for (let b = a; b < m; b += 1) {
        const xb = b < d ? (X[off + b] as number) : 1;
        M[a * m + b] = (M[a * m + b] as number) + wa * xb;
      }
    }
  }
  let trace = 0;
  for (let a = 0; a < m; a += 1) {
    trace += M[a * m + a] as number;
    for (let b = a + 1; b < m; b += 1) M[b * m + a] = M[a * m + b] as number;
  }
  // Power iteration from a fixed, generic start vector.
  let v = new Float64Array(m);
  for (let a = 0; a < m; a += 1) v[a] = 1 + a / m;
  let est = 0;
  for (let it = 0; it < 100; it += 1) {
    const next = new Float64Array(m);
    for (let a = 0; a < m; a += 1) {
      let s = 0;
      for (let b = 0; b < m; b += 1) s += (M[a * m + b] as number) * (v[b] as number);
      next[a] = s;
    }
    let norm = 0;
    for (let a = 0; a < m; a += 1) norm += (next[a] as number) ** 2;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) break;
    let vnorm = 0;
    for (let a = 0; a < m; a += 1) vnorm += (v[a] as number) ** 2;
    est = norm / Math.sqrt(vnorm);
    for (let a = 0; a < m; a += 1) next[a] = (next[a] as number) / norm;
    v = next;
  }
  const top = Math.min(trace, Math.max(est * 1.1, trace / m));
  return 0.5 * Math.max(top, 1e-12) + lambda;
}

/** Fits the model. Deterministic; never throws on degenerate (constant, huge) features. */
export function fitSoftmax(data: SoftmaxData, options: SoftmaxFitOptions): SoftmaxFit {
  return (options.method ?? 'lbfgs') === 'nag' ? fitNag(data, options) : fitLbfgs(data, options);
}

function maxAbs(v: Float64Array): number {
  let m = 0;
  for (let p = 0; p < v.length; p += 1) m = Math.max(m, Math.abs(v[p] as number));
  return m;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let p = 0; p < a.length; p += 1) s += (a[p] as number) * (b[p] as number);
  return s;
}

function done(
  x: Float64Array,
  d: number,
  k: number,
  iterations: number,
  loss: number,
  gradInf: number,
  tol: number,
): SoftmaxFit {
  return { params: unpack(x, d, k), iterations, loss, gradInf, converged: gradInf < tol };
}

/**
 * L-BFGS (memory 10) with Armijo backtracking from a unit step. When the quasi-Newton
 * direction fails to descend, the step falls back to the plain gradient step 1/L, which
 * always decreases J because L bounds its curvature.
 */
function fitLbfgs(data: SoftmaxData, options: SoftmaxFitOptions): SoftmaxFit {
  const { d, k } = data;
  const lambda = Math.max(0, options.lambda);
  const wsum = weightSum(data);
  const L = lipschitzBound(data, lambda, wsum);
  const size = paramCount(d, k);

  let x = options.init ? pack(options.init, d, k) : new Float64Array(size);
  let g = new Float64Array(size);
  let f = softmaxObjective(data, x, lambda, g, wsum);
  const S: Float64Array[] = [];
  const Y: Float64Array[] = [];
  const rho: number[] = [];
  const alpha = new Float64Array(LBFGS_MEMORY);

  for (let iterations = 0; ; iterations += 1) {
    const gradInf = maxAbs(g);
    if (gradInf < options.tol || iterations >= options.maxIter) {
      return done(x, d, k, iterations, f, gradInf, options.tol);
    }

    // Two-loop recursion: dir = −H·g.
    const q = g.slice();
    for (let i = S.length - 1; i >= 0; i -= 1) {
      const a = (rho[i] as number) * dot(S[i] as Float64Array, q);
      alpha[i] = a;
      const yi = Y[i] as Float64Array;
      for (let p = 0; p < size; p += 1) q[p] = (q[p] as number) - a * (yi[p] as number);
    }
    const last = S.length - 1;
    const gamma =
      last >= 0
        ? dot(S[last] as Float64Array, Y[last] as Float64Array) /
          dot(Y[last] as Float64Array, Y[last] as Float64Array)
        : 1 / L;
    for (let p = 0; p < size; p += 1) q[p] = gamma * (q[p] as number);
    for (let i = 0; i < S.length; i += 1) {
      const b = (rho[i] as number) * dot(Y[i] as Float64Array, q);
      const si = S[i] as Float64Array;
      const coef = (alpha[i] as number) - b;
      for (let p = 0; p < size; p += 1) q[p] = (q[p] as number) + coef * (si[p] as number);
    }
    const dir = q;
    for (let p = 0; p < size; p += 1) dir[p] = -(dir[p] as number);
    const slope = dot(g, dir);

    const xNew = new Float64Array(size);
    const gNew = new Float64Array(size);
    let fNew = Number.POSITIVE_INFINITY;
    let accepted = false;
    if (slope < 0 && Number.isFinite(slope)) {
      let step = 1;
      for (let tries = 0; tries < LBFGS_MAX_BACKTRACK; tries += 1) {
        for (let p = 0; p < size; p += 1) xNew[p] = (x[p] as number) + step * (dir[p] as number);
        fNew = softmaxObjective(data, xNew, lambda, gNew, wsum);
        if (fNew <= f + ARMIJO_C * step * slope) {
          accepted = true;
          break;
        }
        step *= 0.5;
      }
    }
    if (!accepted) {
      // Safe gradient step; forget the curvature pairs.
      S.length = 0;
      Y.length = 0;
      rho.length = 0;
      for (let p = 0; p < size; p += 1) xNew[p] = (x[p] as number) - (g[p] as number) / L;
      fNew = softmaxObjective(data, xNew, lambda, gNew, wsum);
      if (!(fNew < f)) return done(x, d, k, iterations, f, gradInf, options.tol); // stalled
    }

    const s = new Float64Array(size);
    const yv = new Float64Array(size);
    for (let p = 0; p < size; p += 1) {
      s[p] = (xNew[p] as number) - (x[p] as number);
      yv[p] = (gNew[p] as number) - (g[p] as number);
    }
    const sy = dot(s, yv);
    if (sy > 1e-12 * Math.sqrt(dot(s, s) * dot(yv, yv))) {
      if (S.length === LBFGS_MEMORY) {
        S.shift();
        Y.shift();
        rho.shift();
      }
      S.push(s);
      Y.push(yv);
      rho.push(1 / sy);
    }
    x = xNew;
    g = gNew;
    f = fNew;
  }
}

/**
 * Nesterov accelerated gradient with gradient-based adaptive restart (O'Donoghue & Candès),
 * fixed step 1/L: the design's original optimiser, kept as a cross-check in the tests. It
 * reaches the same optimum but needs 500–1 000 steps at λ ≤ 1e-3.
 */
function fitNag(data: SoftmaxData, options: SoftmaxFitOptions): SoftmaxFit {
  const { d, k } = data;
  const lambda = Math.max(0, options.lambda);
  const wsum = weightSum(data);
  const step = 1 / lipschitzBound(data, lambda, wsum);
  const size = paramCount(d, k);

  let x = options.init ? pack(options.init, d, k) : new Float64Array(size);
  let yv = x.slice();
  const g = new Float64Array(size);
  let t = 1;
  for (let iterations = 0; ; iterations += 1) {
    const loss = softmaxObjective(data, yv, lambda, g, wsum);
    const gradInf = maxAbs(g);
    if (gradInf < options.tol || iterations >= options.maxIter) {
      return done(yv, d, k, iterations, loss, gradInf, options.tol);
    }
    const xNew = new Float64Array(size);
    let restartDot = 0;
    for (let p = 0; p < size; p += 1) {
      const v = (yv[p] as number) - step * (g[p] as number);
      xNew[p] = v;
      restartDot += (g[p] as number) * (v - (x[p] as number));
    }
    if (restartDot > 0) {
      // Momentum points uphill: restart from the plain gradient step.
      t = 1;
      yv = xNew.slice();
    } else {
      const tNew = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      const beta = (t - 1) / tNew;
      for (let p = 0; p < size; p += 1) {
        yv[p] = (xNew[p] as number) + beta * ((xNew[p] as number) - (x[p] as number));
      }
      t = tNew;
    }
    x = xNew;
  }
}

/** Class probabilities for one φ (log-sum-exp; always finite and summing to 1). */
export function softmaxProbs(
  params: SoftmaxParams,
  d: number,
  k: number,
  phi: ArrayLike<number>,
  out: Float64Array,
): Float64Array {
  let max = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < k; c += 1) {
    let s = params.b[c] as number;
    const base = c * d;
    for (let j = 0; j < d; j += 1) s += (params.W[base + j] as number) * (phi[j] as number);
    if (!Number.isFinite(s)) s = s > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
    out[c] = s;
    if (s > max) max = s;
  }
  let sum = 0;
  for (let c = 0; c < k; c += 1) {
    const e = Math.exp((out[c] as number) - max);
    out[c] = e;
    sum += e;
  }
  for (let c = 0; c < k; c += 1) out[c] = (out[c] as number) / sum;
  return out;
}
