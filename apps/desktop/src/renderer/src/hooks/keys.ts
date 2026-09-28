/**
 * One key map per window (docs/DESKTOP.md §7.4, PROMPT §10 «Teclado y accesibilidad»). Pure:
 * the DOM listener (`useKeys.tsx`) turns each `keydown` into a `KeyInput` and calls
 * `KeyRegistry.handle`, which says whether the key was used (then the listener prevents the
 * default). Order of precedence:
 *
 * 1. **Esc cascade**: handlers by ascending priority (`ESC_PRIORITY`), first `true` wins;
 *    nothing left → the window's fallback (main: `window:hide`; detail: `window:close-detail`).
 * 2. **Chords**: Ctrl+E (Cmd+E on macOS), then 1 / 2 / 3 / 4 within 2 s.
 * 3. **Bindings**: Ctrl+N / Cmd+N or `/` outside a text field (focus the field), and any a section
 *    adds.
 * 4. **Alt + letter**: the tile with that mnemonic (letters by physical key, so macOS Option
 *    characters and keyboard layouts do not matter).
 */
import type { Platform } from '../../../shared/ui-state';

export interface KeyInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.code` (physical key). */
  code: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  repeat: boolean;
  /** IME composition in progress: never handled. */
  composing: boolean;
  /** Focus is in a text field (input, textarea, contenteditable). */
  inText: boolean;
}

/** Esc cascade priorities: lower runs first (docs/DESKTOP.md §7.4). */
export const ESC_PRIORITY = Object.freeze({
  /** Disarm an in-place «¿Seguro?». */
  disarm: 10,
  /** Close «Otro…» on the extend row. */
  extendOther: 20,
  /** Back from the consequence step of the card. */
  consequence: 30,
  /** Close the confirmation card. */
  card: 40,
  /** Close the field opened with «Nuevo». */
  newField: 50,
  /** Clear the text of «¿Qué quieres hacer?». */
  clearText: 60,
});

/**
 * A key combination. `primary` is Ctrl on Windows and Linux and Cmd on macOS. Letters compare
 * case-insensitively. `shift: 'any'` accepts both (`/` is Shift+7 on Spanish keyboards).
 */
export interface Combo {
  key: string;
  primary?: boolean;
  shift?: boolean | 'any';
  alt?: boolean;
}

export interface Binding {
  combo: Combo;
  /** Also while typing in a text field (default false). */
  allowInText?: boolean;
  /** Return `false` to let the key through. */
  run(): boolean | void;
}

export interface Chord {
  lead: Combo;
  /** Keys accepted after the lead («1», «2», «3», «4»). */
  keys: readonly string[];
  windowMs: number;
  onLead?(): void;
  onKey(key: string): void;
}

export interface MnemonicEntry {
  /** Only enabled entries answer (a disabled tile keeps its letter but does nothing). */
  enabled(): boolean;
  press(): void;
}

/** Chords and the extend row: Ctrl+E, then 1/2/3/4 within 2 s. */
export const CHORD_WINDOW_MS = 2_000;

export function isPrimary(input: Pick<KeyInput, 'ctrl' | 'meta'>, platform: Platform): boolean {
  return platform === 'darwin' ? input.meta && !input.ctrl : input.ctrl && !input.meta;
}

export function matchCombo(input: KeyInput, combo: Combo, platform: Platform): boolean {
  const wantsPrimary = combo.primary ?? false;
  if (wantsPrimary ? !isPrimary(input, platform) : input.ctrl || input.meta) return false;
  if ((combo.alt ?? false) !== input.alt) return false;
  if (combo.shift !== 'any' && (combo.shift ?? false) !== input.shift) return false;
  return input.key.toLowerCase() === combo.key.toLowerCase();
}

/** Mnemonic character of a physical key: `KeyA` → «a», `Digit1` → «1»; `null` otherwise. */
export function mnemonicFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  return null;
}

export class KeyRegistry {
  private escapes: { priority: number; seq: number; handler: () => boolean }[] = [];
  private bindings: Binding[] = [];
  private chords: Chord[] = [];
  private mnemonics = new Map<string, MnemonicEntry[]>();
  private pending: { chord: Chord; at: number } | null = null;
  private seq = 0;

  constructor(
    private readonly platform: Platform,
    private readonly fallbackEscape: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  registerEscape(priority: number, handler: () => boolean): () => void {
    const entry = { priority, seq: this.seq++, handler };
    this.escapes.push(entry);
    this.escapes.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return () => {
      this.escapes = this.escapes.filter((e) => e !== entry);
    };
  }

  registerBinding(binding: Binding): () => void {
    this.bindings.push(binding);
    return () => {
      this.bindings = this.bindings.filter((b) => b !== binding);
    };
  }

  registerChord(chord: Chord): () => void {
    this.chords.push(chord);
    return () => {
      this.chords = this.chords.filter((c) => c !== chord);
      if (this.pending?.chord === chord) this.pending = null;
    };
  }

  registerMnemonic(key: string, entry: MnemonicEntry): () => void {
    const k = key.toLowerCase();
    const list = this.mnemonics.get(k) ?? [];
    list.push(entry);
    this.mnemonics.set(k, list);
    return () => {
      const next = (this.mnemonics.get(k) ?? []).filter((e) => e !== entry);
      if (next.length > 0) this.mnemonics.set(k, next);
      else this.mnemonics.delete(k);
    };
  }

  /** Letters with more than one registered tile (a dev warning: mnemonics must be unique). */
  duplicateMnemonics(): string[] {
    return [...this.mnemonics.entries()].filter(([, l]) => l.length > 1).map(([k]) => k);
  }

  /** Whether a chord lead was pressed and its keys are still accepted. */
  chordPending(): boolean {
    return this.pending !== null && this.now() - this.pending.at <= this.pending.chord.windowMs;
  }

  /** `true` when the key was used (the caller prevents its default action). */
  handle(input: KeyInput): boolean {
    if (input.composing) return false;
    if (isModifierKey(input.key)) return false;

    if (input.key === 'Escape' && !input.ctrl && !input.meta && !input.alt) {
      this.pending = null;
      for (const entry of [...this.escapes]) {
        if (entry.handler()) return true;
      }
      this.fallbackEscape();
      return true;
    }

    const pending = this.pending;
    this.pending = null;
    if (
      pending &&
      !input.ctrl &&
      !input.meta &&
      !input.alt &&
      this.now() - pending.at <= pending.chord.windowMs
    ) {
      const key = input.key.toLowerCase();
      if (pending.chord.keys.includes(key)) {
        pending.chord.onKey(key);
        return true;
      }
    }

    if (!input.repeat) {
      for (const chord of this.chords) {
        if (matchCombo(input, chord.lead, this.platform)) {
          this.pending = { chord, at: this.now() };
          chord.onLead?.();
          return true;
        }
      }
    }

    for (const binding of [...this.bindings].reverse()) {
      if (input.inText && !binding.allowInText) continue;
      if (matchCombo(input, binding.combo, this.platform) && binding.run() !== false) return true;
    }

    if (input.alt && !input.ctrl && !input.meta) {
      const key = mnemonicFromCode(input.code);
      const entry = key ? this.mnemonics.get(key)?.find((e) => e.enabled()) : undefined;
      if (entry) {
        entry.press();
        return true;
      }
    }
    return false;
  }
}

function isModifierKey(key: string): boolean {
  return (
    key === 'Alt' || key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'AltGraph'
  );
}
