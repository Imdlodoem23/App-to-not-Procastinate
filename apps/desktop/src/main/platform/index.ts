/**
 * PLATFORM's services (docs/DESKTOP.md §15, `PlatformServices` in `contracts.ts`), created by
 * the bootstrap after the core, the shell and the tray:
 *
 * - the surfaces: mini timer, OSD and Nuclear overlay windows, which draw `snapshot` like every
 *   renderer and publish what they cover (`snapshot.nuclear`). The overlay stands only on
 *   trusted data (`nuclearTrusted`: link `ok`, end still ahead) and is looked at again when the
 *   punishment ends; Emergencia sits above it only while it shows Emergencia;
 * - the Nuclear quit lock (`nuclearLocked`, `refuseQuit`) and the tray's «Salida de
 *   emergencia…» (`emergencyExit`);
 * - the OSD after tray and shortcut actions, cleared after 2 s;
 * - the global shortcuts (`prefs.shortcuts`), the updater (`snapshot.updater`,
 *   `app.updateVersion`), the progress (mascot, achievements) from the local event database;
 * - the invoke channels that answer from local data or the OS: statistics and the CSV export
 *   (save dialog), achievements, running processes, the updater, the sounds. Guardian-backed
 *   channels and the guardian-facing loops (active window, reminders, Nuclear heartbeat) are the
 *   core's (`guardian/core.ts`): they need its client.
 *
 * Harness runs keep the fixture's answers for local data (`fixture.local`, the core's stubs)
 * and its platform state; the surfaces still follow the snapshot so they can be screenshot.
 */
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import type { Core, PlatformServices } from '../contracts';
import { featureEnabled } from '../../shared/features';
import { onLocaleChange } from '../../shared/i18n/locale';
import {
  harnessLoad as fixtureHarnessLoad,
  fixtureSurface,
  type HarnessFixture,
} from '../../shared/fixtures';
import { formatClock, formatMinutes } from '../../shared/format';
import type { HarnessLoad, InvokeHandlers, PushChannel, PushPayload } from '../../shared/ipc';
import type { OsdRequest } from '../../shared/platform';
import type { CsvExportKind, CsvExportResult } from '../../shared/stats';
import type { ShortcutAction } from '../../shared/prefs';
import {
  UI_TIMINGS,
  defaultDetailRequest,
  fail,
  modeAccent,
  ok,
  primaryBlock,
  snapshotFeature,
  toUiError,
  uiError,
  type CommandResult,
  snapshotNow,
  type Platform,
  type SurfaceKind,
  type UiSnapshot,
} from '../../shared/ui-state';
import { HARNESS_READY_TIMEOUT_MS } from '../app/constants';
import type { AppLog } from '../app/log';
import { createNullShortcutRegistry, createShortcutRegistry } from '../app/shortcuts';
import type { ThemeController } from '../app/theme';
import { LocalStats, StatsReader, eventsDbFileName } from '../db/stats';
import { localDayOf } from '../db/stats-compute';
import { fileSeenStore, type SeenStore } from '../db/stats-seen';
import { mockGuardianEnabled } from '../guardian/mock';
import { setNuclearOverlayProbe } from '../guardian/nuclear-heartbeat';
import { ShortcutController } from '../shortcuts';
import type { ExecRunner } from '../system/exec';
import {
  UPDATE_DOWNLOAD_PAGE,
  createUpdater,
  offeredVersion,
  updaterMode,
  type Updater,
} from '../updater';
import type { DisplaySource } from '../windows/display-source';
import { MiniTimerWindow } from '../windows/mini-timer';
import { NuclearOverlay } from '../windows/nuclear';
import { type CloakProbe, loadCloakProbe } from '../windows/nuclear-cloak';
import { nuclearRecheckDelay, nuclearTrusted } from '../windows/nuclear-lock';
import { OsdWindow } from '../windows/osd';
import type { WindowShell } from '../windows/shell';
import type { RendererSource } from '../windows/window-urls';
import { PLATFORM } from './i18n';
import { listRunningProcesses } from './processes';
import { progressState } from './progress';
import { loadSound } from './sounds';
import { createSurfaceFactory } from './surface-window';

