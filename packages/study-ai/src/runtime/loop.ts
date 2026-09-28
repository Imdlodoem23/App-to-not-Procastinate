/**
 * The analysis loop (owner: RUNTIME). setTimeout only (never requestAnimationFrame), one step
 * at a time (the next is scheduled after the current one settles), errors counted and
 * survived. Pure: clock and timers are injected. DESIGN.md §8.1.
 */
import type { Clock, LoopPlan, LoopStats, MonoMs, StepCost, TimerApi } from '../types';
import { notImplemented } from '../util/not-implemented';
import type { CpuGovernor } from './governor';

/** One loop step. Returns its cost, or `null` when it did no vision work (break tick). */
export type LoopStep = (now: MonoMs, plan: LoopPlan) => Promise<StepCost | null>;

export class AdaptiveLoop {
  constructor(_step: LoopStep, _governor: CpuGovernor, _clock: Clock, _timers: TimerApi) {}

  start(): void {
    notImplemented('AdaptiveLoop.start');
  }

  /** Clears the pending timer; a step in flight finishes but schedules nothing. */
  stop(): void {
    notImplemented('AdaptiveLoop.stop');
  }

  get running(): boolean {
    return notImplemented('AdaptiveLoop.running');
  }

  get stats(): Readonly<LoopStats> {
    return notImplemented('AdaptiveLoop.stats');
  }
}
