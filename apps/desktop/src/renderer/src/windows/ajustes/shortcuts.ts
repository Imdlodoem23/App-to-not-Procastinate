/**
 * «Atajo global» (Ajustes › General), pure: turning a key press into an Electron accelerator
 * (`CommandOrControl+Alt+C`) and an accelerator into what the field shows («Ctrl+Alt+C» on
 * Windows and Linux, «Cmd+Opción+C» on macOS).
 *
 * Keys are read from `KeyboardEvent.code` (the physical key), so the keyboard layout and macOS
 * Option characters never change what is recorded. A combination needs Ctrl/Cmd, Alt or Super
 * (`isAccelerator`), so a bare letter never becomes global; Backspace or Delete alone removes
 * the shortcut and Esc alone cancels the recording.
 */
import { isAccelerator, type ShortcutAction, type ShortcutPrefs } from '../../../../shared/prefs';
import type { Platform } from '../../../../shared/ui-state';
import { AJUSTES } from './i18n';

/** What a key press means while a shortcut field records. */
export type CaptureResult =
  | { kind: 'set'; accelerator: string }
  /** Backspace or Delete without modifiers: no shortcut for this action. */
  | { kind: 'clear' }
  /** Esc without modifiers: stop recording, keep the old combination. */
  | { kind: 'cancel' }
  /** Tab (moves the focus), a modifier alone, or a key Electron cannot register. */
  | { kind: 'ignore' }
  /** A plain key: it needs Ctrl, Cmd or Alt. */
  | { kind: 'need-modifier' };

export interface CaptureInput {
  code: string;
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'Plus',
};

/** The accelerator key of a physical key (`KeyA` → `A`, `Digit1` → `1`), or `null`. */
export function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return code;
  return NAMED_CODES[code] ?? null;
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super']);

/**
 * The combination a key press records. On macOS Cmd is the primary modifier and Ctrl stays
 * `Control`; elsewhere Ctrl is the primary one and the Windows / Super key is `Super`.
 */
export function captureShortcut(input: CaptureInput, platform: Platform): CaptureResult {
  if (MODIFIER_KEYS.has(input.key)) return { kind: 'ignore' };
  const plain = !input.ctrl && !input.meta && !input.alt;
  if (plain && !input.shift) {
    if (input.code === 'Escape') return { kind: 'cancel' };
    if (input.code === 'Backspace' || input.code === 'Delete') return { kind: 'clear' };
    if (input.code === 'Tab') return { kind: 'ignore' };
  }
  if (plain && input.code === 'Tab') return { kind: 'ignore' };
  const key = acceleratorKey(input.code);
  if (!key) return { kind: 'ignore' };
  const mac = platform === 'darwin';
  const parts: string[] = [];
  if (mac ? input.meta : input.ctrl) parts.push('CommandOrControl');
  if (mac && input.ctrl) parts.push('Control');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (!mac && input.meta) parts.push('Super');
  const accelerator = [...parts, key].join('+');
  if (!isAccelerator(accelerator)) return { kind: 'need-modifier' };
  return { kind: 'set', accelerator };
}

function keyName(key: string, platform: Platform): string {
  const K = AJUSTES.shortcuts.keys;
  const mac = platform === 'darwin';
  switch (key) {
    case 'CommandOrControl':
    case 'CmdOrCtrl':
      return mac ? K.cmd : K.ctrl;
    case 'Command':
    case 'Cmd':
      return K.cmd;
    case 'Control':
    case 'Ctrl':
      return K.ctrl;
    case 'Alt':
    case 'Option':
    case 'AltGr':
      return mac ? K.option : K.alt;
    case 'Shift':
      return K.shift;
    case 'Super':
    case 'Meta':
      return mac ? K.cmd : platform === 'win32' ? K.win : K.super;
    case 'Space':
      return K.space;
    case 'Return':
    case 'Enter':
      return K.enter;
    case 'Tab':
      return K.tab;
    case 'Backspace':
      return K.backspace;
    case 'Delete':
      return K.delete;
    case 'Insert':
      return K.insert;
    case 'Escape':
    case 'Esc':
      return K.escape;
    case 'Up':
      return K.up;
    case 'Down':
      return K.down;
    case 'Left':
      return K.left;
    case 'Right':
      return K.right;
    case 'Home':
      return K.home;
    case 'End':
      return K.end;
    case 'PageUp':
      return K.pageUp;
    case 'PageDown':
      return K.pageDown;
    case 'Plus':
      return K.plus;
    default:
      return key;
  }
}

/** «Ctrl+Alt+C» (Windows, Linux), «Cmd+Opción+C» (macOS), in the active language. */
export function acceleratorLabel(accelerator: string, platform: Platform): string {
  return accelerator
    .split('+')
    .map((part) => keyName(part, platform))
    .join('+');
}

/** The other action already using `accelerator` (compared case-insensitively), if any. */
export function shortcutTakenBy(
  shortcuts: ShortcutPrefs,
  action: ShortcutAction,
  accelerator: string,
): ShortcutAction | null {
  const wanted = accelerator.toLowerCase();
  for (const [other, value] of Object.entries(shortcuts) as [ShortcutAction, string | null][]) {
    if (other !== action && value !== null && value.toLowerCase() === wanted) return other;
  }
  return null;
}
