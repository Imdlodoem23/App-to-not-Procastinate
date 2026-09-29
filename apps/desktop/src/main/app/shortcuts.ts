/**
 * Electron's `globalShortcut` behind a small registry (Ajustes › General «Atajo global»). The
 * shortcuts controller (`src/main/shortcuts/`) decides what to register from the prefs; this
 * module only registers, and reports the accelerators the OS refused (taken by another app).
 */
import { globalShortcut } from 'electron';
import type { AppLog } from './log';

export interface ShortcutBinding {
  /** Electron accelerator, e.g. `CommandOrControl+Alt+C`. */
  accelerator: string;
  action: () => void;
}

export interface ShortcutRegistry {
  /** Replace every binding; returns the accelerators the OS refused (taken by another app). */
  apply(bindings: readonly ShortcutBinding[]): string[];
  clear(): void;
}

export function createShortcutRegistry(log: AppLog): ShortcutRegistry {
  let active: string[] = [];
  const clear = (): void => {
    for (const accelerator of active) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // already gone
      }
    }
    active = [];
  };
  return {
    apply(bindings) {
      clear();
      const refused: string[] = [];
      for (const binding of bindings) {
        if (tryRegister(binding)) active.push(binding.accelerator);
        else refused.push(binding.accelerator);
      }
      if (refused.length > 0) log.warn('refused', { count: refused.length });
      return refused;
    },
    clear,
  };
}

/** A registry that registers nothing (harness runs: the test machine's shortcuts stay free). */
export function createNullShortcutRegistry(): ShortcutRegistry {
  return { apply: () => [], clear: () => undefined };
}

function tryRegister(binding: ShortcutBinding): boolean {
  try {
    // `register` also answers false when another app holds it.
    return globalShortcut.register(binding.accelerator, binding.action);
  } catch {
    return false;
  }
}
