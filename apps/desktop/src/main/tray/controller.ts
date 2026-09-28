/**
 * The tray (docs/DESKTOP.md §8.6): icon, tooltip, native context menu, macOS title and the
 * main window's title, all from the pure `trayView`. Updated on every publish and by one
 * timer set to the next minute flip of the time left (none when nothing depends on time,
 * none on the harness's frozen clock), so a hidden app wakes at most once a minute.
 *
 * Clicks: Windows and macOS left click toggles the main window; right click opens the menu
 * (macOS via `popUpContextMenu`, never `setContextMenu`, or the left click would open it).
 * Linux (AppIndicator) only has the menu, which is why it carries «Abrir Céntrate».
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import type { Clock, TimerHandle, TrayMenuItemModel } from '../contracts';
import { snapshotNow, type Platform, type UiSnapshot } from '../../shared/ui-state';
import type { AppLog } from '../app/log';
import type { Rect } from '../windows/geometry';
import { trayIconFileName, trayIconVariant, type TrayIconSpec, type TraySurface } from './icons';
import {
  nextTrayRefreshDelay,
  trayActionForItem,
  trayView,
  type TrayAction,
  type TrayView,
} from './model';

export interface TrayControllerOptions {
  platform: Platform;
  iconsDir: string;
  clock: Clock;
  log: AppLog;
  surface(): TraySurface;
  /** Left click (Windows, macOS; some Linux trays). */
  onToggle(): void;
  onAction(action: TrayAction): void;
  /** The view changed (the bootstrap sets the main window's title from it). */
  onView(view: TrayView): void;
}

export class TrayController {
  private tray: Tray | null = null;
  private snapshot: UiSnapshot | null = null;
  private view: TrayView | null = null;
  private menuJson = '';
  private menu: Menu | null = null;
  private iconFile = '';
  private tooltipText = '';
  private macTitle = '';
  private timer: TimerHandle | null = null;
  private readonly images = new Map<string, NativeImage>();

  constructor(private readonly options: TrayControllerOptions) {}

  create(snapshot: UiSnapshot): void {
    const view = trayView(snapshot, snapshotNow(snapshot, this.options.clock.now()));
    this.tray = new Tray(
      this.image({ key: view.icon.key, camera: view.icon.camera, variant: this.variantFor(view) }),
    );
    const tray = this.tray;
    tray.on('click', () => this.options.onToggle());
    if (this.options.platform === 'darwin') {
      tray.on('right-click', () => {
        if (this.menu) tray.popUpContextMenu(this.menu);
      });
    }
    this.update(snapshot);
  }

  /** On every publish (and from the minute timer with the latest snapshot). */
  update(snapshot: UiSnapshot): void {
    this.snapshot = snapshot;
    const now = snapshotNow(snapshot, this.options.clock.now());
    const view = trayView(snapshot, now);
    this.view = view;
    this.apply(view);
    this.schedule(snapshot, now);
    this.options.onView(view);
  }

  /** Theme changed: the idle icon's variant follows the taskbar. */
  refreshIcon(): void {
    if (this.view) this.applyIcon(this.view);
  }

  private variantFor(view: TrayView): TrayIconSpec['variant'] {
    return trayIconVariant(this.options.platform, view.icon.key, this.options.surface());
  }

  private apply(view: TrayView): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    this.applyIcon(view);
    if (view.tooltip !== this.tooltipText) {
      this.tooltipText = view.tooltip;
      tray.setToolTip(view.tooltip);
    }
    if (this.options.platform === 'darwin' && view.macTitle !== this.macTitle) {
      this.macTitle = view.macTitle;
      tray.setTitle(view.macTitle, { fontType: 'monospacedDigit' });
    }
    const json = JSON.stringify(view.menu);
    if (json !== this.menuJson) {
      this.menuJson = json;
      this.menu = Menu.buildFromTemplate(this.template(view.menu));
      // Linux needs setContextMenu again after every change; macOS must never use it.
      if (this.options.platform !== 'darwin') tray.setContextMenu(this.menu);
    }
  }

  private applyIcon(view: TrayView): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    const spec: TrayIconSpec = {
      key: view.icon.key,
      camera: view.icon.camera,
      variant: this.variantFor(view),
    };
    const file = trayIconFileName(spec);
    if (file === this.iconFile) return;
    this.iconFile = file;
    tray.setImage(this.image(spec));
  }

  private image(spec: TrayIconSpec): NativeImage {
    const file = trayIconFileName(spec);
    const cached = this.images.get(file);
    if (cached) return cached;
    const path = join(this.options.iconsDir, file);
    let image = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty();
    if (image.isEmpty()) {
      this.options.log.warn('icon_missing', { file });
      image = nativeImage.createEmpty();
    }
    if (spec.variant === 'template') image.setTemplateImage(true);
    this.images.set(file, image);
    return image;
  }

  private template(items: readonly TrayMenuItemModel[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      switch (item.type) {
        case 'separator':
          return { id: item.id, type: 'separator' };
        case 'submenu':
          return {
            id: item.id,
            label: item.label,
            enabled: item.enabled,
            submenu: this.template(item.submenu),
          };
        case 'checkbox':
          return {
            id: item.id,
            type: 'checkbox',
            label: item.label,
            enabled: item.enabled,
            checked: item.checked,
            click: () => this.dispatch(item.id),
          };
        case 'normal':
          return {
            id: item.id,
            label: item.label,
            enabled: item.enabled,
            click: () => this.dispatch(item.id),
          };
      }
    });
  }

  private schedule(snapshot: UiSnapshot, now: number): void {
    if (this.timer !== null) {
      this.options.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (snapshot.harness?.frozenNowMs != null) return;
    const delay = nextTrayRefreshDelay(snapshot, now);
    if (delay === null) return;
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      if (this.snapshot) this.update(this.snapshot);
    }, delay);
  }

  /** Runs a menu item (also used by the harness's `clickTrayItem`). */
  dispatch(id: string): void {
    const found = findItem(this.view?.menu ?? [], id);
    if (!found || !found.enabled) {
      this.options.log.warn('item_unavailable', { id });
      return;
    }
    const action = trayActionForItem(id);
    if (action) this.options.onAction(action);
  }

  currentMenu(): TrayMenuItemModel[] {
    return this.view ? structuredClone(this.view.menu) : [];
  }

  tooltip(): string {
    return this.tooltipText;
  }

  bounds(): Rect | null {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return null;
    try {
      return tray.getBounds();
    } catch {
      return null;
    }
  }

  destroy(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}

function findItem(items: readonly TrayMenuItemModel[], id: string): TrayMenuItemModel | null {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = findItem(item.submenu, id);
    if (inner) return inner;
  }
  return null;
}