export interface PlatformServicesOptions {
  platform: Platform;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  core: Core;
  shell: WindowShell;
  displays: DisplaySource;
  theme: ThemeController;
  renderer: RendererSource;
  preload: string;
  userDataDir: string;
  soundsDir: string;
  /** The launch fixture in harness mode (`null` in a real run). */
  harness: HarnessFixture | null;
  exec: ExecRunner;
  log: AppLog;
  openExternal(url: string): void;
  /** The `toggle-main` shortcut: like a tray click. */
  toggleMain(): void;
  /** «Salir», the OS session ending or an update install: surfaces may close. */
  isQuitting(): boolean;
  /** Tests: the seen-achievements store. */
  seen?: SeenStore;
}

/** `PlatformServices` plus what the bootstrap, the tray and the harness call. */
export interface PlatformHost extends PlatformServices {
  /** `harness.openSurface`: show it with the current snapshot, once it rendered. */
  openSurface(kind: SurfaceKind): Promise<void>;
  /** `window:ready` from a surface window. */
  markSurfaceReady(webContentsId: number, kind: SurfaceKind, stateId: string | null): void;
  /** A big notice when «Avisos grandes» is on; `false` when it did not show. */
  showOsd(request: OsdRequest): boolean;
  /** Tray «Ampliar ▸» and the `extend-15` shortcut: the 5 s undo queue, then the OSD. */
  extendPrimary(minutes: number): Promise<void>;
  /** Footer, tray checkbox, shortcut (`null` toggles). */
  toggleMiniTimer(visible: boolean | null): void;
  /** Every surface window (e2e and the harness). */
  surfaceWindows(): BrowserWindow[];
  /** A trusted Nuclear punishment covers the screens: quits the user can repeat are refused. */
  nuclearLocked(): boolean;
  /** A refused quit: the OSD says where the way out is. */
  refuseQuit(): void;
  /** Tray «Salida de emergencia…»: like the overlay's button (`nuclear:emergency-exit`). */
  emergencyExit(): void;
  /**
   * The guardian relaunched the app (`--centrate-nuclear`) while it still runs: heartbeats
   * stopped, so the overlay was not live. Makes the overlay windows again (or looks at the
   * snapshot again when they are off); never shows the main window.
   */
  nuclearRelaunch(): void;
}

const MAIN_CTX = { window: 'main' } as const;

/** The surface's window title in the active locale (the OSD never takes the focus: none). */
export function surfaceTitle(kind: SurfaceKind): string {
  if (kind === 'mini-timer') return PLATFORM.surfaceTitles.miniTimer;
  if (kind === 'nuclear') return PLATFORM.surfaceTitles.nuclear;
  return '';
}
/** How often the progress is recomputed while the local copy lags the guardian's log. */
const PROGRESS_RETRY_MS = 2_000;
const PROGRESS_RETRIES = 5;
/** The progress (a scan of the local log) runs at most this often while events stream in. */
const PROGRESS_MIN_INTERVAL_MS = 3_000;
const PROGRESS_DEBOUNCE_MS = 300;

