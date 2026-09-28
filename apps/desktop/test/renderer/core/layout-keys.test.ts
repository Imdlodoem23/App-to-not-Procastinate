import { describe, expect, it, vi } from 'vitest';
import { chooseLayout, sameLayout } from '../../../src/renderer/src/hooks/layout';
import {
  ESC_PRIORITY,
  KeyRegistry,
  matchCombo,
  mnemonicFromCode,
  type KeyInput,
} from '../../../src/renderer/src/hooks/keys';
import { alignedDelay, armRemainingMs } from '../../../src/renderer/src/hooks/time';
import { TICK_EPSILON_MS } from '../../../src/shared/format';

function key(partial: Partial<KeyInput> & { key: string }): KeyInput {
  return {
    code: '',
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    repeat: false,
    composing: false,
    inText: false,
    ...partial,
  };
}

describe('chooseLayout («Alto automático»)', () => {
  it('keeps regular density when it fits, without measuring compact', () => {
    const measure = vi.fn((d: string) => (d === 'regular' ? 480.2 : 400));
    expect(chooseLayout(measure, 540)).toEqual({ height: 481, density: 'regular', scroll: false });
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('fits exactly at the budget', () => {
    expect(chooseLayout(() => 513, 513)).toEqual({
      height: 513,
      density: 'regular',
      scroll: false,
    });
  });

  it('switches to compact density when regular does not fit', () => {
    expect(chooseLayout((d) => (d === 'regular' ? 560 : 500), 513)).toEqual({
      height: 500,
      density: 'compact',
      scroll: false,
    });
  });

  it('scrolls the section column only when not even compact fits', () => {
    expect(chooseLayout((d) => (d === 'regular' ? 700 : 620), 513.7)).toEqual({
      height: 513,
      density: 'compact',
      scroll: true,
    });
  });

  it('never reports a height below 1 (main rejects 0)', () => {
    expect(chooseLayout(() => 0, 540).height).toBe(1);
    expect(chooseLayout(() => 50, 0)).toEqual({ height: 1, density: 'compact', scroll: true });
  });

  it('compares reports by value', () => {
    const a = { height: 400, density: 'regular' as const, scroll: false };
    expect(sameLayout(a, { ...a })).toBe(true);
    expect(sameLayout(a, { ...a, height: 401 })).toBe(false);
    expect(sameLayout(a, null)).toBe(false);
    expect(sameLayout(null, null)).toBe(true);
  });
});

describe('timers', () => {
  it('aligns to the next multiple of the step', () => {
    expect(alignedDelay(10_250, 1_000)).toBe(750 + TICK_EPSILON_MS);
    expect(alignedDelay(10_000, 1_000)).toBe(1_000 + TICK_EPSILON_MS);
    expect(alignedDelay(59_999, 60_000)).toBe(1 + TICK_EPSILON_MS);
    expect(() => alignedDelay(0, 0)).toThrow(RangeError);
  });

  it('computes what is left of an armed «¿Seguro?»', () => {
    expect(armRemainingMs(1_000, 1_400, 3_000)).toBe(2_600);
    expect(armRemainingMs(1_000, 4_000, 3_000)).toBe(0);
  });
});

describe('KeyRegistry', () => {
  it('runs the Esc cascade by priority and stops at the first handler that returns true', () => {
    const hide = vi.fn();
    const keys = new KeyRegistry('win32', hide);
    const calls: string[] = [];
    keys.registerEscape(ESC_PRIORITY.clearText, () => {
      calls.push('clear');
      return true;
    });
    const offDisarm = keys.registerEscape(ESC_PRIORITY.disarm, () => {
      calls.push('disarm');
      return true;
    });
    keys.registerEscape(ESC_PRIORITY.card, () => {
      calls.push('card');
      return false;
    });
    expect(keys.handle(key({ key: 'Escape' }))).toBe(true);
    expect(calls).toEqual(['disarm']);
    offDisarm();
    keys.handle(key({ key: 'Escape' }));
    expect(calls).toEqual(['disarm', 'card', 'clear']);
    expect(hide).not.toHaveBeenCalled();
  });

  it('falls back to hiding the window when nothing is left to back out of', () => {
    const hide = vi.fn();
    const keys = new KeyRegistry('linux', hide);
    keys.registerEscape(ESC_PRIORITY.card, () => false);
    expect(keys.handle(key({ key: 'Escape' }))).toBe(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('ignores keys while an IME composes and bare modifiers', () => {
    const hide = vi.fn();
    const keys = new KeyRegistry('win32', hide);
    expect(keys.handle(key({ key: 'Escape', composing: true }))).toBe(false);
    expect(keys.handle(key({ key: 'Alt', alt: true }))).toBe(false);
    expect(hide).not.toHaveBeenCalled();
  });

  it('accepts a chord key within its window only', () => {
    let now = 0;
    const keys = new KeyRegistry(
      'win32',
      () => undefined,
      () => now,
    );
    const onKey = vi.fn();
    const onLead = vi.fn();
    keys.registerChord({
      lead: { key: 'e', primary: true },
      keys: ['1', '2', '3', '4'],
      windowMs: 2_000,
      onKey,
      onLead,
    });
    expect(keys.handle(key({ key: 'e', ctrl: true }))).toBe(true);
    expect(onLead).toHaveBeenCalledTimes(1);
    expect(keys.chordPending()).toBe(true);
    now = 1_500;
    expect(keys.handle(key({ key: '2' }))).toBe(true);
    expect(onKey).toHaveBeenCalledWith('2');

    keys.handle(key({ key: 'e', ctrl: true }));
    now = 4_000;
    expect(keys.handle(key({ key: '1' }))).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('uses Cmd on macOS and Ctrl elsewhere as the primary modifier', () => {
    expect(matchCombo(key({ key: 'n', meta: true }), { key: 'n', primary: true }, 'darwin')).toBe(
      true,
    );
    expect(matchCombo(key({ key: 'n', ctrl: true }), { key: 'n', primary: true }, 'darwin')).toBe(
      false,
    );
    expect(
      matchCombo(key({ key: 'N', ctrl: true, shift: false }), { key: 'n', primary: true }, 'win32'),
    ).toBe(true);
    expect(matchCombo(key({ key: 'n' }), { key: 'n', primary: true }, 'win32')).toBe(false);
    // «/» is Shift+7 on Spanish keyboards.
    expect(matchCombo(key({ key: '/', shift: true }), { key: '/', shift: 'any' }, 'win32')).toBe(
      true,
    );
  });

  it('skips bindings in text fields unless they allow it', () => {
    const keys = new KeyRegistry('win32', () => undefined);
    const slash = vi.fn();
    const ctrlN = vi.fn();
    keys.registerBinding({ combo: { key: '/', shift: 'any' }, run: slash });
    keys.registerBinding({ combo: { key: 'n', primary: true }, allowInText: true, run: ctrlN });
    expect(keys.handle(key({ key: '/', inText: true }))).toBe(false);
    expect(keys.handle(key({ key: '/' }))).toBe(true);
    expect(keys.handle(key({ key: 'n', ctrl: true, inText: true }))).toBe(true);
    expect(slash).toHaveBeenCalledTimes(1);
    expect(ctrlN).toHaveBeenCalledTimes(1);
  });

  it('lets a binding decline a key by returning false', () => {
    const keys = new KeyRegistry('win32', () => undefined);
    keys.registerBinding({ combo: { key: 'x' }, run: () => false });
    expect(keys.handle(key({ key: 'x' }))).toBe(false);
  });

  it('presses the first enabled tile of an Alt + letter, by physical key', () => {
    const keys = new KeyRegistry('darwin', () => undefined);
    const disabled = vi.fn();
    const enabled = vi.fn();
    keys.registerMnemonic('A', { enabled: () => false, press: disabled });
    const off = keys.registerMnemonic('a', { enabled: () => true, press: enabled });
    // macOS Option+A types «å»: the physical key still says KeyA.
    expect(keys.handle(key({ key: 'å', code: 'KeyA', alt: true }))).toBe(true);
    expect(enabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
    expect(keys.duplicateMnemonics()).toEqual(['a']);
    off();
    expect(keys.handle(key({ key: 'å', code: 'KeyA', alt: true }))).toBe(false);
    expect(keys.handle(key({ key: 'a', code: 'KeyA', alt: true, ctrl: true }))).toBe(false);
  });

  it('maps physical keys to mnemonic characters', () => {
    expect(mnemonicFromCode('KeyQ')).toBe('q');
    expect(mnemonicFromCode('Digit3')).toBe('3');
    expect(mnemonicFromCode('Numpad1')).toBe('1');
    expect(mnemonicFromCode('Semicolon')).toBeNull();
  });
});
