/**
 * In-place «¿Seguro?» (PROMPT §10 «Confirmación en el sitio»): the first press arms (label
 * «¿Seguro? …», red outline, consequence on the help line), a second press within 3 s applies,
 * and Esc, the mouse leaving, the focus leaving, hiding the window or the 3 s passing disarm it.
 * Never a modal. The armed id lives in the window's local state (`main.armed` /
 * `detail.armed`), so a fixture can show it armed.
 *
 * Time is `snapshotNow` (the harness's frozen clock when set), so an armed fixture stays armed
 * and `advance` expires it like the real clock would.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { UI_TIMINGS } from '../../../shared/ui-state';
import { useAppStore, useAppStoreApi } from '../store/context';
import { ESC_PRIORITY } from './keys';
import { armRemainingMs } from './time';
import { useEscape } from './useKeys';

export interface ArmedApi {
  armed: boolean;
  arm(): void;
  disarm(): void;
  /**
   * The press handler: arms, or applies when already armed. `detail` is the click count of
   * the press (`MouseEvent.detail`): the second click of a double click never applies.
   */
  press(apply: () => void, info?: { detail: number }): void;
}

export function useArmed(id: string): ArmedApi {
  const api = useAppStoreApi();
  const armedAt = useAppStore((s) => {
    const armed = s.env.window === 'main' ? s.main.armed : s.detail.armed;
    return armed?.id === id ? armed.at : null;
  });
  const visible = useAppStore((s) => s.env.visible);
  const frozen = useAppStore((s) => s.snapshot.harness?.frozenNowMs ?? null);
  const armed = armedAt !== null;

  const now = useCallback(() => api.getState().snapshot.harness?.frozenNowMs ?? Date.now(), [api]);

  const disarm = useCallback(() => {
    const s = api.getState();
    const current = s.env.window === 'main' ? s.main.armed : s.detail.armed;
    if (current?.id === id) s.setArmed(null);
  }, [api, id]);

  const arm = useCallback(() => api.getState().setArmed({ id, at: now() }), [api, id, now]);

  // Expire after 3 s (real clock only; a frozen harness clock moves by `advance`).
  useEffect(() => {
    if (armedAt === null) return undefined;
    const left = armRemainingMs(armedAt, frozen ?? Date.now(), UI_TIMINGS.armMs);
    if (left <= 0) {
      disarm();
      return undefined;
    }
    if (!visible || frozen !== null) return undefined;
    const timer = setTimeout(disarm, left);
    return () => clearTimeout(timer);
  }, [armedAt, frozen, visible, disarm]);

  useEscape(
    ESC_PRIORITY.disarm,
    () => {
      if (!armed) return false;
      disarm();
      return true;
    },
    armed,
  );

  const press = useCallback(
    (apply: () => void, info?: { detail: number }) => {
      const s = api.getState();
      const current = s.env.window === 'main' ? s.main.armed : s.detail.armed;
      if (current?.id !== id) {
        arm();
        return;
      }
      if ((info?.detail ?? 0) >= 2) return;
      if (armRemainingMs(current.at, now(), UI_TIMINGS.armMs) <= 0) {
        arm();
        return;
      }
      s.setArmed(null);
      apply();
    },
    [api, id, arm, now],
  );

  return useMemo(() => ({ armed, arm, disarm, press }), [armed, arm, disarm, press]);
}
