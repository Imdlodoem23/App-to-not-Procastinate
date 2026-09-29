/**
 * React side of the window key map (`keys.ts`): one `keydown` listener per window, and hooks
 * that register Esc handlers, bindings, chords and mnemonics while a component is mounted.
 * Handlers are read through refs, so they can change every render without re-registering.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useServices } from '../app/services';
import type { Binding, Chord, Combo, KeyInput, KeyRegistry } from './keys';

/** Whether focus is in a text field (Enter, `/` and letters belong to it there). */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      target.type,
    );
  }
  return false;
}

export function toKeyInput(event: KeyboardEvent): KeyInput {
  return {
    key: event.key,
    code: event.code,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    repeat: event.repeat,
    composing: event.isComposing,
    inText: isTextTarget(event.target),
  };
}

/**
 * Installs the window's key listener and the Alt underline (`html[data-alt]` while Alt is
 * held, which underlines tile mnemonics). Call once, in the window root.
 */
export function useKeyListener(registry: KeyRegistry): void {
  useEffect(() => {
    const html = document.documentElement;
    const clearAlt = (): void => {
      delete html.dataset['alt'];
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') html.dataset['alt'] = '';
      if (event.defaultPrevented) return;
      if (registry.handle(toKeyInput(event))) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Alt' || !event.altKey) clearAlt();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearAlt);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearAlt);
      clearAlt();
    };
  }, [registry]);
}

function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * An Esc handler at `priority` (`ESC_PRIORITY`), active while `enabled`. Return `true` when
 * it handled the key (the cascade stops there).
 */
export function useEscape(priority: number, handler: () => boolean, enabled = true): void {
  const { keys } = useServices();
  const latest = useLatest(handler);
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return keys.registerEscape(priority, () => latest.current());
  }, [keys, priority, enabled, latest]);
}

/** A key binding while mounted and `enabled` (`allowInText` to fire inside text fields). */
export function useKeyBinding(
  combo: Combo,
  run: () => boolean | void,
  options: { enabled?: boolean; allowInText?: boolean } = {},
): void {
  const { keys } = useServices();
  const latest = useLatest(run);
  const enabled = options.enabled ?? true;
  const allowInText = options.allowInText ?? false;
  const { key, primary, shift, alt } = combo;
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const binding: Binding = {
      combo: { key, primary, shift, alt },
      allowInText,
      run: () => latest.current(),
    };
    return keys.registerBinding(binding);
  }, [keys, key, primary, shift, alt, enabled, allowInText, latest]);
}

/**
 * A chord (lead combo, then one of `keys` within `windowMs`), e.g. the extend row: Ctrl+E then
 * 1/2/3/4. `onKey` receives the key pressed after the lead.
 */
export function useChord(
  chord: Omit<Chord, 'onKey' | 'onLead'> & {
    onKey: (key: string) => void;
    onLead?: () => void;
  },
  enabled = true,
): void {
  const { keys } = useServices();
  const onKey = useLatest(chord.onKey);
  const onLead = useLatest(chord.onLead);
  const { lead, windowMs } = chord;
  const keyList = chord.keys.join('\u0000');
  const { key, primary, shift, alt } = lead;
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return keys.registerChord({
      lead: { key, primary, shift, alt },
      keys: keyList.split('\u0000'),
      windowMs,
      onLead: () => onLead.current?.(),
      onKey: (k) => onKey.current(k),
    });
  }, [keys, key, primary, shift, alt, keyList, windowMs, enabled, onKey, onLead]);
}

/** Alt + `mnemonic` presses this control while mounted (`enabled` false keeps it silent). */
export function useMnemonic(
  mnemonic: string | undefined,
  press: () => void,
  enabled: boolean,
): void {
  const { keys } = useServices();
  const latestPress = useLatest(press);
  const latestEnabled = useLatest(enabled);
  useLayoutEffect(() => {
    if (!mnemonic) return undefined;
    return keys.registerMnemonic(mnemonic, {
      enabled: () => latestEnabled.current,
      press: () => latestPress.current(),
    });
  }, [keys, mnemonic, latestEnabled, latestPress]);
}
