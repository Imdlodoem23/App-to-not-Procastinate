/**
 * The Nuclear overlay (PROMPT §10 «Nuclear», ARCHITECTURE §10.5): during a level-3 punishment,
 * one window per display covers it completely (theme background, 72 px countdown, «Castigo ·
 * vuelves a las 18:40» and a single «Salida de emergencia»). It cannot be closed, minimised or
 * moved while Nuclear lasts: a close is refused, a crashed renderer is reloaded, a new display
 * gets its own window. The only way out is the emergency unlock (the Emergencia window opens
 * above it). It is focusable and, when it appears, the overlay on the display under the pointer
 * takes the focus, so Tab reaches «Salida de emergencia» and a screen reader lands on the
 * countdown (WCAG 2.1.1; Nuclear takes over the computer anyway). When Nuclear ends its
 * windows are destroyed (a hidden renderer per display would stay alive for nothing). Its
 * status (`shown`, displays covered) goes to `snapshot.nuclear`, which drives the guardian
 * heartbeat.
 *
 * Some ways off the screen emit no `hide`: a Linux window manager minimises it (Electron does
 * not implement `minimizable: false` there), macOS «Hide» (Cmd+H) hides the whole app. So a
 * `minimize` is undone at once and, while Nuclear lasts, a 1 s watchdog re-shows any window
 * that is minimised or not visible (and the app when macOS hid it) and republishes the status
 * from the live windows: an overlay that could not be put back reads `hidden`, the heartbeat
 * stops and the guardian relaunches the app as designed.
 *
 * Windows has one more way off the screen: switching virtual desktop (Ctrl+Win+D, Ctrl+Win+
 * Left/Right). `setVisibleOnAllWorkspaces` does nothing there, so the overlay stays on the old
 * desktop, DWM-cloaked, while `isVisible()` still says `true`. The `cloaked` probe
 * (`nuclear-cloak.ts`) catches it: a cloaked window is not live, and the watchdog destroys it
 * and makes a new one, which Windows puts on the current desktop.
 *
 * When the guardian relaunches the app while it still runs (heartbeats stopped), `relaunch()`
 * makes every overlay window again, shows the app (macOS) and gives the focus back.
 *
 * Wayland compositors may still draw some surfaces above it (documented limit).
 */
import type { BrowserWindow } from 'electron';
import type { NuclearStatus } from '../../shared/platform';
import type { SurfaceWindowFactory } from '../platform/surface-window';
import type { DisplaySource } from './display-source';
import type { Rect } from './geometry';
import { overlayFocusDisplay, overlayPlacements } from './nuclear-geometry';

export interface NuclearOverlayOptions {
  create: SurfaceWindowFactory;
  displays: DisplaySource;
  backgroundColor(): string;
  onVisibility(win: BrowserWindow, visible: boolean): void;
  /** The overlay's status changed (shown / hidden / displays). */
  onStatus(status: Pick<NuclearStatus, 'overlay' | 'displays'>): void;
  log(event: string, fields: Record<string, string | number | boolean | null>): void;
  /** The app is quitting (or the OS session ends): windows may close. */
  isQuitting(): boolean;
  /** Another window must keep the focus (Emergencia above the overlay). */
  keepFocus?(): boolean;
  /** macOS: the whole app is hidden (`app.isHidden()`); `false` elsewhere. */
  appHidden?(): boolean;
  /** macOS: show the hidden app again (`app.show()`). */
  showApp?(): void;
  /**
   * Windows: the window is DWM-cloaked (left on another virtual desktop); `false` elsewhere.
   * A cloaked overlay is not live and is made again on the current desktop.
   */
  cloaked?(win: BrowserWindow): boolean;
  /** Watchdog period (tests). */
  watchdogMs?: number;
}

/** How often the overlay checks, while Nuclear lasts, that every window is still up. */
export const NUCLEAR_WATCHDOG_MS = 1_000;

