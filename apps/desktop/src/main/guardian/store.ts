/**
 * The main-owned `UiSnapshot` store. Every change goes through `update`, which bumps `rev`
 * only when the updater returned a different object; listeners run once per microtask
 * burst with the latest snapshot (docs/DESKTOP.md §4.3: one push per real change, never on a
 * 304).
 *
 * Pure module: no Electron or Node imports.
 */
import type { UiSnapshot } from '../../shared/ui-state';

export interface SnapshotStore {
  get(): UiSnapshot;
  /** `fn` returns the next snapshot (without touching `rev`) or the same object for «no change». */
  update(fn: (current: UiSnapshot) => UiSnapshot): UiSnapshot;
  /** Replace everything (harness load); `rev` still increases. */
  replace(next: UiSnapshot): void;
  subscribe(listener: (snapshot: UiSnapshot) => void): () => void;
}

export function createSnapshotStore(initial: UiSnapshot): SnapshotStore {
  let current = initial;
  let scheduled = false;
  const listeners = new Set<(snapshot: UiSnapshot) => void>();

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const snapshot = current;
      for (const listener of [...listeners]) {
        try {
          listener(snapshot);
        } catch {
          // A listener bug must never break publishing to the others.
        }
      }
    });
  }

  return {
    get: () => current,
    update(fn) {
      const next = fn(current);
      if (next === current) return current;
      current = { ...next, rev: current.rev + 1 };
      schedule();
      return current;
    },
    replace(next) {
      current = { ...next, rev: Math.max(current.rev + 1, next.rev) };
      schedule();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
