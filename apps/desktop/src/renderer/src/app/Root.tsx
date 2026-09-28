/**
 * Root of a window: store and services providers, the error boundary, the window key listener,
 * the language (`<html lang>`, a remount when it changes),
 * the theme on `<html>` (`data-theme="system|light|dark"`, which tokens.css understands; main
 * also sets `nativeTheme.themeSource`, so the native title bar and `prefers-color-scheme`
 * agree), and the main or detail shell.
 */
import { Fragment, StrictMode, useLayoutEffect, type ComponentType, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { useKeyListener } from '../hooks/useKeys';
import { StoreProvider, useAppStore } from '../store/context';
import type { AppStore } from '../store/store';
import { snapshotLocale } from '../../../shared/ui-state';
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

/**
 * The window in the snapshot's language. The store switches the active locale before it
 * publishes a snapshot; a language change remounts the window (keyed by locale), so no
 * memoized value keeps the old copy. Store state (drafts, cards, detail requests) survives.
 */
function Localized(props: { children: ReactNode }): React.JSX.Element {
  const locale = useAppStore((s) => snapshotLocale(s.snapshot));
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <Fragment key={locale}>{props.children}</Fragment>;
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
            <Localized>
              {Replacement ? <Replacement /> : kind === 'main' ? <MainWindow /> : <DetailWindow />}
            </Localized>
          </ServicesProvider>
        </StoreProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
