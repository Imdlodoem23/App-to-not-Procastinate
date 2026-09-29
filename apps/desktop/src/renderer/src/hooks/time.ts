/**
 * Clock math for renderer timers (pure). Every timer is one `setTimeout` re-armed after each
 * render and aligned to the wall clock, so a late timer never accumulates drift (never add a
 * fixed step, never decrement a counter, never use `requestAnimationFrame`).
 */
import { TICK_EPSILON_MS } from '../../../shared/format';

/** Delay until the next multiple of `stepMs` of the wall clock, plus a small epsilon. */
export function alignedDelay(nowMs: number, stepMs: number): number {
  if (!(stepMs > 0)) throw new RangeError(`stepMs must be positive: ${stepMs}`);
  const into = ((nowMs % stepMs) + stepMs) % stepMs;
  return stepMs - into + TICK_EPSILON_MS;
}

/** Time left before an armed «¿Seguro?» (armed at `at`) expires; ≤ 0 means expired. */
export function armRemainingMs(at: number, nowMs: number, armMs: number): number {
  return at + armMs - nowMs;
}
