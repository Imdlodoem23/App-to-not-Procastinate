/**
 * React access to the window's store (one per window, created in `main.tsx` from `app:init`).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { CentrateBridge } from '../../../shared/ipc';
import type { ArmedState, HelpFocus, UiSnapshot, UiWindow } from '../../../shared/ui-state';
import type { AppStore } from './store';

const StoreContext = createContext<StoreApi<AppStore> | null>(null);

export function StoreProvider(props: {
  store: StoreApi<AppStore>;
  children: ReactNode;
}): React.JSX.Element {
  return <StoreContext.Provider value={props.store}>{props.children}</StoreContext.Provider>;
}

export function useAppStoreApi(): StoreApi<AppStore> {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStoreApi outside <StoreProvider>');
  return store;
}

/** Subscribe to a slice. The selector must return a stable reference (see store.ts). */
export function useAppStore<T>(selector: (s: AppStore) => T): T {
  return useStore(useAppStoreApi(), selector);
}

export function useBridge(): CentrateBridge {
  return useAppStore((s) => s.bridge);
}

export function useSnapshot(): UiSnapshot {
  return useAppStore((s) => s.snapshot);
}

export function useWindowKind(): UiWindow {
  return useAppStore((s) => s.env.window);
}

/** Whether this window is visible: timers run only then. */
export function useVisible(): boolean {
  return useAppStore((s) => s.env.visible);
}

/** This window's help focus (`main.help` or `detail.help`). */
export function useHelpFocus(): HelpFocus | null {
  return useAppStore((s) => (s.env.window === 'main' ? s.main.help : s.detail.help));
}

/** This window's armed «¿Seguro?» (`main.armed` or `detail.armed`). */
export function useArmedState(): ArmedState | null {
  return useAppStore((s) => (s.env.window === 'main' ? s.main.armed : s.detail.armed));
}
