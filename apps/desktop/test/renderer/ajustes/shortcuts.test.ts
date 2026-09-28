import { describe, expect, it } from 'vitest';
import { withLocale } from '../../../src/shared/i18n/locale';
import { DEFAULT_FEATURE_PREFS, isAccelerator } from '../../../src/shared/prefs';
import {
  acceleratorKey,
  acceleratorLabel,
  captureShortcut,
  shortcutTakenBy,
  type CaptureInput,
} from '../../../src/renderer/src/windows/ajustes/shortcuts';

function press(code: string, mods: Partial<CaptureInput> = {}, key = code): CaptureInput {
  return { code, key, ctrl: false, meta: false, alt: false, shift: false, ...mods };
}

describe('«Atajo global»: recording a combination', () => {
  it('records Ctrl (Cmd on macOS) + Alt + a letter as a portable accelerator', () => {
    expect(captureShortcut(press('KeyC', { ctrl: true, alt: true }, 'c'), 'win32')).toEqual({
      kind: 'set',
      accelerator: 'CommandOrControl+Alt+C',
    });
    expect(captureShortcut(press('KeyC', { meta: true, alt: true }, 'ç'), 'darwin')).toEqual({
      kind: 'set',
      accelerator: 'CommandOrControl+Alt+C',
    });
    // macOS Ctrl stays Control; Windows and Linux Super stays Super.
    expect(captureShortcut(press('KeyK', { ctrl: true }, 'k'), 'darwin')).toEqual({
      kind: 'set',
      accelerator: 'Control+K',
    });
    expect(captureShortcut(press('Digit1', { meta: true, shift: true }, '!'), 'linux')).toEqual({
      kind: 'set',
      accelerator: 'Shift+Super+1',
    });
    expect(captureShortcut(press('F5', { alt: true }), 'win32')).toEqual({
      kind: 'set',
      accelerator: 'Alt+F5',
    });
    expect(captureShortcut(press('ArrowUp', { ctrl: true, alt: true }), 'linux')).toEqual({
      kind: 'set',
      accelerator: 'CommandOrControl+Alt+Up',
    });
  });

  it('every recorded combination is one Electron accepts', () => {
    const codes = ['KeyA', 'Digit0', 'Numpad7', 'F12', 'Space', 'Enter', 'Minus', 'Slash', 'End'];
    for (const code of codes) {
      const result = captureShortcut(press(code, { ctrl: true, shift: true }), 'win32');
      expect(result.kind, code).toBe('set');
      if (result.kind === 'set') expect(isAccelerator(result.accelerator), code).toBe(true);
    }
  });

  it('never makes a bare key or Shift + key global', () => {
    expect(captureShortcut(press('KeyC', {}, 'c'), 'win32')).toEqual({ kind: 'need-modifier' });
    expect(captureShortcut(press('KeyC', { shift: true }, 'C'), 'win32')).toEqual({
      kind: 'need-modifier',
    });
  });

  it('Backspace or Delete removes it, Esc cancels, Tab and modifiers alone pass', () => {
    expect(captureShortcut(press('Backspace'), 'win32')).toEqual({ kind: 'clear' });
    expect(captureShortcut(press('Delete'), 'darwin')).toEqual({ kind: 'clear' });
    expect(captureShortcut(press('Escape'), 'linux')).toEqual({ kind: 'cancel' });
    expect(captureShortcut(press('Tab'), 'linux')).toEqual({ kind: 'ignore' });
    expect(captureShortcut(press('Tab', { shift: true }), 'linux')).toEqual({ kind: 'ignore' });
    expect(captureShortcut(press('ControlLeft', { ctrl: true }, 'Control'), 'win32')).toEqual({
      kind: 'ignore',
    });
    expect(captureShortcut(press('IntlBackslash', { ctrl: true }, '<'), 'win32')).toEqual({
      kind: 'ignore',
    });
    // With a modifier, Esc and Backspace are ordinary keys.
    expect(captureShortcut(press('Escape', { ctrl: true, alt: true }), 'win32')).toEqual({
      kind: 'set',
      accelerator: 'CommandOrControl+Alt+Escape',
    });
  });

  it('maps physical keys, whatever the layout', () => {
    expect(acceleratorKey('KeyZ')).toBe('Z');
    expect(acceleratorKey('Numpad3')).toBe('3');
    expect(acceleratorKey('F24')).toBe('F24');
    expect(acceleratorKey('F25')).toBeNull();
    expect(acceleratorKey('Backquote')).toBe('`');
    expect(acceleratorKey('MediaPlayPause')).toBeNull();
  });
});

describe('«Atajo global»: showing a combination', () => {
  it('uses each system’s key names, in the app language', () => {
    expect(acceleratorLabel('CommandOrControl+Alt+C', 'win32')).toBe('Ctrl+Alt+C');
    expect(acceleratorLabel('CommandOrControl+Alt+C', 'darwin')).toBe('Cmd+Opción+C');
    expect(acceleratorLabel('Shift+Super+Space', 'win32')).toBe('Mayús+Win+Espacio');
    expect(acceleratorLabel('Shift+Super+Space', 'linux')).toBe('Mayús+Super+Espacio');
    expect(withLocale('en', () => acceleratorLabel('CommandOrControl+Alt+C', 'darwin'))).toBe(
      'Cmd+Option+C',
    );
    expect(withLocale('en', () => acceleratorLabel('Control+Shift+Up', 'win32'))).toBe(
      'Ctrl+Shift+Up',
    );
  });

  it('finds the action that already uses a combination', () => {
    const shortcuts = {
      ...DEFAULT_FEATURE_PREFS.shortcuts,
      'extend-15': 'CommandOrControl+Alt+E',
    };
    expect(shortcutTakenBy(shortcuts, 'toggle-mini-timer', 'commandorcontrol+alt+e')).toBe(
      'extend-15',
    );
    expect(shortcutTakenBy(shortcuts, 'extend-15', 'CommandOrControl+Alt+E')).toBeNull();
    expect(shortcutTakenBy(shortcuts, 'extend-15', 'CommandOrControl+Alt+X')).toBeNull();
  });
});
