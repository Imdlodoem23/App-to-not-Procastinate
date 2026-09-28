/**
 * Where displays come from: Electron's `screen`, or, in the harness, one fake display
 * (`fake-display.ts`, loaded only in harness mode) so the screenshot matrix runs on CI's
 * single fixed xvfb screen (docs/DESKTOP.md §8.4, §10).
 */
import { screen } from 'electron';
import type { FrameInsets } from '../../shared/fixtures';
import type { Platform } from '../../shared/ui-state';
import type { HostScreen } from './fake-display';
import type { DisplayInfo, Point } from './geometry';

export interface DisplaySource {
  readonly fake: boolean;
  all(): DisplayInfo[];
  cursor(): Point;
  /**
   * Frame insets to assume when a window reports none (no window manager under xvfb): the
   * fake display's native frame; `null` for real displays (use what the window reports).
   */
  fallbackFrame(): FrameInsets | null;
  /** Display metrics changed, a display was added or removed, or the fake one switched. */
  onChanged(listener: () => void): () => void;
}

export function electronDisplaySource(): DisplaySource {
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  screen.on('display-metrics-changed', emit);
  screen.on('display-added', emit);
  screen.on('display-removed', emit);
  return {
    fake: false,
    all: () =>
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: { ...d.bounds },
        workArea: { ...d.workArea },
        scaleFactor: d.scaleFactor,
      })),
    cursor: () => screen.getCursorScreenPoint(),
    fallbackFrame: () => null,
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The primary display as the harness's host screen: `fake-display.ts` moves the fake display
 * onto it when it does not fit. `null` before `ready`.
 */
export function primaryHostScreen(platform: Platform): HostScreen | null {
  try {
    const primary = screen.getPrimaryDisplay();
    return {
      workArea: { ...primary.workArea },
      scaleFactor: primary.scaleFactor,
      anchor: platform === 'darwin' ? 'top' : 'bottom',
    };
  } catch {
    return null;
  }
}
