/**
 * CPU governor (owner: RUNTIME). Pure: picks the fastest loop level whose predicted duty fits
 * the budget; never below 2 fps. DESIGN.md §8.2.
 *
 * - Costs are tracked as EMAs (α = 0.2) of the face/luma work, the object detector run and
 *   the rest of the step (engine tick). One step slower than `outlierMs` is ignored; two in
 *   a row are real and count.
 * - Predicted duty of a level = (vision + other + object / objectEvery) / interval.
 * - Slows down at once when the current level no longer fits; speeds up one level at a time
 *   only after the faster level has fitted 0.75 × target for `upHoldMs`.
 * - A measured process CPU above the limit forces one level slower and blocks speed-ups for
 *   `upHoldMs`.
 * - With no face visible the detector runs at ≥ 1 Hz anyway (it decides hidden vs absent).
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { CpuBudget, LoopLevel, LoopPlan, MonoMs, StepCost } from '../types';

/** L0…L4. The loop starts at L1 (3 fps, objects at 1 Hz). */
export const LOOP_LEVELS: readonly Readonly<LoopLevel>[] = Object.freeze([
  Object.freeze({ intervalMs: 250, objectEvery: 2 }),
  Object.freeze({ intervalMs: 333, objectEvery: 3 }),
  Object.freeze({ intervalMs: 500, objectEvery: 2 }),
  Object.freeze({ intervalMs: 500, objectEvery: 4 }),
  Object.freeze({ intervalMs: 500, objectEvery: 8 }),
]);

export const START_LEVEL = 1;

export const DEFAULT_CPU_BUDGET: Readonly<CpuBudget> = Object.freeze({
  targetDuty: 0.08,
  processCpuLimitPct: 12,
  upHoldMs: 10_000,
  outlierMs: 400,
});

/** EMA weight of a new cost sample. */
const EMA_ALPHA = 0.2;
/** Speed up only when the faster level's predicted duty is ≤ this share of the target. */
const UP_MARGIN = 0.75;
/** Minimum time between two slow-downs forced by the measured process CPU. */
const CPU_FORCE_EVERY_MS = 5_000;
/** Detector rate kept when no face is visible. */
const NO_FACE_OBJECT_HZ = 1;

const MIN_INTERVAL_MS = 1_000 / STUDY_AI_CONSTANTS.maxFps;
const MAX_INTERVAL_MS = 1_000 / STUDY_AI_CONSTANTS.minFps;

interface Ema {
  value: number;
  samples: number;
}

function emaPush(ema: Ema, sample: number): void {
  ema.value = ema.samples === 0 ? sample : ema.value + EMA_ALPHA * (sample - ema.value);
  ema.samples += 1;
}

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

function sanitizeBudget(budget: Partial<CpuBudget>): CpuBudget {
  const pick = (key: keyof CpuBudget): number => {
    const value = budget[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_CPU_BUDGET[key];
  };
  return {
    targetDuty: pick('targetDuty'),
    processCpuLimitPct: pick('processCpuLimitPct'),
    upHoldMs: pick('upHoldMs'),
    outlierMs: pick('outlierMs'),
  };
}

/** Levels clamped to 2–4 fps and ≥ 1 frame per detector run; never empty. */
function sanitizeLevels(levels: readonly LoopLevel[]): readonly Readonly<LoopLevel>[] {
  const out = levels
    .filter((l) => Number.isFinite(l.intervalMs) && Number.isFinite(l.objectEvery))
    .map((l) =>
      Object.freeze({
        intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, l.intervalMs)),
        objectEvery: Math.max(1, Math.round(l.objectEvery)),
      }),
    );
  return out.length > 0 ? out : LOOP_LEVELS;
}

export class CpuGovernor {
  private readonly budget: CpuBudget;
  private readonly levels: readonly Readonly<LoopLevel>[];
  private current: number;
  private readonly vision: Ema = { value: 0, samples: 0 };
  private readonly object: Ema = { value: 0, samples: 0 };
  private readonly other: Ema = { value: 0, samples: 0 };
  /** The previous step was an outlier (a second one in a row is real). */
  private lastWasOutlier = false;
  /** Since when the next faster level has fitted the up margin, or `null`. */
  private fitsFasterSince: MonoMs | null = null;
  /** Speed-ups are blocked until this time (measured CPU over the limit). */
  private holdUntil: MonoMs = Number.NEGATIVE_INFINITY;
  private lastForceAt: MonoMs = Number.NEGATIVE_INFINITY;
  private lastCpuPct: number | null = null;
  private lastCpuAt: MonoMs = Number.NEGATIVE_INFINITY;
  private faceVisible = true;

