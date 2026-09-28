/**
 * `BrowserWindow`s of the Phase 5 surfaces (docs/DESKTOP.md §15): the mini timer, the OSD and
 * the Nuclear overlay. Same locked-down `webPreferences` and the same renderer bundle as the
 * main and detail windows (`index.html?window=mini-timer|osd|nuclear`, plus `&state=` in the
 * harness), frameless, off the taskbar, never resizable. The shell registers each one so its
 * IPC is trusted (`WindowShell.registerSurface`).
 */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import type { Platform, SurfaceKind } from '../../shared/ui-state';
import { rendererUrl, type RendererSource } from '../windows/window-urls';

export interface SurfaceFactoryOptions {
  platform: Platform;
  packaged: boolean;
  preload: string;
  renderer: RendererSource;
  harnessStateId: string | null;
  /** Makes the window's renderer trusted (shell registry). */
  register(win: BrowserWindow, kind: SurfaceKind): void;
}

export type SurfaceWindowFactory = (
  kind: SurfaceKind,
  extra: BrowserWindowConstructorOptions,
) => BrowserWindow;

export function surfaceQuery(
  kind: SurfaceKind,
  harnessStateId: string | null,
): Record<string, string> {
  return harnessStateId ? { window: kind, state: harnessStateId } : { window: kind };
}

export function createSurfaceFactory(options: SurfaceFactoryOptions): SurfaceWindowFactory {
  return (kind, extra) => {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      hasShadow: false,
      paintWhenInitiallyHidden: true,
      title: '',
      ...extra,
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
    });
    if (options.platform !== 'darwin') win.setMenu(null);
    win.on('page-title-updated', (event) => event.preventDefault());
    options.register(win, kind);
    const query = surfaceQuery(kind, options.harnessStateId);
    const load =
      options.renderer.kind === 'dev'
        ? win.loadURL(rendererUrl(options.renderer, query))
        : win.loadFile(options.renderer.path, { query });
    void load.catch(() => undefined);
    return win;
  };
}