export class NuclearOverlay {
  /** One window per display id. */
  private readonly windows = new Map<number, BrowserWindow>();
  private active = false;
  private quitting = false;
  private lastStatus = '';
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: NuclearOverlayOptions) {
    options.displays.onChanged(() => {
      if (this.active) this.reconcile();
    });
  }

  all(): BrowserWindow[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed());
  }

  isActive(): boolean {
    return this.active;
  }

  /** `true` while the guardian says `nuclearActive`. */
  sync(active: boolean): void {
    if (active === this.active) {
      if (active) this.reconcile();
      return;
    }
    this.active = active;
    if (active) {
      this.options.log('nuclear_overlay', { shown: true });
      this.reconcile();
      this.startWatchdog();
    } else {
      this.options.log('nuclear_overlay', { shown: false });
      this.stopWatchdog();
      const windows = this.all();
      this.windows.clear();
      for (const win of windows) this.destroyWindow(win);
      this.publish();
    }
  }

  /** The background follows the theme. */
  setBackground(color: string): void {
    for (const win of this.all()) win.setBackgroundColor(color);
  }

  private reconcile(): void {
    const placements = overlayPlacements(this.options.displays.all());
    const wanted = new Set(placements.map((p) => p.displayId));
    for (const [id, win] of this.windows) {
      if (!wanted.has(id)) {
        this.windows.delete(id);
        this.destroyWindow(win);
      }
    }
    let appeared = false;
    for (const p of placements) {
      let win = this.windows.get(p.displayId);
      if (!win || win.isDestroyed()) {
        win = this.create(p.displayId, p.bounds);
        this.windows.set(p.displayId, win);
      }
      const b = win.getBounds();
      if (
        b.x !== p.bounds.x ||
        b.y !== p.bounds.y ||
        b.width !== p.bounds.width ||
        b.height !== p.bounds.height
      ) {
        win.setBounds(p.bounds, false);
      }
      if (!win.isVisible()) {
        win.showInactive();
        win.setAlwaysOnTop(true, 'screen-saver');
        this.options.onVisibility(win, true);
        appeared = true;
      }
    }
    if (appeared) this.focusUnderPointer();
    this.publish();
  }

  /**
   * Keyboard and screen reader users start on the overlay they are looking at: the one on the
   * display under the pointer (else the first). Only when an overlay appeared, never while the
   * Emergencia window above it has the focus.
   */
  private focusUnderPointer(): void {
    if (this.options.keepFocus?.() === true) return;
    const { displays } = this.options;
    const id = overlayFocusDisplay(displays.all(), displays.cursor());
    const win = id === null ? undefined : this.windows.get(id);
    if (!win || win.isDestroyed()) return;
    win.focus();
  }

  /**
   * Overlay windows really on screen: visible, not minimised, not cloaked (Windows, another
   * virtual desktop), the app not hidden (macOS).
   */
  liveCount(): number {
    if (!this.active || this.options.appHidden?.() === true) return 0;
    return this.all().filter((w) => w.isVisible() && !w.isMinimized() && !this.isCloaked(w)).length;
  }

  /**
   * The guardian relaunched the app while it still runs: the overlay was not live for it.
   * Every window is made again (a new one lands on the current virtual desktop and on top),
   * the app shows (macOS) and the overlay under the pointer takes the focus.
   */
  relaunch(): void {
    if (!this.active || this.closing()) return;
    this.options.showApp?.();
    const windows = this.all();
    this.windows.clear();
    for (const win of windows) this.destroyWindow(win);
    this.reconcile();
  }

  private isCloaked(win: BrowserWindow): boolean {
    return this.options.cloaked?.(win) === true;
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    const timer = setInterval(() => this.check(), this.options.watchdogMs ?? NUCLEAR_WATCHDOG_MS);
    timer.unref?.();
    this.watchdog = timer;
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Puts back whatever took the overlay off the screen without a `hide` event. */
  private check(): void {
    if (!this.active || this.closing()) return;
    if (this.options.appHidden?.() === true) {
      this.options.log('nuclear_overlay_restored', { reason: 'app_hidden' });
      this.options.showApp?.();
    }
    let cloaked = false;
    for (const [id, win] of this.windows) {
      if (win.isDestroyed() || !this.isCloaked(win)) continue;
      // Left on another virtual desktop (Windows): a new window appears on the current one.
      this.options.log('nuclear_overlay_restored', { reason: 'cloaked' });
      this.windows.delete(id);
      this.destroyWindow(win);
      cloaked = true;
    }
    if (cloaked) this.reconcile();
    for (const win of this.all()) {
      if (win.isMinimized() || !win.isVisible()) {
        this.options.log('nuclear_overlay_restored', {
          reason: win.isMinimized() ? 'minimized' : 'hidden',
        });
        this.restore(win);
      }
    }
    this.publish();
  }

  private restore(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  private publish(): void {
    const shown = this.liveCount();
    const status: Pick<NuclearStatus, 'overlay' | 'displays'> = {
      overlay: this.active && shown > 0 ? 'shown' : 'hidden',
      displays: this.active ? shown : 0,
    };
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.options.onStatus(status);
  }

  private create(displayId: number, bounds: Rect): BrowserWindow {
    const win = this.options.create('nuclear', {
      ...bounds,
      backgroundColor: this.options.backgroundColor(),
      alwaysOnTop: true,
      movable: false,
      closable: false,
      // Focusable: the keyboard must reach «Salida de emergencia» (WCAG 2.1.1).
      focusable: true,
      enableLargerThanScreen: true,
      kiosk: false,
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('close', (event) => {
      if (this.active && !this.closing()) event.preventDefault();
    });
    win.on('hide', () => {
      // Something hid it while Nuclear lasts: show it again.
      if (this.active && !this.closing() && !win.isDestroyed()) {
        setImmediate(() => {
          if (this.active && !win.isDestroyed() && !win.isVisible()) win.showInactive();
          this.publish();
        });
      }
    });
    win.on('minimize', () => {
      // A window manager minimised it (Linux ignores `minimizable: false`): undo it.
      if (this.active && !this.closing() && !win.isDestroyed()) {
        setImmediate(() => {
          if (this.active && !this.closing() && !win.isDestroyed()) this.restore(win);
          this.publish();
        });
      }
    });
    win.on('closed', () => {
      if (this.windows.get(displayId) === win) this.windows.delete(displayId);
      if (this.active && !this.closing()) setImmediate(() => this.reconcile());
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.log('nuclear_renderer_gone', { reason: details.reason });
      if (!win.isDestroyed()) win.webContents.reload();
    });
    return win;
  }

  private closing(): boolean {
    return this.quitting || this.options.isQuitting();
  }

  private destroyWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const quitting = this.quitting;
    this.quitting = true;
    try {
      win.destroy();
    } finally {
      this.quitting = quitting;
    }
  }

  destroy(): void {
    this.quitting = true;
    this.stopWatchdog();
    for (const win of this.all()) win.destroy();
    this.windows.clear();
  }
}
