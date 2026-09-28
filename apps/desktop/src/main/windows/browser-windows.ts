/**
 * The two long-lived `BrowserWindow`s (docs/DESKTOP.md §8.2, §8.5). Both are created
 * hidden, painted while hidden and only ever shown or hidden afterwards; both load the one
 * renderer bundle (`?window=main|detail`) with the same locked-down `webPreferences`.
 */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import type { Platform, WindowKind } from '../../shared/ui-state';
import {
  DETAIL_CONTENT_WIDTH,
  DETAIL_MIN_CONTENT_HEIGHT,
  MAIN_CONTENT_WIDTH,
  MAIN_DEFAULT_CONTENT_HEIGHT,
} from './geometry';
import { WINDOWS } from './i18n';
import { rendererQuery, rendererUrl, type RendererSource } from './window-urls';

export interface WindowFactoryOptions {
  platform: Platform;
  packaged: boolean;
  preload: string;
  renderer: RendererSource;
  backgroundColor: string;
  /** Harness state for `?state=` (the browser harness reads it; Electron uses `app:init`). */
  harnessStateId: string | null;
  /** Harness only: `?neutral-service-icons=1` (services draw monograms, never favicons). */
  neutralServiceIcons: boolean;
}

function baseOptions(options: WindowFactoryOptions): BrowserWindowConstructorOptions {
  return {
    useContentSize: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: WINDOWS.appName,
    paintWhenInitiallyHidden: true,
    backgroundColor: options.backgroundColor,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !options.packaged,
    },
  };
}

export function createShellWindow(kind: WindowKind, options: WindowFactoryOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...baseOptions(options),
    ...(kind === 'main'
      ? { width: MAIN_CONTENT_WIDTH, height: MAIN_DEFAULT_CONTENT_HEIGHT }
      : {
          width: DETAIL_CONTENT_WIDTH,
          height: DETAIL_MIN_CONTENT_HEIGHT,
          // No `parent`: a parent means WM placement on Linux and sheet behaviour on macOS.
          skipTaskbar: true,
        }),
  });
  if (options.platform !== 'darwin') win.setMenu(null);
  // Main owns the title (it says the state).
  win.on('page-title-updated', (event) => event.preventDefault());
  if (!options.packaged) installDevToolsKeys(win);
  void loadRenderer(win, kind, options);
  return win;
}

export function loadRenderer(
  win: BrowserWindow,
  kind: WindowKind,
  options: Pick<WindowFactoryOptions, 'renderer' | 'harnessStateId' | 'neutralServiceIcons'>,
): Promise<void> {
  const query = rendererQuery(kind, options.harnessStateId, options.neutralServiceIcons);
  return options.renderer.kind === 'dev'
    ? win.loadURL(rendererUrl(options.renderer, query))
    : win.loadFile(options.renderer.path, { query });
}

/** F12 / Ctrl+Shift+I open DevTools in unpackaged runs (there is no menu to carry them). */
function installDevToolsKeys(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const combo =
      input.key === 'F12' ||
      ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');
    if (combo) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });
}
