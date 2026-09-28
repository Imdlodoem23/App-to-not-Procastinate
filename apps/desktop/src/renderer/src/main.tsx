/**
 * Renderer entry (docs/DESKTOP.md §7.2), one bundle for every window:
 *
 * 1. Read `?window=main|detail` (the browser harness also takes `bloqueos|emergencia|ajustes`)
 *    and `?state=<id>`.
 * 2. The bridge: `window.centrate` from the preload; in the browser harness (dev only, no
 *    preload) an in-memory bridge that serves the `?state=` fixture. Production builds drop it.
 * 3. Subscribe to every push (buffered), then `await app:init`.
 * 4. Activate the snapshot's language (`prefs.language`, «Sistema» = the OS language), then
 *    create the store (applying `init.harness`), the key map and the window services.
 * 5. Render `<StrictMode><ErrorBoundary>…`; the shell sends `window:ready` after its first
 *    layout effect (and sets `<html data-harness-ready>` in the harness).
 *
 * `window.onerror` and `unhandledrejection` go to main's log (`app:renderer-error`).
 */
import { createRoot } from 'react-dom/client';
import './index.css';
import type { CentrateBridge } from '../../shared/ipc';
import { FatalMessage } from './app/ErrorBoundary';
import { installErrorReporting, reportError } from './app/errors';
import { bufferPushes, createPushHandlers } from './app/push';
import { Root } from './app/Root';
import { parseRoute, type RendererRoute } from './app/route';
import { createWindowServices, focusSectionRoot, type WindowServices } from './app/services';
import { KeyRegistry } from './hooks/keys';
import { activeLocale, setActiveLocale } from '../../shared/i18n/locale';
import { snapshotLocale } from '../../shared/ui-state';
import { RENDERER } from './i18n/messages';
import { initialUiState } from './store/reducers';
import { createAppStore } from './store/store';

async function resolveBridge(route: RendererRoute): Promise<CentrateBridge | null> {
  if (window.centrate) return window.centrate;
  if (import.meta.env.DEV) {
    const { createMemoryBridge } = await import('./app/memory-bridge');
    document.documentElement.dataset['browserHarness'] = '';
    return createMemoryBridge(route);
  }
  return null;
}

/** Built-in keys: Ctrl+N / Cmd+N (also while typing) and `/` focus «¿Qué quieres hacer?». */
function registerShellKeys(services: WindowServices): void {
  const focusField = (): boolean => {
    services.focusField();
    return true;
  };
  services.keys.registerBinding({
    combo: { key: 'n', primary: true },
    allowInText: true,
    run: focusField,
  });
  services.keys.registerBinding({ combo: { key: '/', shift: 'any' }, run: focusField });
}

async function boot(container: HTMLElement): Promise<void> {
  const route = parseRoute(window.location.search);
  const html = document.documentElement;
  html.dataset['window'] = route.window;

  const bridge = await resolveBridge(route);
  if (!bridge) {
    createRoot(container).render(<FatalMessage title={RENDERER.shell.noBridge} />);
    return;
  }
  installErrorReporting(bridge);
  const pushes = bufferPushes(bridge);

  const init = await bridge.invoke('app:init', null);
  html.dataset['window'] = init.window;
  html.dataset['platform'] = init.platform;
  html.dataset['theme'] = init.snapshot.prefs.theme;
  setActiveLocale(snapshotLocale(init.snapshot));
  html.lang = activeLocale();

  const store = createAppStore(bridge, initialUiState(init), init.harness);
  const keys = new KeyRegistry(init.platform, () => {
    if (store.getState().env.window === 'main') bridge.send('window:hide', null);
    else bridge.send('window:close-detail', null);
  });
  const services = createWindowServices(keys, focusSectionRoot);
  if (init.window === 'main') registerShellKeys(services);
  pushes.attach(createPushHandlers(store, services));

  const replacement =
    import.meta.env.DEV && route.kit ? (await import('./app/KitGallery')).KitGallery : null;
  createRoot(container).render(
    <Root store={store} services={services} replacement={replacement} />,
  );
}

const container = document.getElementById('root');
if (container) {
  boot(container).catch((error: unknown) => {
    reportError(window.centrate ?? null, error);
    createRoot(container).render(
      <FatalMessage title={RENDERER.shell.crashed} help={RENDERER.shell.crashedHelp} />,
    );
  });
}
