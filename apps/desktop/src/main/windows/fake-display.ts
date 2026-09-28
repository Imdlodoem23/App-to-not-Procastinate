/**
 * The harness's fake display (docs/DESKTOP.md §8.4, §10): one display built from a
 * `DISPLAY_PRESETS` entry or a custom work area (`CENTRATE_FAKE_WORKAREA`), with the
 * preset's native frame standing in for the frame xvfb does not draw. Pure except for the
 * listener set; loaded only in harness mode.
 */
import {
  DISPLAY_PRESETS,
  type DisplayPresetId,
  type FrameInsets,
  type Rect,
} from '../../shared/fixtures';
import type { DisplaySource } from './display-source';
import type { DisplayInfo } from './geometry';

export interface FakeDisplaySpec {
  preset: DisplayPresetId;
  /** Overrides the preset's work area; the bounds keep the preset's taskbar below it. */
  workArea: Rect | null;
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

function sameSpec(a: FakeDisplaySpec, b: FakeDisplaySpec): boolean {
  return a.preset === b.preset && JSON.stringify(a.workArea) === JSON.stringify(b.workArea);
}

export function fakeDisplaySource(initial: FakeDisplaySpec): FakeDisplaySource {
  let current: FakeDisplaySpec = { ...initial };
  let built = fakeDisplay(current);
  const listeners = new Set<() => void>();
  return {
    fake: true,
    all: () => {
      const d = built.display;
      return [{ ...d, bounds: { ...d.bounds }, workArea: { ...d.workArea } }];
    },
    cursor: () => {
      const wa = built.display.workArea;
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
