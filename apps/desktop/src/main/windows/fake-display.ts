/**
 * The harness's fake display (docs/DESKTOP.md §8.4, §10): one display built from a
 * `DISPLAY_PRESETS` entry or a custom work area (`CENTRATE_FAKE_WORKAREA`), with the
 * preset's native frame standing in for the frame xvfb does not draw. Pure except for the
 * listener set; loaded only in harness mode.
 *
 * The fake display is a model; the windows still go on the real screen. When that screen is
 * smaller than the preset (Windows CI runners have 1024×768 px, and no xvfb to size), the fake
 * display is moved so its anchored right corner, where the windows sit, lies on the real work
 * area (`hostOffset`). A window that intersects no monitor is not a model of anything: Windows
 * (Chromium's `WM_NCCALCSIZE`) then gives it no frame, so its content grows by the frame's
 * width until its size changes again.
 */
import {
  DISPLAY_PRESETS,
  type DisplayPresetId,
  type FrameInsets,
  type Rect,
} from '../../shared/fixtures';
import type { WindowAnchor } from '../../shared/ui-state';
import type { DisplaySource } from './display-source';
import type { DisplayInfo, Point } from './geometry';

export interface FakeDisplaySpec {
  preset: DisplayPresetId;
  /** Overrides the preset's work area; the bounds keep the preset's taskbar below it. */
  workArea: Rect | null;
}

/** The real screen the fake display is shown on: the primary display, in DIP. */
export interface HostScreen {
  workArea: Rect;
  scaleFactor: number;
  /** The edge the main window keeps (bottom; top on macOS). */
  anchor: WindowAnchor;
}

export interface FakeDisplaySource extends DisplaySource {
  readonly fake: true;
  spec(): FakeDisplaySpec;
  set(spec: FakeDisplaySpec): void;
}

export function fakeDisplay(spec: FakeDisplaySpec): { display: DisplayInfo; frame: FrameInsets } {
  const preset = DISPLAY_PRESETS[spec.preset];
  const frame = { ...preset.frame };
  if (!spec.workArea) {
    return {
      display: {
        id: 1,
        bounds: { ...preset.bounds },
        workArea: { ...preset.workArea },
        scaleFactor: preset.scaleFactor,
      },
      frame,
    };
  }
  const wa = spec.workArea;
  const taskbar = Math.max(0, preset.bounds.height - preset.workArea.height);
  return {
    display: {
      id: 1,
      bounds: { x: wa.x, y: wa.y, width: wa.width, height: wa.height + taskbar },
      workArea: { ...wa },
      scaleFactor: preset.scaleFactor,
    },
    frame,
  };
}

/** Whole DIP between two device pixel edges that fall on whole DIP (4 at 125 %, 2 at 150 %). */
export function pixelStep(scaleFactor: number): number {
  if (!(scaleFactor > 0)) return 1;
  for (let step = 1; step <= 20; step += 1) {
    const px = step * scaleFactor;
    if (Math.abs(px - Math.round(px)) < 1e-6) return step;
  }
  return 1;
}

/**
 * How far to move a fake work area so it lies on `host`'s: nothing when it fits; otherwise its
 * right edge and its anchored edge go inside the host's work area (the left and far edges hang
 * off-screen), by whole device pixels, so the harness's pixel grid stays the real one.
 */
export function hostOffset(workArea: Rect, host: HostScreen): Point {
  const step = pixelStep(host.scaleFactor);
  const down = (v: number): number => Math.floor(v / step) * step;
  const up = (v: number): number => Math.ceil(v / step) * step;
  const h = host.workArea;
  const fitsX = workArea.x >= h.x && workArea.x + workArea.width <= h.x + h.width;
  const fitsY = workArea.y >= h.y && workArea.y + workArea.height <= h.y + h.height;
  const x = fitsX ? 0 : down(h.x + h.width - (workArea.x + workArea.width));
  let y = 0;
  if (!fitsY) {
    y =
      host.anchor === 'bottom'
        ? down(h.y + h.height - (workArea.y + workArea.height))
        : up(h.y - workArea.y);
  }
  // `+ 0` turns a `-0` from `Math.floor` / `Math.ceil` into 0.
  return { x: x + 0, y: y + 0 };
}

function moved(display: DisplayInfo, offset: Point): DisplayInfo {
  const shift = (r: Rect): Rect => ({ ...r, x: r.x + offset.x, y: r.y + offset.y });
  return { ...display, bounds: shift(display.bounds), workArea: shift(display.workArea) };
}

function sameSpec(a: FakeDisplaySpec, b: FakeDisplaySpec): boolean {
  return a.preset === b.preset && JSON.stringify(a.workArea) === JSON.stringify(b.workArea);
}

/**
 * @param host The real screen (read on every use, after `ready`); `null` or omitted: the fake
 *   display stays where the preset puts it.
 */
export function fakeDisplaySource(
  initial: FakeDisplaySpec,
  host: () => HostScreen | null = () => null,
): FakeDisplaySource {
  let current: FakeDisplaySpec = { ...initial };
  let built = fakeDisplay(current);
  const listeners = new Set<() => void>();
  const display = (): DisplayInfo => {
    const screen = host();
    return screen
      ? moved(built.display, hostOffset(built.display.workArea, screen))
      : built.display;
  };
  return {
    fake: true,
    all: () => {
      const d = display();
      return [{ ...d, bounds: { ...d.bounds }, workArea: { ...d.workArea } }];
    },
    cursor: () => {
      const wa = display().workArea;
      return { x: wa.x + Math.floor(wa.width / 2), y: wa.y + Math.floor(wa.height / 2) };
    },
    fallbackFrame: () => ({ ...built.frame }),
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    spec: () => ({ ...current }),
    set(spec) {
      const changed = !sameSpec(spec, current);
      current = { ...spec };
      built = fakeDisplay(current);
      if (changed) for (const listener of listeners) listener();
    },
  };
}
