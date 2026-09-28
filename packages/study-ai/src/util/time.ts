/** Real clock and timers (setTimeout only: requestAnimationFrame stops in hidden windows). */
import type { Clock, TimerApi } from '../types';

export const MONOTONIC_CLOCK: Clock = Object.freeze({
  now: () => performance.now(),
});

export const REAL_TIMERS: TimerApi = Object.freeze({
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, Math.max(0, ms)),
  clear: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});
