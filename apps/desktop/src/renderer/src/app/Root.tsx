/**
 * Root of a window: store and services providers, the error boundary, the window key listener,
 * the theme on `<html>` (`data-theme="system|light|dark"`, which tokens.css understands; main
 * also sets `nativeTheme.themeSource`, so the native title bar and `prefers-color-scheme`
 * agree), and the main or detail shell.
 */
import { StrictMode, useLayoutEffect, type ComponentType } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { useKeyListener } from '../hooks/useKeys';
import { StoreProvider, useAppStore } from '../store/context';
import type { AppStore } from '../store/store';
import { DetailWindow } from './DetailWindow';
import { ErrorBoundary } from './ErrorBoundary';
import { MainWindow } from './MainWindow';
import { ServicesProvider, useServices, type WindowServices } from './services';

function WindowChrome(): null {
  const services = useServices();
  const theme = useAppStore((s) => s.snapshot.prefs.theme);
  useKeyListener(services.keys);
  useLayoutEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  return null;
}

export function Root(props: {
  store: StoreApi<AppStore>;
  services: WindowServices;
  /** Dev only: render this instead of the window shell (the kit gallery). */
  replacement?: ComponentType | null;
}): React.JSX.Element {
  const { store, services, replacement: Replacement } = props;
  const kind = store.getState().env.window;
  return (
    <StrictMode>
      <ErrorBoundary bridge={store.getState().bridge}>
        <StoreProvider store={store}>
          <ServicesProvider services={services}>
            <WindowChrome />
            {Replacement ? <Replacement /> : kind === 'main' ? <MainWindow /> : <DetailWindow />}
          </ServicesProvider>
        </StoreProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
