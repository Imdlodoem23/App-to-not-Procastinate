import { describe, expect, it } from 'vitest';
import { defaultDetailRequest, resolveHarness } from '../../../src/main/app/harness';
import { fakeDisplay, fakeDisplaySource } from '../../../src/main/windows/fake-display';
import { windowLayout } from '../../../src/main/windows/geometry';
import { DISPLAY_PRESETS, layoutForDisplay } from '../../../src/shared/fixtures';

const LAUNCH = { display: null, fakeWorkArea: null, theme: null, show: false };

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
});
