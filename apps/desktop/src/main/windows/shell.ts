/**
 * The window shell (docs/DESKTOP.md §8): the main window and the one reusable detail
 * window, their placement and auto-height, the show path, and the two host interfaces the
 * rest of main talks to (`WindowHost` for `registerIpcHandlers`, `CoreHost` for the core).
 *
 * Constructed before `ready` (the core needs its `CoreHost`), attached to the core, the
 * displays and the theme after `ready`; until then every host method is a safe no-op.
 */
import { app, clipboard, screen, type BrowserWindow } from 'electron';
import type {
  Core,
  CoreHost,
  IpcSenderInfo,
  ShownNotification,
  WindowBoundsReport,
  WindowHost,
} from '../contracts';
import type {
  HarnessLoad,
  InitPayload,
  PushChannel,
  PushPayload,
  ShowReason,
  UiCommand,
} from '../../shared/ipc';
import {
  UI_TIMINGS,
  snapshotNow,
  type DetailRequest,
  type LayoutReport,
  type Platform,
  type UiSnapshot,
  type WindowKind,
  type WindowLayout,
} from '../../shared/ui-state';
import type { AppLog } from '../app/log';
import type { ThemeController } from '../app/theme';
import { createShellWindow, type WindowFactoryOptions } from './browser-windows';
import type { DisplaySource } from './display-source';
import {
  MAIN_DEFAULT_CONTENT_HEIGHT,
  ZERO_FRAME,
  chooseDisplay,
  detailPlacement,
  displayMatching,
  frameInsets,
  mainContentRect,
  needsSizeReapply,
  outerFromContent,
  pixelGrid,
  resizeAnchored,
  windowLayout,
  type DisplayInfo,
  type FrameInsets,
  type PixelGrid,
  type Rect,
} from './geometry';
import { WINDOWS_ES } from './i18n/es';
import { MoveTracker } from './move-tracker';
import { ShowAckWaiter, decideToggle, type ToggleAction } from './toggle';
import { isTrustedFrameUrl, type RendererSource } from './window-urls';

export interface WindowShellOptions {
  platform: Platform;
  packaged: boolean;
  preload: string;
  renderer: RendererSource;
  log: AppLog;
  /** Harness state id for `?state=` (`null` outside the harness). */
  harnessStateId: string | null;
  isQuitting(): boolean;
  /** Windows log-off or shutdown: windows must close instead of hiding. */
  onSessionEnd(): void;
  /** Native notification for the one-time close hint (harness: record only). */
  notify(title: string, body: string): void;
}

export interface ShellAttachments {
  core: Core;
  displays: DisplaySource;
  theme: ThemeController;
  /** `tray.getBounds()` (zeros on Linux), `null` before the tray exists. */
  trayBounds(): Rect | null;
}

interface Placement {
  display: DisplayInfo;
  frame: FrameInsets;
  layout: WindowLayout;
}

export interface ShowResult {
  /** ms from the call to `show()` + `focus()` returning. */
  shownMs: number;
  /** Whether the renderer answered `ui:prepare-show` in time. */
  acked: boolean;
}

/** Smallest top inset that is a real title bar rather than rounding. */
const MIN_TITLE_BAR = 8;

function hasTitleBar(frame: FrameInsets): boolean {
  return frame.top >= MIN_TITLE_BAR;
}

const RECREATE_WINDOW_MS = 60_000;
const RECREATE_MAX = 3;
/** Linux: the detail window follows a dragged main window once `move` events stop this long. */
const MOVE_FOLLOW_MS = 120;

export class WindowShell implements WindowHost, CoreHost {
  private attached: ShellAttachments | null = null;
  private main: BrowserWindow | null = null;
  private detail: BrowserWindow | null = null;
  private readonly registry = new Map<number, WindowKind>();
  private readonly frames = new Map<WindowKind, FrameInsets>();
  private readonly showAck: ShowAckWaiter<LayoutReport>;
  private showInFlight: Promise<ShowResult> | null = null;

