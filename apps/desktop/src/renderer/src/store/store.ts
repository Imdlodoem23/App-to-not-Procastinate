/**
 * One Zustand store per window (docs/DESKTOP.md §7.1). It holds the `UiState` the window draws:
 * the main-owned snapshot (replaced whole on every push, never edited here) plus this window's
 * renderer-local state. Feature actions (submit the card, extend, emergency steps…) live in the
 * owning section as hooks that call `bridge.invoke` and `updateMain` / `updateDetail`, so
 * nobody edits this file for a feature.
 *
 * Zustand 5 + React 19: selectors must return stable references. Select slices
 * (`s => s.snapshot`, `s => s.main.card`), use `useShallow` for objects you build, derive view
 * models in `useMemo`, never build arrays or objects inside a selector.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CentrateBridge, HarnessLoad } from '../../../shared/ipc';
import type {
  ArmedState,
  DetailLocalState,
  HelpFocus,
  LayoutReport,
  MainLocalState,
  RenderEnv,
  UiSnapshot,
  UiState,
} from '../../../shared/ui-state';
import { applyHarnessLoad, applySnapshotTo } from './reducers';

export interface AppStore extends UiState {
  bridge: CentrateBridge;
  /** Last measured layout of this window (main window only). */
  layout: LayoutReport | null;
  /** Harness state loaded into the local parts (`null` outside the harness). */
  harnessStateId: string | null;
  /** Increases on every harness load (readiness is reported once per load). */
  harnessSeq: number;
  /**
   * Increases whenever time must be read again at once (show, `ui:prepare-show`): every
   * `useNow` and `Countdown` re-renders with a fresh clock even if their timers were stopped.
   */
  clockEpoch: number;

  /** Ignores `rev` ≤ current; applies `reconcileMainLocal` in the same `set()`. */
  applySnapshot(snapshot: UiSnapshot): void;
  updateMain(fn: (main: MainLocalState) => MainLocalState): void;
  updateDetail(fn: (detail: DetailLocalState) => DetailLocalState): void;
  setEnv(patch: Partial<RenderEnv>): void;
  /** Harness: replace both local parts (`ui:harness`). */
  loadHarness(load: HarnessLoad): void;
  setLayout(report: LayoutReport): void;
  touchClock(): void;
  /** Help line focus of this window (`main.help` or `detail.help`). */
  setHelp(help: HelpFocus | null): void;
  /** Armed «¿Seguro?» of this window (`main.armed` or `detail.armed`). */
  setArmed(armed: ArmedState | null): void;
}

export function createAppStore(
  bridge: CentrateBridge,
  init: UiState,
  harness: HarnessLoad | null = null,
): StoreApi<AppStore> {
  return createStore<AppStore>()((set, get) => ({
    ...init,
    bridge,
    layout: null,
    harnessStateId: harness?.stateId ?? null,
    harnessSeq: harness ? 1 : 0,
    clockEpoch: 0,

    applySnapshot(snapshot) {
      const next = applySnapshotTo(get(), snapshot);
      if (next) set(next);
    },

    updateMain(fn) {
      const current = get().main;
      const next = fn(current);
      if (next !== current) set({ main: next });
    },

    updateDetail(fn) {
      const current = get().detail;
      const next = fn(current);
      if (next !== current) set({ detail: next });
    },

    setEnv(patch) {
      const env = get().env;
      const changed = (Object.keys(patch) as (keyof RenderEnv)[]).some(
        (key) => patch[key] !== env[key],
      );
      if (changed) set({ env: { ...env, ...patch } });
    },

    loadHarness(load) {
      set((s) => ({
        ...applyHarnessLoad(load),
        harnessStateId: load.stateId,
        harnessSeq: s.harnessSeq + 1,
      }));
    },

    setLayout(report) {
      const current = get().layout;
      if (
        current &&
        current.height === report.height &&
        current.density === report.density &&
        current.scroll === report.scroll
      ) {
        return;
      }
      set({ layout: report });
    },

    touchClock() {
      set((s) => ({ clockEpoch: s.clockEpoch + 1 }));
    },

    setHelp(help) {
      const s = get();
      const current = s.env.window === 'main' ? s.main.help : s.detail.help;
      if (sameHelp(current, help)) return;
      if (s.env.window === 'main') set({ main: { ...s.main, help } });
      else set({ detail: { ...s.detail, help } });
    },

    setArmed(armed) {
      const s = get();
      const current = s.env.window === 'main' ? s.main.armed : s.detail.armed;
      if (
        current === armed ||
        (current && armed && current.id === armed.id && current.at === armed.at)
      )
        return;
      if (s.env.window === 'main') set({ main: { ...s.main, armed } });
      else set({ detail: { ...s.detail, armed } });
    },
  }));
}

function sameHelp(a: HelpFocus | null, b: HelpFocus | null): boolean {
  return a === b || (a !== null && b !== null && a.row === b.row && a.item === b.item);
}
