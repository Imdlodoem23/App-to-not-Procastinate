/**
 * The Nuclear overlay (PROMPT §10 «Nuclear», ARCHITECTURE §10.5): during a level-3 punishment,
 * one window per display covers it completely (theme background, 72 px countdown, «Castigo ·
 * vuelves a las 18:40» and a single «Salida de emergencia»). It cannot be closed, minimised or
 * moved while Nuclear lasts: a close is refused, a crashed renderer is reloaded, a new display
 * gets its own window. The only way out is the emergency unlock (the Emergencia window opens
 * above it). It never takes focus. Its status (`shown`, displays covered) goes to
 * `snapshot.nuclear`, which drives the guardian heartbeat.
 *
 * Wayland compositors may still draw some surfaces above it (documented limit).
 */
import type { BrowserWindow } from 'electron';
import type { NuclearStatus } from '../../shared/platform';
import type { SurfaceWindowFactory } from '../platform/surface-window';
import type { DisplaySource } from './display-source';
import type { Rect } from './geometry';
import { overlayPlacements } from './nuclear-geometry';

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
}

export class NuclearOverlay {
  /** One window per display id. */
  private readonly windows = new Map<number, BrowserWindow>();
  private active = false;
  private quitting = false;
  private lastStatus = '';

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
    } else {
      this.options.log('nuclear_overlay', { shown: false });
      for (const win of this.all()) {
        win.hide();
        this.options.onVisibility(win, false);
      }
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
      }
    }
    this.publish();
  }

  private publish(): void {
    const shown = this.all().filter((w) => w.isVisible()).length;
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
      focusable: false,
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
    for (const win of this.all()) win.destroy();
    this.windows.clear();
  }
}