export function createPlatformServices(options: PlatformServicesOptions): PlatformHost {
  const { core, shell, log } = options;
  const live = options.harness === null;
  let disposed = false;
  /** Harness `openSurface`: shown whatever the snapshot says, until the next load. */
  const forced = new Set<SurfaceKind>();

  // -------------------------------------------------------------------------------------
  // Surface windows
  // -------------------------------------------------------------------------------------

  const baseCreate = createSurfaceFactory({
    platform: options.platform,
    packaged: options.packaged,
    preload: options.preload,
    renderer: options.renderer,
    harnessStateId: options.harness?.id ?? null,
    register: (win, kind) => shell.registerSurface(win, kind),
  });
  /** Readiness of the surface renderers by `webContents` id (harness `openSurface`). */
  const ready = new Map<number, string | null>();
  const create: typeof baseCreate = (kind, extra) => {
    // A named window for screen readers (WCAG 2.4.2): the overlay takes the focus.
    const win = baseCreate(kind, { ...extra, title: surfaceTitle(kind) });
    const id = win.webContents.id;
    // A destroyed surface (the Nuclear overlay after the punishment) is forgotten.
    win.on('closed', () => ready.delete(id));
    return win;
  };

  // The titles follow the language, like the detail window's.
  const offLocale = onLocaleChange(() => {
    for (const kind of ['mini-timer', 'osd', 'nuclear'] as const) {
      const title = surfaceTitle(kind);
      for (const win of windowsOf(kind)) if (win.getTitle() !== title) win.setTitle(title);
    }
  });

  const push = <C extends PushChannel>(
    win: BrowserWindow,
    channel: C,
    payload: PushPayload<C>,
  ): void => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (error) {
      log.warn('surface_push_failed', { channel, message: String(error) });
    }
  };
  const onVisibility = (win: BrowserWindow, visible: boolean): void =>
    push(win, 'ui:visibility', { visible, focused: false, reason: null, focusField: false });

  const miniTimer = new MiniTimerWindow({
    create,
    displays: options.displays,
    linux: options.platform === 'linux',
    onMoved: (position) => setPrefs({ miniTimer: { position } }),
    onVisibility,
    isQuitting: () => options.isQuitting(),
  });
  const osd = new OsdWindow({ create, displays: options.displays, onVisibility });
  /** Windows: DWM cloak state (another virtual desktop), loaded lazily in real runs. */
  let cloakProbe: CloakProbe | null = null;
  if (live && options.platform === 'win32') {
    void loadCloakProbe(options.platform).then((probe) => {
      cloakProbe = probe;
      if (!probe) log.warn('nuclear_cloak_probe_unavailable', {});
    });
  }
  const nuclear = new NuclearOverlay({
    create,
    displays: options.displays,
    backgroundColor: () => options.theme.backgroundColor(),
    onVisibility,
    onStatus: (status) => {
      if (!live) return;
      const current = core.getSnapshot().nuclear;
      core.patchSnapshot({ nuclear: { ...current, ...status } });
    },
    log: (event, fields) => log.info(event, fields),
    isQuitting: () => options.isQuitting(),
    keepFocus: () => emergencyRaised() !== null,
    cloaked: (win) => cloakProbe?.(win) ?? false,
    ...(options.platform === 'darwin'
      ? { appHidden: () => app.isHidden(), showApp: () => app.show() }
      : {}),
  });
  // Each heartbeat asks the live windows, not only the last published status.
  if (live) setNuclearOverlayProbe(() => nuclear.liveCount());
  options.theme.onChange(() => nuclear.setBackground(options.theme.backgroundColor()));

  const surfaceWindows = (): BrowserWindow[] =>
    [miniTimer.window(), osd.window(), ...nuclear.all()].filter(
      (w): w is BrowserWindow => w !== null && !w.isDestroyed(),
    );

  const windowsOf = (kind: SurfaceKind): BrowserWindow[] => {
    if (kind === 'mini-timer')
      return [miniTimer.window()].filter((w): w is BrowserWindow => w !== null);
    if (kind === 'osd') return [osd.window()].filter((w): w is BrowserWindow => w !== null);
    return nuclear.all();
  };

  // -------------------------------------------------------------------------------------
  // Emergencia above the overlay
  // -------------------------------------------------------------------------------------

  /** The detail window raised above the overlay (screen-saver + 1), if any. */
  let raised: BrowserWindow | null = null;
  const emergencyRaised = (): BrowserWindow | null =>
    raised && !raised.isDestroyed() ? raised : null;

  /**
   * Emergencia goes above the overlay while Nuclear lasts and it is what the detail window
   * shows, whatever opened it (the overlay's button, the tray, a door). Any other view, a hidden
   * detail window or the end of Nuclear drops it back, so Ajustes or Estadísticas never cover
   * the overlay.
   */
  function syncEmergencyRaise(options: { focus?: boolean } = {}): void {
    if (disposed) return;
    const detail = shell.window('detail');
    const want =
      detail !== null &&
      nuclear.isActive() &&
      detail.isVisible() &&
      shell.currentDetail()?.name === 'emergencia';
    const current = emergencyRaised();
    if (current && (!want || current !== detail)) {
      current.setAlwaysOnTop(false);
      raised = null;
    }
    if (!want || !detail) return;
    if (raised !== detail) {
      raised = detail;
      // Above the overlay (screen-saver level + 1) and focused, so the phrase can be typed.
      detail.setAlwaysOnTop(true, 'screen-saver', 1);
      detail.moveTop();
      detail.focus();
    } else if (options.focus) {
      detail.moveTop();
      detail.focus();
    }
  }

  // The detail window's own events: shown or focused on another view, hidden, recreated.
  const onWindowFocus = (_event: unknown, win: BrowserWindow): void => {
    if (win === shell.window('detail') || win === emergencyRaised()) syncEmergencyRaise();
  };
  const onWindowCreated = (_event: unknown, win: BrowserWindow): void => {
    win.on('hide', () => {
      if (win === emergencyRaised()) syncEmergencyRaise();
    });
    win.on('show', () => {
      if (win === shell.window('detail')) syncEmergencyRaise();
    });
  };
  app.on('browser-window-focus', onWindowFocus);
  app.on('browser-window-created', onWindowCreated);
  // Another view in a visible detail window (no show or focus event then).
  const offDetailChange = shell.onDetailChange(() => syncEmergencyRaise());

  let nuclearTimer: ReturnType<typeof setTimeout> | null = null;
  function syncSurfaces(snapshot: UiSnapshot): void {
    if (disposed) return;
    miniTimer.sync(
      forced.has('mini-timer') ||
        (snapshotFeature(snapshot, 'miniTimer') && snapshot.prefs.miniTimer.visible),
      snapshot.prefs.miniTimer.position,
    );
    osd.sync(
      snapshot.osd ??
        (forced.has('osd')
          ? { id: 0, text: '', icon: 'check', tone: 'neutral', shownAt: 0 }
          : null),
    );
    // Only trusted data covers the screens: never a stale state from a guardian that stopped
    // answering, never after the punishment's end.
    const now = snapshotNow(snapshot);
    const nuclearOn = forced.has('nuclear') || nuclearTrusted(snapshot, now);
    nuclear.sync(nuclearOn);
    if (nuclearTimer) clearTimeout(nuclearTimer);
    nuclearTimer = null;
    const recheck = forced.has('nuclear') ? null : nuclearRecheckDelay(snapshot, now);
    // Harness runs sit on a frozen clock: nothing ends by itself there.
    if (recheck !== null && live) {
      nuclearTimer = setTimeout(() => {
        nuclearTimer = null;
        syncSurfaces(core.getSnapshot());
      }, recheck);
    }
    syncEmergencyRaise();
  }

  function nuclearLocked(): boolean {
    if (disposed || !nuclear.isActive()) return false;
    const snapshot = core.getSnapshot();
    return nuclearTrusted(snapshot, snapshotNow(snapshot));
  }

  function nuclearRelaunch(): void {
    if (disposed) return;
    const active = nuclear.isActive();
    log.info('nuclear_relaunch_received', { active, live: nuclear.liveCount() });
    if (active) nuclear.relaunch();
    // Off (stale or untrusted data): the fresh state the bootstrap asked for decides.
    else syncSurfaces(core.getSnapshot());
  }

  function refuseQuit(): void {
    log.info('quit_refused_nuclear', {});
    showOsd({ text: PLATFORM.osd.nuclearQuit, icon: 'warning', tone: 'neutral' });
  }

  // -------------------------------------------------------------------------------------
  // Harness readiness of the surfaces
  // -------------------------------------------------------------------------------------

  let readyWaiters: Array<() => void> = [];

  function markSurfaceReady(
    webContentsId: number,
    _kind: SurfaceKind,
    stateId: string | null,
  ): void {
    ready.set(webContentsId, stateId);
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) w();
  }

  function waitSurface(
    kind: SurfaceKind,
    stateId: string | null,
    timeoutMs: number,
  ): Promise<void> {
    const done = (): boolean => {
      const wins = windowsOf(kind);
      return wins.length > 0 && wins.every((w) => ready.get(w.webContents.id) === stateId);
    };
    return new Promise((resolve, reject) => {
      if (done()) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `window:ready for the ${kind} surface not received (${stateId ?? 'no state'})`,
            ),
          ),
        timeoutMs,
      );
      const check = (): void => {
        if (done()) {
          clearTimeout(timer);
          resolve();
        } else readyWaiters.push(check);
      };
      readyWaiters.push(check);
    });
  }

  // -------------------------------------------------------------------------------------
  // Prefs, OSD, mini timer, extend
  // -------------------------------------------------------------------------------------

  function setPrefs(patch: Parameters<Core['handlers']['prefs:set']>[0]): void {
    void Promise.resolve(core.handlers['prefs:set'](patch, MAIN_CTX)).then((r) => {
      if (!r.ok) log.warn('prefs_set_refused', { code: r.error.code });
    });
  }

  let osdSeq = 0;
  let osdTimer: ReturnType<typeof setTimeout> | null = null;
  function showOsd(request: OsdRequest): boolean {
    const snapshot = core.getSnapshot();
    if (disposed || !snapshotFeature(snapshot, 'osd') || !snapshot.prefs.osd) return false;
    osdSeq = Math.max(osdSeq, snapshot.osd?.id ?? 0) + 1;
    const id = osdSeq;
    const text = request.text.trim().slice(0, 80);
    core.patchSnapshot({
      osd: { text, icon: request.icon, tone: request.tone, id, shownAt: Date.now() },
    });
    if (osdTimer) clearTimeout(osdTimer);
    osdTimer = setTimeout(() => {
      osdTimer = null;
      if (core.getSnapshot().osd?.id === id) core.patchSnapshot({ osd: null });
    }, UI_TIMINGS.osdMs);
    return true;
  }

  function toggleMiniTimer(visible: boolean | null): void {
    const snapshot = core.getSnapshot();
    if (!featureEnabled(snapshot.features, 'miniTimer')) return;
    // The user decides now, whatever the harness forced.
    forced.delete('mini-timer');
    const next = visible ?? !snapshot.prefs.miniTimer.visible;
    setPrefs({ miniTimer: { visible: next } });
  }

  async function extendPrimary(minutes: number): Promise<void> {
    const block = primaryBlock(core.getSnapshot().state);
    if (!block) {
      showOsd({ text: PLATFORM.osd.noBlock, icon: 'warning', tone: 'neutral' });
      return;
    }
    const r = await Promise.resolve(
      core.handlers['block:extend']({ blockId: block.id, addMinutes: minutes }, MAIN_CTX),
    );
    if (!r.ok) {
      log.warn('extend_refused', { code: r.error.code });
      showOsd({
        text:
          r.error.code === 'extension_exceeds_max'
            ? PLATFORM.osd.maxReached
            : PLATFORM.osd.extendRefused,
        icon: 'warning',
        tone: 'orange',
      });
      return;
    }
    const entry = core.getSnapshot().ops.extendQueue.find((e) => e.id === r.value.entryId);
    const added = entry?.addMinutes ?? minutes;
    const until = entry
      ? Date.parse(entry.projectedEndsAt)
      : Date.parse(block.endsAt) + minutes * 60_000;
    showOsd({
      text: PLATFORM.osd.extended(formatMinutes(added), formatClock(until)),
      icon: 'extend',
      tone: modeAccent(block.mode),
    });
  }

  function runShortcut(action: ShortcutAction): void {
    switch (action) {
      case 'toggle-main':
        options.toggleMain();
        return;
      case 'extend-15':
        void extendPrimary(15);
        return;
      case 'toggle-mini-timer': {
        const next = !core.getSnapshot().prefs.miniTimer.visible;
        toggleMiniTimer(next);
        showOsd({
          text: next ? PLATFORM.osd.miniTimerShown : PLATFORM.osd.miniTimerHidden,
          icon: 'timer',
          tone: 'neutral',
        });
        return;
      }
    }
  }

  const shortcuts = new ShortcutController({
    registry: live ? createShortcutRegistry(log) : createNullShortcutRegistry(),
    run: runShortcut,
    publish: (status) => {
      if (live) core.patchSnapshot({ shortcuts: status });
    },
  });

  // -------------------------------------------------------------------------------------
  // Updater
  // -------------------------------------------------------------------------------------

  const updater: Updater | null = live
    ? createUpdater({
        mode: updaterMode({
          platform: options.platform,
          packaged: options.packaged,
          env: options.env,
        }),
        currentVersion: core.getSnapshot().app.version,
        now: () => Date.now(),
        publish: (state) =>
          core.patchSnapshot({
            updater: state,
            app: { ...core.getSnapshot().app, updateVersion: offeredVersion(state) },
          }),
        openDownloadPage: () => options.openExternal(UPDATE_DOWNLOAD_PAGE),
        log: (event, fields) => log.info(event, fields),
      })
    : null;

  // -------------------------------------------------------------------------------------
  // Local data: statistics, achievements, progress
  // -------------------------------------------------------------------------------------

  const seen = options.seen ?? fileSeenStore(options.userDataDir);
  const stats: LocalStats | null = live
    ? new LocalStats({
        open: () =>
          StatsReader.open(
            join(
              options.userDataDir,
              eventsDbFileName(mockGuardianEnabled(options.env, options.packaged)),
            ),
          ),
        today: () => localDayOf(Date.now()),
        goalMinutes: () => core.getSnapshot().state?.points.today.goalMinutes ?? 60,
        csvHeaders: () => ({ events: PLATFORM.csv.events, days: PLATFORM.csv.days }),
        csvNames: () => PLATFORM.csv.names,
      })
    : null;

  let progressKey = '';
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressRetries = 0;

  let progressRanAt = Number.NEGATIVE_INFINITY;

  function computeProgress(): void {
    progressTimer = null;
    progressRanAt = Date.now();
    const snapshot = core.getSnapshot();
    const state = snapshot.state;
    if (!stats || !state || disposed) return;
    try {
      const cursor = stats.cursor();
      const progress = progressState({
        achievements: stats.achievements(),
        events: stats.epochEvents(),
        today: state.points.today,
        seen: seen.read(),
        epoch: cursor.epoch,
      });
      core.patchSnapshot({ progress });
      // The local copy lags the guardian: look again shortly (the sync may publish nothing).
      if (
        (cursor.epoch !== state.epoch || cursor.lastSeq < state.lastEventSeq) &&
        progressRetries < PROGRESS_RETRIES
      ) {
        progressRetries += 1;
        progressKey = '';
        progressTimer = setTimeout(computeProgress, PROGRESS_RETRY_MS);
      } else {
        progressRetries = 0;
      }
    } catch (error) {
      log.warn('progress_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  function refreshProgress(snapshot: UiSnapshot): void {
    const state = snapshot.state;
    if (!stats || !state) return;
    const t = state.points.today;
    const key = `${state.epoch}:${state.lastEventSeq}:${t.focusMinutes}:${t.goalMinutes}`;
    if (key === progressKey) return;
    progressKey = key;
    // Already planned: it reads the latest log when it runs. A stream of events (each one a
    // new `lastEventSeq`) costs one computation every few seconds, not one per event.
    if (progressTimer) return;
    const wait = Math.max(
      PROGRESS_DEBOUNCE_MS,
      progressRanAt + PROGRESS_MIN_INTERVAL_MS - Date.now(),
    );
    progressTimer = setTimeout(computeProgress, wait);
  }

  /** Runs a local-data answer; any exception becomes a `CommandResult` failure. */
  async function guarded<T>(code: string, run: () => Promise<T> | T): Promise<CommandResult<T>> {
    try {
      return ok(await run());
    } catch (error) {
      const e = toUiError(error);
      log.warn('platform_command_failed', { code, kind: e.kind });
      return fail(uiError('internal', code));
    }
  }

  function requireStats(): LocalStats {
    if (!stats) throw new Error('no local statistics in this run');
    return stats;
  }

  async function exportCsv(kind: CsvExportKind): Promise<CommandResult<CsvExportResult>> {
    const s = requireStats();
    let out: { text: string; rows: number; fileName: string };
    try {
      out = s.csv(kind);
    } catch {
      return fail(uiError('internal', 'stats_unavailable'));
    }
    const parent = shell.window('detail') ?? shell.window('main');
    const dialogOptions = {
      title: PLATFORM.csv.dialogTitle,
      defaultPath: join(app.getPath('documents'), out.fileName),
      filters: [{ name: PLATFORM.csv.filterName, extensions: ['csv'] }],
    };
    const choice = parent
      ? await dialog.showSaveDialog(parent, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (choice.canceled || !choice.filePath) {
      return ok({ outcome: 'cancelled' as const, rows: 0, fileName: null });
    }
    try {
      await writeFile(choice.filePath, out.text, 'utf8');
    } catch (error) {
      log.warn('csv_write_failed', { error: error instanceof Error ? error.name : 'unknown' });
      return fail(uiError('internal', 'csv_write_failed'));
    }
    log.info('csv_exported', { kind, rows: out.rows });
    return ok({ outcome: 'saved' as const, rows: out.rows, fileName: basename(choice.filePath) });
  }

  // -------------------------------------------------------------------------------------
  // Invoke channels (override the core's stubs)
  // -------------------------------------------------------------------------------------

  const handlers: Partial<Omit<InvokeHandlers, 'app:init'>> = {
    // Every run: the files ship with the app.
    'sounds:load': ({ sound }) =>
      guarded('sound_unavailable', () => loadSound(options.soundsDir, sound)),
  };
  if (live) {
    Object.assign(handlers, {
      'achievements:list': () =>
        guarded('stats_unavailable', () => {
          const s = requireStats();
          const list = s.achievements();
          // Opening Logros shows every reached one: none is fresh any more.
          const epoch = s.cursor().epoch;
          try {
            seen.write({ epoch, ids: list.filter((a) => a.achieved).map((a) => a.id) });
          } catch (error) {
            log.warn('achievements_seen_write_failed', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
          const progress = core.getSnapshot().progress;
          if (progress && progress.fresh.length > 0)
            core.patchSnapshot({ progress: { ...progress, fresh: [] } });
          return list;
        }),
      'stats:overview': (req) => guarded('stats_unavailable', () => requireStats().overview(req)),
      'stats:heatmap': (req) => guarded('stats_unavailable', () => requireStats().heatmap(req)),
      'stats:events': (req) =>
        guarded('stats_unavailable', () =>
          requireStats().events(req.filter, req.before, req.limit),
        ),
      'stats:export-csv': (req) => exportCsv(req.kind),
      'system:processes': () =>
        guarded('processes_unavailable', () =>
          listRunningProcesses(options.platform, options.exec),
        ),
      'updater:check': () =>
        guarded('updater_failed', () => updater?.check() ?? core.getSnapshot().updater),
      'updater:download': () =>
        guarded('updater_failed', () => updater?.download() ?? core.getSnapshot().updater),
      'updater:install': () =>
        guarded('updater_failed', () => updater?.install() ?? core.getSnapshot().updater),
    } satisfies Partial<Omit<InvokeHandlers, 'app:init'>>);
  }
  Object.assign(core.handlers, handlers);
  // «Reiniciar para actualizar» would drop the overlay until the guardian relaunches the app:
  // refused while Nuclear lasts, in every run (the harness's stub answers otherwise).
  const install = core.handlers['updater:install'];
  core.handlers['updater:install'] = (req, ctx) => {
    if (nuclearLocked()) {
      log.info('updater_install_refused', { reason: 'nuclear_active' });
      return fail(uiError('rejected', 'nuclear_active', 409));
    }
    return install(req, ctx);
  };

  // -------------------------------------------------------------------------------------
  // Send channels
  // -------------------------------------------------------------------------------------

  const sendHandlers: PlatformServices['sendHandlers'] = {
    'mini-timer:toggle': ({ visible }) => toggleMiniTimer(visible),
    'mini-timer:position': ({ position }) => {
      setPrefs({ miniTimer: { position } });
    },
    'osd:show': (request) => {
      showOsd(request);
    },
    'nuclear:emergency-exit': () => emergencyExit(),
  };

  function emergencyExit(): void {
    if (!nuclear.isActive()) return;
    void (async () => {
      shell.showMain('command', false);
      await shell.openDetail(defaultDetailRequest('emergencia'), { show: true });
      syncEmergencyRaise({ focus: true });
    })().catch((error: unknown) => log.warn('emergency_exit_failed', { message: String(error) }));
  }

  // -------------------------------------------------------------------------------------
  // Snapshot → everything
  // -------------------------------------------------------------------------------------

  function onSnapshot(snapshot: UiSnapshot): void {
    if (disposed) return;
    for (const win of surfaceWindows()) push(win, 'ui:snapshot', snapshot);
    syncSurfaces(snapshot);
    shortcuts.apply(snapshot.prefs.shortcuts);
    if (live) refreshProgress(snapshot);
  }

  let unsubscribe: (() => void) | null = null;
  let offLimitAlert: (() => void) | null = null;

  async function openSurface(kind: SurfaceKind): Promise<void> {
    forced.add(kind);
    const snapshot = core.getSnapshot();
    syncSurfaces(snapshot);
    const stateId = snapshot.harness?.stateId ?? null;
    const load: HarnessLoad | null = shell.currentHarnessLoad();
    for (const win of windowsOf(kind)) {
      if (ready.get(win.webContents.id) === stateId) continue;
      // A loaded window renders the load again and answers `window:ready`.
      if (!win.webContents.isLoading() && load) push(win, 'ui:harness', load);
    }
    await waitSurface(kind, stateId, HARNESS_READY_TIMEOUT_MS);
  }

  return {
    sendHandlers,
    start(): void {
      if (unsubscribe) return;
      unsubscribe = core.subscribe(onSnapshot);
      // Daily limits: «Te quedan 5 min de YouTube hoy» / «Has gastado tus 30 min…» (big notice).
      offLimitAlert = core.onLimitAlert((alert) => {
        showOsd({
          text: alert.text,
          icon: alert.kind === 'reached' ? 'block' : 'timer',
          tone: alert.kind === 'reached' ? 'red' : 'orange',
        });
      });
      onSnapshot(core.getSnapshot());
      updater?.start();
    },
    async harnessLoad(fixture: HarnessFixture): Promise<void> {
      forced.clear();
      const load = fixtureHarnessLoad(fixture);
      for (const win of surfaceWindows()) {
        ready.delete(win.webContents.id);
        push(win, 'ui:harness', load);
        push(win, 'ui:snapshot', core.getSnapshot());
      }
      syncSurfaces(core.getSnapshot());
      const kind = fixtureSurface(fixture);
      if (kind) await openSurface(kind);
    },
    openSurface,
    markSurfaceReady,
    showOsd,
    extendPrimary,
    toggleMiniTimer,
    surfaceWindows,
    nuclearLocked,
    refuseQuit,
    emergencyExit,
    nuclearRelaunch,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      offLimitAlert?.();
      offLimitAlert = null;
      if (osdTimer) clearTimeout(osdTimer);
      if (progressTimer) clearTimeout(progressTimer);
      if (nuclearTimer) clearTimeout(nuclearTimer);
      offDetailChange();
      offLocale();
      if (live) setNuclearOverlayProbe(null);
      app.off('browser-window-focus', onWindowFocus);
      app.off('browser-window-created', onWindowCreated);
      updater?.dispose();
      shortcuts.dispose();
      stats?.close();
      miniTimer.destroy();
      osd.destroy();
      nuclear.destroy();
    },
  };
}
