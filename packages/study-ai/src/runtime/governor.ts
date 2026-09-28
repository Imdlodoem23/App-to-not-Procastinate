/**
 * CPU governor (owner: RUNTIME). Pure: picks the fastest loop level whose predicted duty fits
 * the budget; never below 2 fps. DESIGN.md §8.2.
 */
import type { CpuBudget, LoopLevel, LoopPlan, MonoMs, StepCost } from '../types';
import { notImplemented } from '../util/not-implemented';

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

export class CpuGovernor {
  constructor(_budget: Partial<CpuBudget> = {}, _levels: readonly LoopLevel[] = LOOP_LEVELS) {}

  /** Feeds one step's measured cost (EMA α = 0.2; outliers ignored). */
  record(_cost: StepCost): void {
    notImplemented('CpuGovernor.record');
  }

  /** Optional measured process CPU (% of one core); above the limit forces one level slower. */
  reportProcessCpu(_pct: number, _at: MonoMs): void {
    notImplemented('CpuGovernor.reportProcessCpu');
  }

  /** Plan for the next step. With no face visible, objects run at ≥ 1 Hz. */
  plan(_now: MonoMs, _faceVisible: boolean): LoopPlan {
    return notImplemented('CpuGovernor.plan');
  }

  get duty(): number {
    return notImplemented('CpuGovernor.duty');
  }
}
