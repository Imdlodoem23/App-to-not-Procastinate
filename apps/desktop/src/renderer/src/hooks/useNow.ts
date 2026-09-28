/**
 * The app's «now» for renderer code (docs/DESKTOP.md §7.4): the harness's frozen clock when set
 * (`snapshotNow`), else `Date.now()`, re-rendering every `stepMs` (aligned to the wall clock)
 * only while the window is visible. All renderer code reads time through this hook or through
 * `Countdown`.
 */
import { useEffect, useReducer } from 'react';
import { useAppStore } from '../store/context';
import { alignedDelay } from './time';

/** Re-render trigger for timers (the rendered value is always read from the clock). */
export function useTick(): () => void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  return tick;
}

/** The frozen harness clock, or `null` when the real clock runs. */
export function useFrozenNow(): number | null {
  return useAppStore((s) => s.snapshot.harness?.frozenNowMs ?? null);
}

/**
 * `snapshotNow(snapshot)` read at render time, without a timer of its own. Components that
 * render it re-render after `touchClock()` (show, `ui:prepare-show`).
 */
export function useClockNow(): number {
  const frozen = useFrozenNow();
  useAppStore((s) => s.clockEpoch);
  return frozen ?? Date.now();
}

/** «Now», refreshed every `stepMs` while visible (never with a frozen harness clock). */
export function useNow(stepMs: number): number {
  const frozen = useFrozenNow();
  const visible = useAppStore((s) => s.env.visible);
  const tick = useTick();
  const now = useClockNow();

  useEffect(() => {
    if (!visible || frozen !== null) return undefined;
    const timer = setTimeout(tick, alignedDelay(Date.now(), stepMs));
    return () => clearTimeout(timer);
  });

  return now;
}
