/**
 * Clocks for the main process (`Clock` from contracts.ts):
 *
 * - `systemClock`: `Date.now()` and the real timers.
 * - `createManualClock(startMs)`: the harness's frozen clock. Time moves only through
 *   `advance(ms)`, which runs every timer that became due in due-time order (setting `now()`
 *   to each timer's due time first, so timers scheduled by a timer fire at the right moment).
 *   Tests use it too: every timer of the core (poll, retries, the 5 s undo, notification
 *   flushes, the 3 s create timeout) runs on the injected clock.
 *
 * Pure module: no Electron import.
 */
import type { Clock, TimerHandle } from '../contracts';

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): TimerHandle => setTimeout(fn, Math.max(0, ms)),
  clearTimeout: (handle: TimerHandle): void => clearTimeout(handle),
});

export interface ManualClock extends Clock {
  /** Move time forward and run the timers that became due (in due order). */
  advance(ms: number): void;
  /** Timers still waiting. */
  pendingTimers(): number;
  /** Due time of the next timer, or `null`. */
  nextDueAt(): number | null;
}

interface ManualTimer {
  id: number;
  dueAt: number;
  fn: () => void;
}

/**
 * A frozen clock. Handles are opaque objects cast to `TimerHandle` (Node's `Timeout` type):
 * callers only pass them back to `clearTimeout`.
 */
export function createManualClock(startMs: number): ManualClock {
  let now = startMs;
  let nextId = 1;
  const timers = new Map<number, ManualTimer>();
  const handles = new WeakMap<object, number>();

  function takeNextDue(limit: number): ManualTimer | null {
    let best: ManualTimer | null = null;
    for (const timer of timers.values()) {
      if (timer.dueAt > limit) continue;
      if (best === null || timer.dueAt < best.dueAt || (timer.dueAt === best.dueAt && timer.id < best.id)) {
        best = timer;
      }
    }
    if (best) timers.delete(best.id);
    return best;
  }

  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): TimerHandle {
      const id = nextId++;
      timers.set(id, { id, dueAt: now + Math.max(0, ms), fn });
      const handle = { manualTimer: id };
      handles.set(handle, id);
      return handle as unknown as TimerHandle;
    },
    clearTimeout(handle: TimerHandle): void {
      const id = handles.get(handle as unknown as object);
      if (id !== undefined) timers.delete(id);
    },
    advance(ms: number): void {
      const target = now + Math.max(0, ms);
      for (;;) {
        const timer = takeNextDue(target);
        if (!timer) break;
        now = Math.max(now, timer.dueAt);
        timer.fn();
      }
      now = target;
    },
    pendingTimers: () => timers.size,
    nextDueAt(): number | null {
      let min: number | null = null;
      for (const t of timers.values()) if (min === null || t.dueAt < min) min = t.dueAt;
      return min;
    },
  };
}

/** Resolves after `ms` on `clock` (a manual clock resolves on `advance`). */
export function sleep(clock: Clock, ms: number): { promise: Promise<void>; cancel(): void } {
  let handle: TimerHandle | null = null;
  let resolveFn: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    handle = clock.setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel(): void {
      if (handle !== null) clock.clearTimeout(handle);
      resolveFn?.();
    },
  };
}
