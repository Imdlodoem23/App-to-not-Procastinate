/**
 * Per-window services shared by the shell and the sections, created once in `main.tsx`
 * (pure: no DOM or React; `services.tsx` adds the React context and hooks):
 * - the key map (`KeyRegistry`, with the Esc cascade, chords, bindings and mnemonics);
 * - named focus targets («¿Qué quieres hacer?», the card's confirm button…), so main's
 *   `focusField` and `ui:command` can focus what a section owns;
 * - the layout measurer of the main window (`useAutoLayout`), which `ui:prepare-show` calls
 *   synchronously while the window is still hidden.
 */
import type { LayoutReport } from '../../../shared/ui-state';
import type { KeyRegistry } from '../hooks/keys';

/** Focus targets a section can register (BLOQUEO: `field`, `confirm`, `extend`). */
export type FocusTargetName = 'field' | 'confirm' | 'extend';

export interface WindowServices {
  readonly keys: KeyRegistry;
  /** Register a focus target; the function returns whether it took focus. */
  registerFocus(name: FocusTargetName, focus: () => boolean): () => void;
  /** Focus a registered target (the latest registered first); `false` when none took it. */
  focus(name: FocusTargetName): boolean;
  /**
   * «¿Qué quieres hacer?» (show, Ctrl+N, `/`, `ui:command focus-field`); when a block hides
   * the field, the fallback (the Bloqueo section root) instead.
   */
  focusField(): void;
  setMeasurer(measure: (() => LayoutReport) | null): void;
  /** Main window: measure and report now (synchronous); `null` elsewhere. */
  measure(): LayoutReport | null;
}

export function createWindowServices(
  keys: KeyRegistry,
  /** What `focusField` focuses when no `field` target takes it. */
  fallbackFocus: () => void = () => undefined,
): WindowServices {
  const targets = new Map<FocusTargetName, (() => boolean)[]>();
  let measurer: (() => LayoutReport) | null = null;

  const focus = (name: FocusTargetName): boolean => {
    const list = targets.get(name) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.()) return true;
    }
    return false;
  };

  return {
    keys,
    registerFocus(name, fn) {
      targets.set(name, [...(targets.get(name) ?? []), fn]);
      return () => {
        targets.set(
          name,
          (targets.get(name) ?? []).filter((f) => f !== fn),
        );
      };
    },
    focus,
    focusField() {
      if (!focus('field')) fallbackFocus();
    },
    setMeasurer(fn) {
      measurer = fn;
    },
    measure() {
      return measurer ? measurer() : null;
    },
  };
}
