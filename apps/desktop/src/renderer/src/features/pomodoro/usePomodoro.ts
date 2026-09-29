/**
 * The Pomodoro of the running study session, re-rendered every second while the window is visible
 * (the meter's «Descanso 4:12 · la cámara no vigila»), from the guardian's session in the
 * snapshot. `null` without a session or without a Pomodoro. The Study Mode wave mounts it; the
 * camera watcher reads `cameraWatching` from the same pure `sessionPomodoro`.
 */
import { useMemo } from 'react';
import { useNow } from '../../hooks/useNow';
import { useAppStore } from '../../store/context';
import { sessionPomodoro, type PomodoroMoment } from './timer';

export function usePomodoro(): PomodoroMoment | null {
  const session = useAppStore((s) => s.snapshot.state?.study ?? null);
  const running = session !== null && session.pomodoro !== null;
  // Only tick while there is something to count (a hidden window never ticks: `useNow`).
  const now = useNow(running ? 1_000 : 60_000);
  return useMemo(() => (session ? sessionPomodoro(session, now) : null), [session, now]);
}
