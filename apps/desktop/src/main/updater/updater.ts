/**
 * The app updater (PROMPT §12): electron-updater with the GitHub provider of
 * `electron-builder.yml`. Checks 30 s after start and every 6 h; downloads only when the user
 * asks («Actualizar a vX»); «Reiniciar para actualizar» installs (blocks stay: the guardian is a
 * separate service). On a check-only system (unsigned macOS, `.deb`) the same button opens the
 * download page. Its state goes to `snapshot.updater` (and `app.updateVersion`).
 *
 * Installing never marks the app as quitting by itself: electron-updater calls `app.quit()`
 * only after the installer started, and the bootstrap's `before-quit` sets the flag then. When
 * the install fails (no installer, AppImage moved, elevate.exe missing) electron-updater only
 * emits `error`: the state says so and the app keeps running as before (the X still hides).
 */
import type { UpdaterState } from '../../shared/platform';
import { INITIAL_UPDATER } from '../../shared/platform';
import { UI_TIMINGS } from '../../shared/ui-state';
import {
  afterCheck,
  checkFailedKeeping,
  isNewerVersion,
  unsupportedState,
  updaterErrorCode,
  withError,
  type UpdaterMode,
} from './model';
import type { LogFields } from '../logs/logger';

/** The part of electron-updater's `AppUpdater` used here (tests pass a fake). */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  isUpdaterActive(): boolean;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdaterOptions {
  mode: UpdaterMode;
  currentVersion: string;
  now(): number;
  publish(state: UpdaterState): void;
  /** Check-only systems: the web's download page (fixed URL). */
  openDownloadPage(): void;
  log(event: string, fields: LogFields): void;
  /** Tests inject a backend; production imports electron-updater lazily. */
  loadBackend?: () => Promise<UpdaterBackend>;
  firstCheckMs?: number;
  intervalMs?: number;
}

export interface Updater {
  start(): void;
  state(): UpdaterState;
  check(): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  install(): Promise<UpdaterState>;
  dispose(): void;
}

async function electronUpdater(): Promise<UpdaterBackend> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: UpdaterBackend;
    default?: { autoUpdater?: UpdaterBackend };
  };
  const backend = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!backend) throw new Error('electron-updater has no autoUpdater');
  return backend;
}

export function createUpdater(options: UpdaterOptions): Updater {
  let state: UpdaterState =
    options.mode === 'unsupported' ? unsupportedState() : { ...INITIAL_UPDATER };
  let backend: Promise<UpdaterBackend | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checking: Promise<UpdaterState> | null = null;
  let downloading: Promise<UpdaterState> | null = null;
  /** `quitAndInstall` was called; an `error` now means the install failed. */
  let installing = false;
  let disposed = false;

  const set = (next: UpdaterState): UpdaterState => {
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      state = next;
      options.publish({ ...state });
    }
    return state;
  };

  const getBackend = (): Promise<UpdaterBackend | null> => {
    backend ??= (async () => {
      if (options.mode === 'unsupported') return null;
      try {
        const b = await (options.loadBackend ?? electronUpdater)();
        if (!b.isUpdaterActive()) return null;
        b.autoDownload = false;
        b.autoInstallOnAppQuit = options.mode === 'full';
        b.on('download-progress', (info) => {
          if (state.status !== 'downloading') return;
          const percent = Math.max(0, Math.min(100, Math.round(info.percent)));
          set({ ...state, percent });
        });
        b.on('error', (error) => {
          if (!installing) return;
          installing = false;
          const code = updaterErrorCode(error);
          options.log('updater_install_failed', { code });
          // The version stays: «Actualizar a vX» can be tried again.
          set(withError(state, code, options.now()));
        });
        return b;
      } catch (error) {
        options.log('updater_unavailable', { code: updaterErrorCode(error) });
        return null;
      }
    })();
    return backend;
  };

  const schedule = (ms: number): void => {
    if (disposed || options.mode === 'unsupported') return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check().finally(() => schedule(options.intervalMs ?? UI_TIMINGS.updateCheckIntervalMs));
    }, ms);
    timer.unref?.();
  };

  async function runCheck(): Promise<UpdaterState> {
    const b = await getBackend();
    if (!b) return set(unsupportedState());
    const before = state;
    // A version already offered (or downloaded, in electron-updater's cache) stays on screen
    // while a background check runs: no flicker of «Reiniciar para actualizar».
    const usable = before.status === 'available' || before.status === 'ready';
    if (!usable) set({ ...state, status: 'checking', error: null });
    try {
      const result = await b.checkForUpdates();
      const found = result?.updateInfo.version ?? null;
      const next = afterCheck(before, found, options.currentVersion, options.now());
      options.log('updater_checked', { status: next.status });
      return set(next);
    } catch (error) {
      const code = updaterErrorCode(error);
      options.log('updater_check_failed', { code });
      // Offline or asleep: a usable version keeps its status (only the code is recorded).
      if (usable) return set(checkFailedKeeping(before, code, options.now()));
      return set(withError({ ...before, status: 'checking' }, code, options.now()));
    }
  }

  function check(): Promise<UpdaterState> {
    if (disposed) return Promise.resolve(state);
    if (downloading) return downloading;
    checking ??= runCheck().finally(() => {
      checking = null;
    });
    return checking;
  }

  async function runDownload(): Promise<UpdaterState> {
    const b = await getBackend();
    if (!b) return set(unsupportedState());
    const version = state.version;
    if (version === null || !isNewerVersion(version, options.currentVersion)) return state;
    set({ status: 'downloading', version, percent: 0, checkedAt: state.checkedAt, error: null });
    try {
      await b.downloadUpdate();
      options.log('updater_downloaded', {});
      return set({
        status: 'ready',
        version,
        percent: 100,
        checkedAt: state.checkedAt,
        error: null,
      });
    } catch (error) {
      const code = updaterErrorCode(error);
      options.log('updater_download_failed', { code });
      return set(withError(state, code, options.now()));
    }
  }

  async function download(): Promise<UpdaterState> {
    if (disposed) return state;
    if (options.mode === 'check-only') {
      options.openDownloadPage();
      return state;
    }
    if (state.status === 'ready') return state;
    if (state.version === null) await check();
    downloading ??= runDownload().finally(() => {
      downloading = null;
    });
    return downloading;
  }

  async function install(): Promise<UpdaterState> {
    if (disposed) return state;
    if (options.mode === 'check-only') {
      options.openDownloadPage();
      return state;
    }
    if (state.status !== 'ready') return download();
    const b = await getBackend();
    if (!b) return set(unsupportedState());
    options.log('updater_install', {});
    installing = true;
    // Silent on Windows (the NSIS installer knows the previous choices), relaunch after.
    setImmediate(() => {
      try {
        b.quitAndInstall(true, true);
      } catch (error) {
        installing = false;
        const code = updaterErrorCode(error);
        options.log('updater_install_failed', { code });
        set(withError(state, code, options.now()));
      }
    });
    return state;
  }

  return {
    start(): void {
      if (options.mode === 'unsupported') {
        options.publish({ ...state });
        return;
      }
      schedule(options.firstCheckMs ?? UI_TIMINGS.updateFirstCheckMs);
    },
    state: () => ({ ...state }),
    check,
    download,
    install,
    dispose(): void {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