  constructor(budget: Partial<CpuBudget> = {}, levels: readonly LoopLevel[] = LOOP_LEVELS) {
    this.budget = sanitizeBudget(budget);
    this.levels = sanitizeLevels(levels);
    this.current = Math.min(START_LEVEL, this.levels.length - 1);
  }

  /** Feeds one step's measured cost (EMA α = 0.2; outliers ignored). */
  record(cost: StepCost): void {
    const visionMs = finiteNonNegative(cost.visionMs);
    const objectMs = cost.ranObjects ? finiteNonNegative(cost.objectMs) : 0;
    const otherMs = finiteNonNegative(cost.otherMs);
    if (visionMs + objectMs + otherMs > this.budget.outlierMs && !this.lastWasOutlier) {
      this.lastWasOutlier = true;
      return;
    }
    this.lastWasOutlier = false;
    emaPush(this.vision, visionMs);
    emaPush(this.other, otherMs);
    if (cost.ranObjects) emaPush(this.object, objectMs);
    this.faceVisible = cost.faceSeen;
  }

  /** Optional measured process CPU (% of one core); above the limit forces one level slower. */
  reportProcessCpu(pct: number, at: MonoMs): void {
    if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(at)) return;
    this.lastCpuPct = pct;
    this.lastCpuAt = at;
    if (pct <= this.budget.processCpuLimitPct) return;
    this.holdUntil = Math.max(this.holdUntil, at + this.budget.upHoldMs);
    this.fitsFasterSince = null;
    if (at - this.lastForceAt >= CPU_FORCE_EVERY_MS) {
      this.lastForceAt = at;
      this.current = Math.min(this.levels.length - 1, this.current + 1);
    }
  }

  /** Plan for the next step. With no face visible, objects run at ≥ 1 Hz. */
  plan(now: MonoMs, faceVisible: boolean): LoopPlan {
    this.faceVisible = faceVisible;
    this.update(now);
    const level = this.levels[this.current] as Readonly<LoopLevel>;
    const target = this.budget.targetDuty;
    const last = this.current === this.levels.length - 1;
    const cpuOver =
      this.lastCpuPct !== null &&
      this.lastCpuPct > this.budget.processCpuLimitPct &&
      now - this.lastCpuAt <= this.budget.upHoldMs;
    return {
      level: this.current,
      intervalMs: level.intervalMs,
      objectEvery: this.objectEvery(level, faceVisible),
      lumaEveryMs: STUDY_AI_CONSTANTS.lumaEveryMs,
      overBudget: last && (this.predict(this.current) > target || cpuOver),
    };
  }

  /** Predicted duty (share of one core) of the current level. */
  get duty(): number {
    return this.predict(this.current);
  }

  /** Current level index (0 = fastest). */
  get level(): number {
    return this.current;
  }

  /** Last measured process CPU (% of one core), or `null` when never measured. */
  get processCpuPct(): number | null {
    return this.lastCpuPct;
  }

  private objectEvery(level: Readonly<LoopLevel>, faceVisible: boolean): number {
    if (faceVisible) return level.objectEvery;
    const perSecond = Math.max(1, Math.floor(1_000 / (level.intervalMs * NO_FACE_OBJECT_HZ)));
    return Math.min(level.objectEvery, perSecond);
  }

  private predict(index: number): number {
    const level = this.levels[index] as Readonly<LoopLevel>;
    const every = this.objectEvery(level, this.faceVisible);
    const busy = this.vision.value + this.other.value + this.object.value / every;
    return busy / level.intervalMs;
  }

  private update(now: MonoMs): void {
    if (this.vision.samples === 0) return;
    const target = this.budget.targetDuty;

    // Slow down at once: the fastest level (not faster than now) that fits.
    if (this.predict(this.current) > target) {
      let next = this.current;
      while (next < this.levels.length - 1 && this.predict(next) > target) next += 1;
      this.current = next;
      this.fitsFasterSince = null;
      return;
    }

    // Speed up one level after the faster one has fitted the margin for `upHoldMs`.
    if (this.current === 0 || now < this.holdUntil) {
      this.fitsFasterSince = null;
      return;
    }
    if (this.predict(this.current - 1) <= UP_MARGIN * target) {
      if (this.fitsFasterSince === null) this.fitsFasterSince = now;
      if (now - this.fitsFasterSince >= this.budget.upHoldMs) {
        this.current -= 1;
        this.fitsFasterSince = null;
      }
    } else {
      this.fitsFasterSince = null;
    }
  }
}
