/**
 * The OSD window (PROMPT §10 «Aviso grande», G-Helper's `ToastForm`): frameless, transparent,
 * never focusable and click-through (`focusable: false`, `setIgnoreMouseEvents(true)`), above
 * everything, centred 300 DIP above the bottom of the display the pointer is on. It shows
 * `snapshot.osd`; the platform services clear that after 2 s.
 */
import type { BrowserWindow } from 'electron';
import type { OsdMessage } from '../../shared/platform';
import type { SurfaceWindowFactory } from '../platform/surface-window';
import type { DisplaySource } from './display-source';
import { OSD_WINDOW_SIZE, osdBounds, osdDisplay } from './osd-geometry';

export interface OsdWindowOptions {
  create: SurfaceWindowFactory;
  displays: DisplaySource;
  onVisibility(win: BrowserWindow, visible: boolean): void;
}

export class OsdWindow {
  private win: BrowserWindow | null = null;
  private shownId: number | null = null;

  constructor(private readonly options: OsdWindowOptions) {}

  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  sync(message: OsdMessage | null): void {
    if (message === null) {
      this.shownId = null;
      const win = this.window();
      if (win?.isVisible()) {
        win.hide();
        this.options.onVisibility(win, false);
      }
      return;
    }
    if (message.id === this.shownId && this.window()?.isVisible()) return;
    this.shownId = message.id;
    const win = this.window() ?? this.create();
    const displays = this.options.displays.all();
    if (displays.length > 0) {
      const display = osdDisplay(displays, this.options.displays.cursor());
      win.setBounds(osdBounds(display.workArea), false);
    }
    if (!win.isVisible()) {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      this.options.onVisibility(win, true);
    }
  }

  private create(): BrowserWindow {
    const win = this.options.create('osd', {
      width: OSD_WINDOW_SIZE.width,
      height: OSD_WINDOW_SIZE.height,
      transparent: true,
      focusable: false,
      alwaysOnTop: true,
      movable: false,
      closable: false,
      // Linux: a notification-type window is never given focus or decorations.
      ...(process.platform === 'linux' ? { type: 'notification' } : {}),
    });
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.webContents.reload();
    });
    this.win = win;
    return win;
  }

  destroy(): void {
    const win = this.window();
    this.win = null;
    win?.destroy();
  }
}
