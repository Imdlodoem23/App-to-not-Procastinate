/**
 * Global shortcut hook. Phase 1 registers nothing: Ajustes › General «Atajo global» and the
 * OSD come later. The registry is wired in the bootstrap so that feature only adds bindings.
 */
import { globalShortcut } from 'electron';
import type { AppLog } from './log';

export interface ShortcutBinding {
  /** Electron accelerator, e.g. `CommandOrControl+Shift+Space`. */
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
    for (const accelerator of active) globalShortcut.unregister(accelerator);
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

function tryRegister(binding: ShortcutBinding): boolean {
  try {
    return globalShortcut.register(binding.accelerator, binding.action);
  } catch {
    return false;
  }
}
