/**
 * The mini timer window (PROMPT §5, §10): 180×44 DIP, frameless, always on top, off the taskbar,
 * dragged by its body (`-webkit-app-region: drag` in the renderer) and remembered where the user
 * leaves it (`prefs.miniTimer.position`, persisted by the platform services). Created the first
 * time it shows, then only shown and hidden; it never steals focus when it appears.
 */
import type { BrowserWindow } from 'electron';
import { MINI_TIMER_SIZE } from '../../shared/prefs';
import type { SurfaceWindowFactory } from '../platform/surface-window';
import type { DisplaySource } from './display-source';
import type { Point, Rect } from './geometry';
import { miniTimerBounds } from './mini-timer-geometry';

/** Linux reports drags as a stream of `move` events: persist once they stop. */
const MOVE_SETTLE_MS = 400;

export interface MiniTimerWindowOptions {
  create: SurfaceWindowFactory;
  displays: DisplaySource;
  linux: boolean;
  /** The user dropped it at `position` (content top-left, DIP). */
  onMoved(position: Point): void;
  /** Shown or hidden (the platform pushes `ui:visibility`). */
  onVisibility(win: BrowserWindow, visible: boolean): void;
  /** The app is quitting (or the OS session ends): the window may close. */
  isQuitting(): boolean;
}

export class MiniTimerWindow {
  private win: BrowserWindow | null = null;
  private placing = false;
  private quitting = false;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private lastRect: Rect | null = null;

  constructor(private readonly options: MiniTimerWindowOptions) {}

  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Shows it at `position` (`null`: the default corner) or hides it. */
  sync(visible: boolean, position: Point | null): void {
    if (!visible) {
      const win = this.window();
      if (win?.isVisible()) {
        win.hide();
        this.options.onVisibility(win, false);
      }
      return;
    }
    const win = this.window() ?? this.create();
    const displays = this.options.displays.all();
    const primary = displays[0];
    if (primary) {
      const rect = miniTimerBounds(position, displays, primary);
      if (!this.lastRect || !sameRect(rect, this.lastRect)) this.place(win, rect);
    }
    if (!win.isVisible()) {
      win.showInactive();
      win.setAlwaysOnTop(true, 'floating');
      this.options.onVisibility(win, true);
    }
  }

  private place(win: BrowserWindow, rect: Rect): void {
    this.placing = true;
    try {
      win.setContentBounds(rect, false);
    } finally {
      this.placing = false;
    }
    this.lastRect = rect;
  }

  private create(): BrowserWindow {
    const win = this.options.create('mini-timer', {
      width: MINI_TIMER_SIZE.width,
      height: MINI_TIMER_SIZE.height,
      useContentSize: true,
      transparent: true,
      alwaysOnTop: true,
      movable: true,
      focusable: true,
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const report = (): void => {
      if (this.placing || win.isDestroyed()) return;
      const b = win.getContentBounds();
      if (this.lastRect && b.x === this.lastRect.x && b.y === this.lastRect.y) return;
      this.lastRect = { ...b, width: MINI_TIMER_SIZE.width, height: MINI_TIMER_SIZE.height };
      this.options.onMoved({ x: Math.round(b.x), y: Math.round(b.y) });
    };
    if (this.options.linux) {
      win.on('move', () => {
        if (this.placing) return;
        if (this.settle) clearTimeout(this.settle);
        this.settle = setTimeout(() => {
          this.settle = null;
          report();
        }, MOVE_SETTLE_MS);
      });
    } else {
      win.on('moved', report);
    }
    // Only «Salir» closes it; anything else hides it.
    win.on('close', (event) => {
      if (this.quitting || this.options.isQuitting()) return;
      event.preventDefault();
      win.hide();
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.lastRect = null;
      }
    });
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.webContents.reload();
    });
    this.win = win;
    this.lastRect = null;
    return win;
  }

  destroy(): void {
    this.quitting = true;
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    const win = this.window();
    this.win = null;
    win?.destroy();
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