  private placement: Placement | null = null;
  private readonly pushedLayout = new Map<WindowKind, string>();
  /**
   * Intended content rect of the main window (avoids 1 DIP drift from reading it back) and
   * whether the user moved it since it was last placed at its corner.
   */
  private readonly mainTrack = new MoveTracker();
  /** Inside our own `setContentBounds` (Linux emits `move` synchronously from it). */
  private settingMain = false;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReport: LayoutReport | null = null;
  private lastBlurAt: number | null = null;
  private detailRequest: DetailRequest | null = null;
  /** The state title («Céntrate · quedan 42 min»), kept for a (re)created main window. */
  private title: string = WINDOWS_ES.appName;

  private harnessLoad: HarnessLoad | null = null;
  private readonly readyIds = new Map<WindowKind, string | null>();
  private readyWaiters: Array<() => void> = [];
  private readonly localNotifications: ShownNotification[] = [];
  private closeHintDone = false;
  private readonly crashes: number[] = [];

  constructor(private readonly options: WindowShellOptions) {
    this.showAck = new ShowAckWaiter<LayoutReport>({
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }

  attach(attachments: ShellAttachments): void {
    this.attached = attachments;
    attachments.displays.onChanged(() => this.refreshPlacement());
    attachments.theme.onChange(() => this.setBackground(attachments.theme.backgroundColor()));
  }

  // -------------------------------------------------------------------------------------
  // Windows
  // -------------------------------------------------------------------------------------

  private factory(): WindowFactoryOptions {
    return {
      platform: this.options.platform,
      packaged: this.options.packaged,
      preload: this.options.preload,
      renderer: this.options.renderer,
      backgroundColor: this.requireAttached().theme.backgroundColor(),
      harnessStateId: this.options.harnessStateId,
    };
  }

  window(kind: WindowKind): BrowserWindow | null {
    const win = kind === 'main' ? this.main : this.detail;
    return win && !win.isDestroyed() ? win : null;
  }

  private register(win: BrowserWindow, kind: WindowKind): void {
    const id = win.webContents.id;
    this.registry.set(id, kind);
    win.on('closed', () => {
      this.registry.delete(id);
      this.frames.delete(kind);
    });
    win.on('show', () => this.visibilityEvent(kind));
    win.on('hide', () => this.visibilityEvent(kind));
    win.on('focus', () => this.visibilityEvent(kind));
    win.on('blur', () => {
      this.lastBlurAt = performance.now();
      this.visibilityEvent(kind);
    });
    win.on('session-end', () => this.options.onSessionEnd());
    win.on('unresponsive', () => {
      this.options.log.warn('renderer_unresponsive_reload', { window: kind });
      win.webContents.reload();
    });
    win.webContents.on('render-process-gone', (_event, details) =>
      this.recreate(kind, details.reason),
    );
  }

  /** Creates the main window, hidden. `onReady` runs on its first `ready-to-show`. */
  createMainWindow(onReady?: () => void): BrowserWindow {
    const win = createShellWindow('main', this.factory());
    this.main = win;
    this.register(win, 'main');
    win.setTitle(this.title);
    win.on('close', (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      this.hideAll();
      this.maybeCloseHint();
    });
    if (this.options.platform === 'linux') {
      // No `will-move` / `moved` on Linux; `move` also fires for our own setContentBounds.
      win.on('move', () => {
        if (this.settingMain || win.isDestroyed() || !win.isVisible()) return;
        if (this.mainTrack.observe(win.getContentBounds(), performance.now())) {
          this.followMain();
        }
      });
    } else {
      // `will-move` is emitted only for user drags; `moved` (on macOS an alias of `move`,
      // so possibly our own setContentBounds) counts only if the position says so.
      win.on('will-move', () => this.mainTrack.userMoving());
      win.on('moved', () => {
        if (this.settingMain || win.isDestroyed()) return;
        this.mainTrack.dragEnded(win.getContentBounds(), performance.now());
        if (this.window('detail')?.isVisible()) this.placeDetail();
      });
    }
    if (onReady) win.once('ready-to-show', onReady);
    return win;
  }

  /** Creates the detail window hidden, if it does not exist yet. */
  prewarmDetail(): BrowserWindow {
    const existing = this.window('detail');
    if (existing) return existing;
    const win = createShellWindow('detail', this.factory());
    this.detail = win;
    this.register(win, 'detail');
    win.on('close', (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      this.closeDetail();
    });
    return win;
  }

  private recreate(kind: WindowKind, reason: string): void {
    const now = Date.now();
    while (this.crashes.length > 0 && now - (this.crashes[0] ?? now) > RECREATE_WINDOW_MS) {
      this.crashes.shift();
    }
    this.crashes.push(now);
    this.options.log.error('renderer_gone', { window: kind, reason });
    if (this.options.isQuitting() || reason === 'clean-exit') return;
    if (this.crashes.length > RECREATE_MAX) {
      this.options.log.error('renderer_crash_loop', { window: kind });
      return;
    }
    const old = this.window(kind);
    const wasVisible = old?.isVisible() ?? false;
    old?.destroy();
    this.readyIds.delete(kind);
    this.pushedLayout.delete(kind);
    if (kind === 'main') {
      this.main = null;
      this.mainTrack.forget();
      this.createMainWindow(() => {
        if (wasVisible) this.showMain('launch');
      });
    } else {
      this.detail = null;
      const request = this.detailRequest;
      const win = this.prewarmDetail();
      if (wasVisible && request) win.once('ready-to-show', () => this.openDetail(request));
    }
  }

  // -------------------------------------------------------------------------------------
  // Pushes
  // -------------------------------------------------------------------------------------

  push<C extends PushChannel>(kind: WindowKind, channel: C, payload: PushPayload<C>): void {
    const win = this.window(kind);
    if (!win) return;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      this.options.log.warn('push_failed', { window: kind, channel, message: String(error) });
    }
  }

  pushAll<C extends PushChannel>(channel: C, payload: PushPayload<C>): void {
    this.push('main', channel, payload);
    this.push('detail', channel, payload);
  }

  /** Every `rev` change goes to both windows, visible or not. */
  pushSnapshot(snapshot: UiSnapshot): void {
    this.pushAll('ui:snapshot', snapshot);
  }

  /** `ui:command` to the main window (tray «Bloqueo rápido ▸», Bloqueos «Bloquear…»). */
  sendCommand(command: UiCommand): void {
    this.push('main', 'ui:command', command);
  }

  private pushLayout(kind: WindowKind, layout: WindowLayout): void {
    const key = JSON.stringify(layout);
    if (this.pushedLayout.get(kind) === key) return;
    this.pushedLayout.set(kind, key);
    this.push(kind, 'ui:layout', layout);
  }

  private visibilityEvent(kind: WindowKind): void {
    const win = this.window(kind);
    if (win) {
      this.push(kind, 'ui:visibility', {
        visible: win.isVisible(),
        focused: win.isFocused(),
        reason: null,
        focusField: false,
      });
    }
    this.attached?.core.visibilityChanged();
  }

  setMainTitle(title: string): void {
    this.title = title;
    const win = this.window('main');
    if (win && win.getTitle() !== title) win.setTitle(title);
  }

  mainTitle(): string {
    return this.window('main')?.getTitle() ?? WINDOWS_ES.appName;
  }

  private setBackground(color: string): void {
    this.window('main')?.setBackgroundColor(color);
    this.window('detail')?.setBackgroundColor(color);
  }

  // -------------------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------------------

  /**
   * Native frame of a window. The harness's fake display brings its own (xvfb draws none, so
   * the geometry matches `layoutForDisplay`). A measured frame counts only with a title bar:
   * at 125 or 150 % the outer and content bounds differ by 1 DIP of rounding alone, and on
   * Linux the window manager's decorations are outside both.
   */
  private frameFor(kind: WindowKind): FrameInsets {
    const displays = this.attached?.displays;
    if (displays?.fake) return displays.fallbackFrame() ?? ZERO_FRAME;
    const cached = this.frames.get(kind);
    if (cached) return cached;
    const win = this.window(kind);
    if (!win) return ZERO_FRAME;
    const measured = frameInsets(win.getBounds(), win.getContentBounds());
    if (!hasTitleBar(measured)) return ZERO_FRAME;
    this.frames.set(kind, measured);
    return measured;
  }

  /** Whether the window's real frame is known (otherwise outer bounds are virtual). */
  private hasRealFrame(kind: WindowKind): boolean {
    return this.frames.has(kind);
  }

  private computePlacement(): Placement {
    const attached = this.requireAttached();
    const displays = attached.displays.all();
    const display = chooseDisplay(
      this.options.platform,
      displays,
      attached.trayBounds(),
      attached.displays.cursor(),
    );
    const frame = this.frameFor('main');
    const placement = {
      display,
      frame,
      layout: windowLayout(this.options.platform, display, frame),
    };
    this.placement = placement;
    return placement;
  }

  private currentPlacement(): Placement {
    return this.placement ?? this.computePlacement();
  }

  private outerOf(kind: WindowKind, win: BrowserWindow): Rect {
    if (this.hasRealFrame(kind)) return win.getBounds();
    const intended = kind === 'main' ? this.mainTrack.intended() : null;
    return outerFromContent(intended ?? win.getContentBounds(), this.frameFor(kind));
  }

  /**
   * Device pixels of `display`. The harness's fake display is DIP on the real (xvfb) screen,
   * which has its origin at 0,0 too, so its pixels are those of the real scale factor
   * (`--force-device-scale-factor`), whatever the preset says.
   */
  private gridOf(display: DisplayInfo): PixelGrid {
    const grid = pixelGrid(display);
    if (!this.attached?.displays.fake) return grid;
    return { ...grid, scaleFactor: screen.getPrimaryDisplay().scaleFactor };
  }

  /** `setContentBounds`, again through another size if the platform kept a stale one. */
  private static setExactContentBounds(win: BrowserWindow, rect: Rect, grid: PixelGrid): void {
    win.setContentBounds(rect, false);
    if (!needsSizeReapply(rect, win.getContentBounds(), grid)) return;
    win.setContentBounds({ ...rect, height: rect.height + 1 }, false);
    win.setContentBounds(rect, false);
  }

  private setMainContent(rect: Rect, grid: PixelGrid): void {
    const win = this.window('main');
    if (!win) return;
    this.settingMain = true;
    try {
      WindowShell.setExactContentBounds(win, rect, grid);
    } finally {
      this.settingMain = false;
    }
    this.mainTrack.placed(rect, win.getContentBounds(), performance.now());
  }

  /**
   * Reads where the main window is: a user move (a drag, a keyboard move, on any platform)
   * makes that position the one to keep. Returns whether the user moved it since its corner.
   */
  private syncMainPosition(main: BrowserWindow): boolean {
    if (main.isVisible()) this.mainTrack.observe(main.getContentBounds(), performance.now());
    return this.mainTrack.userMoved();
  }

  /** Linux: re-glue the detail window once a drag of the main window stops. */
  private followMain(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      if (this.window('detail')?.isVisible()) this.placeDetail();
    }, MOVE_FOLLOW_MS);
  }

  /** Main window at its corner with the last measured height (or 540 before any). */
  private placeMainAtCorner(placement: Placement): void {
    const height = this.lastReport?.height ?? MAIN_DEFAULT_CONTENT_HEIGHT;
    const grid = this.gridOf(placement.display);
    this.setMainContent(
      mainContentRect({
        workArea: placement.display.workArea,
        frame: placement.frame,
        anchor: placement.layout.anchor,
        height,
        grid,
      }),
      grid,
    );
    this.mainTrack.clearMoved();
  }

  /** Display metrics changed (or the fake display switched): new budget, re-place. */
  refreshPlacement(): void {
    if (!this.attached) return;
    const placement = this.computePlacement();
    this.pushLayout('main', placement.layout);
    this.pushLayout('detail', placement.layout);
    const main = this.window('main');
    if (main?.isVisible()) {
      if (!this.syncMainPosition(main)) this.placeMainAtCorner(placement);
    } else if (main) {
      this.mainTrack.forget();
    }
    if (this.window('detail')?.isVisible()) this.placeDetail();
  }

  /** `window:layout`: the renderer's measured height, applied from the anchored edge. */
  applyLayout(report: LayoutReport): void {
    this.lastReport = report;
    const main = this.window('main');
    if (!main?.isVisible() || !this.attached) return;
    const placement = this.currentPlacement();
    const moved = this.syncMainPosition(main);
    const intended = this.mainTrack.intended();
    const from = intended ?? main.getContentBounds();
    // Where the user left it (or before any placement): the display it is on.
    const display =
      moved || !intended ? displayMatching(this.attached.displays.all(), from) : placement.display;
    const grid = this.gridOf(display);
    this.setMainContent(
      resizeAnchored(
        from,
        report.height,
        placement.layout.anchor,
        display.workArea,
        placement.frame,
        grid,
      ),
      grid,
    );
    if (this.window('detail')?.isVisible()) this.placeDetail();
  }

  private placeDetail(): void {
    const main = this.window('main');
    const detail = this.window('detail');
    if (!main || !detail || !this.attached) return;
    this.syncMainPosition(main);
    const mainOuter = this.outerOf('main', main);
    const placement = this.currentPlacement();
    const display = displayMatching(this.attached.displays.all(), mainOuter);
    const grid = this.gridOf(display);
    const { content } = detailPlacement({
      mainOuter,
      workArea: display.workArea,
      anchor: placement.layout.anchor,
      frame: this.frameFor('detail'),
      grid,
    });
    WindowShell.setExactContentBounds(detail, content, grid);
  }

  // -------------------------------------------------------------------------------------
  // Show, hide, toggle
  // -------------------------------------------------------------------------------------

  /**
   * The show path (≤ 150 ms, no white flash): place, let the renderer render and measure the
   * latest state while hidden (`ui:prepare-show` → `window:show-ack`, ≤ 50 ms), set the
   * anchored bounds, show, focus, then tell the renderer to focus its field.
   */
  show(reason: ShowReason, options: { focusField: boolean }): Promise<ShowResult> {
    if (this.showInFlight) return this.showInFlight;
    const run = this.runShow(reason, options).finally(() => {
      this.showInFlight = null;
    });
    this.showInFlight = run;
    return run;
  }

  private async runShow(reason: ShowReason, options: { focusField: boolean }): Promise<ShowResult> {
    const main = this.window('main');
    if (!main || !this.attached) return { shownMs: 0, acked: false };
    const t0 = performance.now();
    const placement = this.computePlacement();
    this.pushLayout('main', placement.layout);
    const seq = this.showAck.next();
    this.push('main', 'ui:prepare-show', { seq, layout: placement.layout });
    const ack = await this.showAck.wait(seq, UI_TIMINGS.showAckTimeoutMs);
    if (ack) this.lastReport = ack;
    const tAck = performance.now();
    if (main.isDestroyed()) return { shownMs: 0, acked: false };

    this.placeMainAtCorner(placement);
    if (this.options.platform === 'darwin') app.focus({ steal: true });
    main.show();
    main.focus();
    const shownMs = performance.now() - t0;
    this.push('main', 'ui:visibility', {
      visible: true,
      focused: true,
      reason,
      focusField: options.focusField,
    });
    this.attached.core.visibilityChanged();
    this.attached.core.refreshNow('show');
    this.logFocusLatency(main, reason, t0, ack ? tAck - t0 : null);
    return { shownMs, acked: ack !== null };
  }

  private logFocusLatency(
    win: BrowserWindow,
    reason: ShowReason,
    t0: number,
    ackMs: number | null,
  ): void {
    const report = (focused: boolean): void => {
      const ms = Math.round(performance.now() - t0);
      const fields = { reason, ms, ack: ackMs === null ? 'timeout' : Math.round(ackMs), focused };
      if (ms > UI_TIMINGS.showBudgetMs || !focused) this.options.log.warn('show_slow', fields);
      else this.options.log.info('show', fields);
    };
    if (win.isFocused()) {
      report(true);
      return;
    }
    const timer = setTimeout(() => {
      win.removeListener('focus', onFocus);
      report(false);
    }, 1_000);
    const onFocus = (): void => {
      clearTimeout(timer);
      report(true);
    };
    win.once('focus', onFocus);
  }

  /** `window:show-ack`; a late answer still carries the height, so it is applied. */
  handleShowAck(seq: number, layout: LayoutReport): void {
    if (!this.showAck.ack(seq, layout)) this.applyLayout(layout);
  }

  /** Visible: bring to the front and focus; hidden: the full show path. */
  showMain(reason: ShowReason, focusField = true): void {
    const main = this.window('main');
    if (!main || !this.attached) return;
    if (main.isVisible()) {
      this.raise(reason, focusField);
      return;
    }
    void this.show(reason, { focusField });
  }

  private raise(reason: ShowReason, focusField: boolean): void {
    const main = this.window('main');
    if (!main) return;
    if (this.options.platform === 'darwin') app.focus({ steal: true });
    main.show();
    main.focus();
    // Same focus as the show path: the field, the card's button, or the Bloqueo root under a
    // block. `ui:command focus-field` would open the field under a block, so it is not sent.
    this.push('main', 'ui:visibility', { visible: true, focused: true, reason, focusField });
  }

  /** Tray left click (and the harness's `trayClick`). */
  toggleFromTray(): ToggleAction {
    const main = this.window('main');
    if (!main) return 'show';
    const detail = this.window('detail');
    const action = decideToggle({
      visible: main.isVisible(),
      focused: main.isFocused() || (detail?.isFocused() ?? false),
      lastBlurAt: this.lastBlurAt,
      now: performance.now(),
    });
    if (action === 'hide') this.hideAll();
    else if (action === 'raise') this.raise('tray', true);
    else void this.show('tray', { focusField: true });
    return action;
  }

  /** X, Esc with nothing left to back out of, tray toggle: hide main and detail. */
  hideAll(): void {
    this.window('detail')?.hide();
    this.window('main')?.hide();
  }

  // -------------------------------------------------------------------------------------
  // Detail window
  // -------------------------------------------------------------------------------------

  /** A door: retarget the one detail window, place it next to main, show and focus it. */
  openDetail(request: DetailRequest, options: { show?: boolean } = {}): void {
    const detail = this.prewarmDetail();
    this.detailRequest = request;
    this.push('detail', 'ui:detail', request);
    detail.setTitle(WINDOWS_ES.detailTitles[request.name]);
    const show = options.show ?? this.window('main')?.isVisible() ?? false;
    if (!show) return;
    const present = (): void => {
      if (detail.isDestroyed() || this.detailRequest !== request) return;
      this.placeDetail();
      detail.show();
      detail.focus();
    };
    // Glue it to where the main window ends up, not to where it is before its show.
    if (this.showInFlight) void this.showInFlight.then(present);
    else present();
  }

  closeDetail(): void {
    const detail = this.window('detail');
    if (!detail?.isVisible()) return;
    detail.hide();
    const main = this.window('main');
    if (main?.isVisible()) main.focus();
  }

  currentDetail(): DetailRequest | null {
    return this.detailRequest;
  }

  // -------------------------------------------------------------------------------------
  // Close hint
  // -------------------------------------------------------------------------------------

  private maybeCloseHint(): void {
    if (this.closeHintDone || !this.attached) return;
    this.closeHintDone = true;
    const { core } = this.attached;
    const snapshot = core.getSnapshot();
    if (snapshot.prefs.closeHintShown) return;
    this.options.notify(WINDOWS_ES.closeHint.title, WINDOWS_ES.closeHint.body);
    this.localNotifications.push({
      at: snapshotNow(snapshot),
      title: WINDOWS_ES.closeHint.title,
      body: WINDOWS_ES.closeHint.body,
      kinds: ['close_hint'],
    });
    void Promise.resolve(
      core.handlers['prefs:set']({ closeHintShown: true }, { window: 'main' }),
    ).catch((error: unknown) =>
      this.options.log.warn('close_hint_pref_failed', { message: String(error) }),
    );
  }

  /** Notifications the shell showed itself (the close hint), for the harness. */
  shownNotifications(): ShownNotification[] {
    return [...this.localNotifications];
  }

  // -------------------------------------------------------------------------------------
  // Harness readiness
  // -------------------------------------------------------------------------------------

  setHarnessLoad(load: HarnessLoad | null): void {
    this.harnessLoad = load;
  }

  /** `window:ready`. */
  markReady(kind: WindowKind, stateId: string | null): void {
    this.readyIds.set(kind, stateId);
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Forget readiness before a harness load, so only answers to that load count. */
  resetReady(): void {
    this.readyIds.clear();
  }

  /** Resolves once every existing window reported `window:ready` for `stateId`. */
  waitReady(stateId: string, timeoutMs: number): Promise<void> {
    const kinds = (['main', 'detail'] as const).filter((k) => this.window(k) !== null);
    const done = (): boolean => kinds.every((k) => this.readyIds.get(k) === stateId);
    return new Promise((resolve, reject) => {
      if (done()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        const missing = kinds.filter((k) => this.readyIds.get(k) !== stateId);
        reject(new Error(`window:ready for "${stateId}" not received from: ${missing.join(', ')}`));
      }, timeoutMs);
      const check = (): void => {
        if (done()) {
          clearTimeout(timer);
          resolve();
        } else {
          this.readyWaiters.push(check);
        }
      };
      this.readyWaiters.push(check);
    });
  }

  /** Resolves after every queued IPC message to the renderers was processed. */
  async flushRenderers(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    const windows = [this.window('main'), this.window('detail')].filter(
      (w): w is BrowserWindow => w !== null && !w.webContents.isLoading(),
    );
    await Promise.all(
      windows.map((w) =>
        w.webContents
          .executeJavaScript('new Promise((r) => setTimeout(() => r(0), 0))', true)
          .catch(() => 0),
      ),
    );
  }

  bounds(): WindowBoundsReport {
    const placement = this.computePlacement();
    const report = (kind: WindowKind): WindowBoundsReport['main'] => {
      const win = this.window(kind);
      if (!win) return null;
      return {
        outer: this.outerOf(kind, win),
        content: win.getContentBounds(),
        visible: win.isVisible(),
      };
    };
    return {
      display: {
        bounds: placement.display.bounds,
        workArea: placement.display.workArea,
        scaleFactor: placement.display.scaleFactor,
      },
      main: report('main'),
      detail: report('detail'),
    };
  }

  // -------------------------------------------------------------------------------------
  // WindowHost
  // -------------------------------------------------------------------------------------

  windowOf(sender: IpcSenderInfo): WindowKind | null {
    const kind = this.registry.get(sender.webContentsId);
    if (!kind) return null;
    return isTrustedFrameUrl(sender.frameUrl, this.options.renderer, this.options.platform)
      ? kind
      : null;
  }

  initPayload(kind: WindowKind): Omit<InitPayload, 'snapshot'> {
    const win = this.window(kind);
    const layout = this.attached
      ? this.currentPlacement().layout
      : { maxContentHeight: MAIN_DEFAULT_CONTENT_HEIGHT, anchor: 'bottom' as const };
    this.pushedLayout.set(kind, JSON.stringify(layout));
    return {
      window: kind,
      platform: this.options.platform,
      layout,
      detail: kind === 'detail' ? this.detailRequest : null,
      visible: win?.isVisible() ?? false,
      harness: this.harnessLoad,
    };
  }

  // -------------------------------------------------------------------------------------
  // CoreHost
  // -------------------------------------------------------------------------------------

  visibility(): { anyVisible: boolean; mainFocused: boolean } {
    const main = this.window('main');
    const detail = this.window('detail');
    return {
      anyVisible: (main?.isVisible() ?? false) || (detail?.isVisible() ?? false),
      mainFocused: main?.isFocused() ?? false,
    };
  }

  writeClipboard(text: string): void {
    clipboard.writeText(text);
  }

  // -------------------------------------------------------------------------------------

  private requireAttached(): ShellAttachments {
    if (!this.attached) throw new Error('WindowShell used before attach()');
    return this.attached;
  }

  /** Before quitting: windows may close now. */
  destroyAll(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = null;
    this.window('detail')?.destroy();
    this.window('main')?.destroy();
  }
}
