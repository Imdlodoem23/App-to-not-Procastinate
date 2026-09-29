import { describe, expect, it } from 'vitest';
import { defaultDetailRequest, resolveHarness } from '../../../src/main/app/harness';
import {
  fakeDisplay,
  fakeDisplaySource,
  hostOffset,
  pixelStep,
  type HostScreen,
} from '../../../src/main/windows/fake-display';
import { windowLayout } from '../../../src/main/windows/geometry';
import { DISPLAY_PRESETS, layoutForDisplay } from '../../../src/shared/fixtures';

const LAUNCH = {
  display: null,
  fakeWorkArea: null,
  theme: null,
  lang: null,
  show: false,
  neutralServiceIcons: false,
};

describe('harness resolution', () => {
  it('uses the fixture and its display by default', () => {
    const resolved = resolveHarness({ ...LAUNCH, stateId: 'compact-density' });
    expect(resolved.fixture.id).toBe('compact-density');
    expect(resolved.displays.spec()).toEqual({ preset: '1366x768@125', workArea: null });
    expect(resolved.problems).toEqual([]);
  });

  it('falls back to idle and to the fixture display on unknown ids', () => {
    const resolved = resolveHarness({ ...LAUNCH, stateId: 'nope', display: '800x600@100' });
    expect(resolved.fixture.id).toBe('idle');
    expect(resolved.displays.spec().preset).toBe('1920x1080@100');
    expect(resolved.problems).toHaveLength(2);
  });

  it('keeps a custom work area', () => {
    const wa = { x: 0, y: 0, width: 1200, height: 700 };
    const resolved = resolveHarness({ ...LAUNCH, stateId: 'idle', fakeWorkArea: wa });
    expect(resolved.customWorkArea).toBe(true);
    expect(resolved.displays.all()[0]?.workArea).toEqual(wa);
  });

  it('shows the fixture on an English system with --harness-lang=en', () => {
    const resolved = resolveHarness({ ...LAUNCH, stateId: 'idle', lang: 'en' });
    expect(resolved.lang).toBe('en');
    expect(resolved.fixture.snapshot.app.systemLocale).toBe('en');
    expect(resolved.fixture.snapshot.prefs.language).toBe('system');
    expect(resolveHarness({ ...LAUNCH, stateId: 'idle' }).fixture.snapshot.app.systemLocale).toBe(
      'es',
    );
  });

  it('opens each detail window with the request a door would send', () => {
    expect(defaultDetailRequest('bloqueos')).toEqual({ name: 'bloqueos', seed: null, focus: null });
    expect(defaultDetailRequest('emergencia')).toEqual({ name: 'emergencia', blockIds: null });
    expect(defaultDetailRequest('ajustes')).toEqual({ name: 'ajustes', group: null });
  });
});

describe('fake display', () => {
  it('reproduces the preset and its height budget', () => {
    for (const preset of Object.values(DISPLAY_PRESETS)) {
      const { display, frame } = fakeDisplay({ preset: preset.id, workArea: null });
      expect(display.workArea).toEqual(preset.workArea);
      expect(windowLayout('win32', display, frame)).toEqual(layoutForDisplay(preset));
    }
  });

  it('notifies only when the display really changes', () => {
    const source = fakeDisplaySource({ preset: '1920x1080@100', workArea: null });
    let calls = 0;
    source.onChanged(() => {
      calls += 1;
    });
    source.set({ preset: '1920x1080@100', workArea: null });
    expect(calls).toBe(0);
    source.set({ preset: '1366x768@125', workArea: null });
    expect(calls).toBe(1);
    expect(source.fallbackFrame()).toEqual(DISPLAY_PRESETS['1366x768@125'].frame);
    const cursor = source.cursor();
    const wa = source.all()[0]?.workArea;
    expect(wa && cursor.x >= wa.x && cursor.x < wa.x + wa.width).toBe(true);
  });

  it('knows the device pixel step in whole DIP', () => {
    expect(pixelStep(1)).toBe(1);
    expect(pixelStep(1.25)).toBe(4);
    expect(pixelStep(1.5)).toBe(2);
    expect(pixelStep(2)).toBe(1);
  });

  // A Windows CI runner: 1024×768 px with a 40 px taskbar, at the forced scale factor.
  const runner = (scaleFactor: number, anchor: 'top' | 'bottom' = 'bottom'): HostScreen => ({
    workArea: {
      x: 0,
      y: 0,
      width: Math.floor(1024 / scaleFactor),
      height: Math.floor(728 / scaleFactor),
    },
    scaleFactor,
    anchor,
  });

  it('stays put on a real screen that holds it (xvfb 2880×1800)', () => {
    for (const preset of Object.values(DISPLAY_PRESETS)) {
      const s = preset.scaleFactor;
      const host: HostScreen = {
        workArea: { x: 0, y: 0, width: 2880 / s, height: 1800 / s },
        scaleFactor: s,
        anchor: 'bottom',
      };
      expect(hostOffset(preset.workArea, host), preset.id).toEqual({ x: 0, y: 0 });
    }
  });

  it('moves a preset bigger than the real screen onto it, by whole device pixels', () => {
    for (const preset of Object.values(DISPLAY_PRESETS)) {
      const host = runner(preset.scaleFactor);
      const source = fakeDisplaySource({ preset: preset.id, workArea: null }, () => host);
      const display = source.all()[0];
      if (!display) throw new Error('no display');
      const wa = display.workArea;
      const h = host.workArea;
      // The corner the main window sits in is on the real work area, at most one step inside.
      const step = pixelStep(preset.scaleFactor);
      expect(wa.x + wa.width, preset.id).toBeLessThanOrEqual(h.x + h.width);
      expect(wa.x + wa.width, preset.id).toBeGreaterThan(h.x + h.width - step);
      expect(wa.y + wa.height, preset.id).toBeLessThanOrEqual(h.y + h.height);
      // Same size, same pixel grid (`pixelGrid` counts from the display's origin).
      expect(wa.width).toBe(preset.workArea.width);
      expect(display.bounds.height).toBe(preset.bounds.height);
      const px = display.bounds.x * preset.scaleFactor;
      expect(Math.abs(px - Math.round(px)), preset.id).toBeLessThan(1e-9);
      // The cursor (the Linux display choice) follows the move.
      const cursor = source.cursor();
      expect(cursor.x >= wa.x && cursor.x < wa.x + wa.width, preset.id).toBe(true);
    }
    expect(hostOffset(DISPLAY_PRESETS['1920x1080@150'].workArea, runner(1.5))).toEqual({
      x: -598,
      y: -188,
    });
  });

  it('keeps the top edge on a top-anchored (macOS) host', () => {
    const wa = { x: 0, y: 0, width: 1920, height: 1032 };
    const host: HostScreen = {
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
      scaleFactor: 1,
      anchor: 'top',
    };
    expect(hostOffset(wa, host)).toEqual({ x: -480, y: 25 });
  });
});
