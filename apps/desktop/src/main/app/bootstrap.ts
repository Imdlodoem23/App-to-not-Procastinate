/**
 * App lifecycle (docs/DESKTOP.md §8.1, PROMPT §10 «Ciclo de vida»):
 *
 * 1. Before `ready`: isolated userData (harness), single-instance lock (a second launch
 *    shows the window), AppUserModelID, sandbox for every renderer, `createCore` (prefs are
 *    read synchronously inside it).
 * 2. `ready`: session hardening, theme, tray, IPC, the main window created **hidden**,
 *    `core.start()`, power events.
 * 3. First `ready-to-show`: show, unless started by the login item (`--hidden`, macOS login)
 *    or a harness run without `--harness-show`; pre-warm the detail window ~1 s later.
 * 4. The X only hides. «Salir» (footer, tray, Cmd+Q) quits after `core.shutdown`, which
 *    sends the extensions still waiting in the undo queue. Blocks stay active: the guardian
 *    enforces them.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Menu,
  Notification,
  app,
  nativeTheme,
  powerMonitor,
  shell as electronShell,
} from 'electron';
import type { Core, CreateCore, WindowHost } from '../contracts';
import { FEATURES } from '../../shared/features';
import {
  activeLocale,
  setActiveLocale,
  systemLocaleFrom,
  type Locale,
} from '../../shared/i18n/locale';
import { primaryBlock, snapshotLocale, toPlatform, type UiSnapshot } from '../../shared/ui-state';
import { TrayController } from '../tray/controller';
import type { TrayAction } from '../tray/model';
import { electronDisplaySource } from '../windows/display-source';
import { registerWindowIpc } from '../windows/ipc-window';
import { WindowShell } from '../windows/shell';
import type { RendererSource } from '../windows/window-urls';
import { createAutostart, openedAtLogin } from './autostart';
import { systemClock } from './clock';
import { APP_ID, DETAIL_PREWARM_DELAY_MS, GUIDE_URLS, QUIT_BUDGET_MS } from './constants';
import { parseLaunchOptions, type LaunchOptions } from './launch-options';
import { appLog as sharedAppLog, initAppLog } from '../logs/logger';
import { appLog, type AppLog } from './log';
import { resolveAppPaths } from './paths';
import { hardenSessions } from './security';
import { createShortcutRegistry } from './shortcuts';
import { createThemeController } from './theme';

export interface BootstrapDeps {
  /** MAIN-GUARDIAN's `createCore` (`src/main/guardian/core.ts`). */
  createCore: CreateCore;
  /** MAIN-GUARDIAN's `registerIpcHandlers` (`src/main/ipc-handlers.ts`). */
  registerIpcHandlers(core: Core, host: WindowHost): () => void;
  /** `__dirname` of the main entry (`…/out/main`): resources and renderer resolve from it. */
  mainDir: string;
}

const PRODUCT_NAME = 'Céntrate';

export function startApp(deps: BootstrapDeps): void {
  const packaged = app.isPackaged;
  const log = appLog('app');
  const launch = parseLaunchOptions({ argv: process.argv, env: process.env, packaged });
  for (const problem of launch.problems) log.warn('launch_option_ignored', { problem });

  if (launch.userDataDir) app.setPath('userData', launch.userDataDir);
  // Harness runs are isolated test instances; several may run side by side.
  if (!launch.harness && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId(APP_ID);
  // Every renderer is sandboxed (webPreferences) either way. The process-wide switch would
  // override `--no-sandbox`, which unpackaged test runs as root (CI containers) need.
  if (packaged || !app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
  // Stay in the tray when windows close (they only hide anyway).
  app.on('window-all-closed', () => undefined);
  process.on('unhandledRejection', (reason) =>
    log.error('unhandled_rejection', { message: describe(reason) }),
  );

  boot(deps, launch, log).catch((error: unknown) => {
    log.error('startup_failed', { message: describe(error) });
    app.exit(1);
  });
}

/**
 * The OS language as an app locale: `en…` gives English, anything else Spanish. Read before
 * `ready` (`getLocale` is not available yet), so it falls back to the environment.
 */
function readSystemLocale(): Locale {
  const languages: string[] = [];
  try {
    languages.push(...app.getPreferredSystemLanguages());
  } catch {
    // older platforms: fall through to the environment
  }
  const env = process.env;
  languages.push(env['LC_ALL'] ?? '', env['LC_MESSAGES'] ?? '', env['LANG'] ?? '');
  return systemLocaleFrom(languages.filter((l) => l !== '' && l !== 'C' && l !== 'POSIX'));
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function boot(deps: BootstrapDeps, launch: LaunchOptions, log: AppLog): Promise<void> {
  const packaged = app.isPackaged;
  const platform = toPlatform(process.platform);
  const harnessModule = launch.harness ? await import('./harness') : null;
  const resolved =
    harnessModule && launch.harness ? harnessModule.resolveHarness(launch.harness) : null;
  for (const problem of resolved?.problems ?? []) log.warn('harness_option_ignored', { problem });

  const paths = resolveAppPaths({
    platform,
    packaged,
    env: process.env,
    mainDir: deps.mainDir,
    resourcesPath: process.resourcesPath,
    userDataDir: app.getPath('userData'),
    sysDirOverride: launch.sysDir,
  });
  // MAIN-GUARDIAN's rotating app log; the core may also initialise it (same file).
  if (sharedAppLog().file === null) initAppLog(paths.userDataDir, { echo: !packaged });

  const devUrl = packaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
  const renderer: RendererSource = devUrl
    ? { kind: 'dev', url: devUrl }
    : { kind: 'file', path: paths.rendererHtml };

  let quitting = false;
  const windows = new WindowShell({
    platform,
    packaged,
    preload: paths.preload,
    renderer,
    log: appLog('windows'),
    harnessStateId: resolved?.fixture.id ?? null,
    isQuitting: () => quitting,
    onSessionEnd: () => {
      quitting = true;
    },
    notify: (title, body) => {
      // The harness records it (WindowShell.shownNotifications) instead of showing it.
      if (resolved || !Notification.isSupported()) return;
      new Notification({ title, body, silent: true }).show();
    },
  });

  const core = deps.createCore({
    platform,
    appVersion: app.getVersion(),
    packaged,
    userDataDir: paths.userDataDir,
    sysDir: paths.sysDir,
    guardianBinary: existsSync(paths.guardianBinary) ? paths.guardianBinary : null,
    clock: systemClock,
    features: resolved ? resolved.fixture.snapshot.features : FEATURES,
    systemLocale: readSystemLocale(),
    harness: resolved?.fixture ?? null,
    host: windows,
  });

  setActiveLocale(snapshotLocale(core.getSnapshot()));

  app.on('second-instance', () => windows.showMain('second-instance'));
  // macOS: clicking the Dock icon. The `activate` sent while launching is ignored, or a
  // login-item start (`--hidden`) would open the window.
  let launched = false;
  app.on('activate', (_event, hasVisibleWindows) => {
    if (launched && !hasVisibleWindows) windows.showMain('second-instance');
  });

  await app.whenReady();

  hardenSessions({
    devTools: !packaged,
    log,
    platform,
    rendererDir: renderer.kind === 'file' ? dirname(renderer.path) : null,
  });
  Menu.setApplicationMenu(
    platform === 'darwin'
      ? // Without the Edit roles, copy and paste do not work in text fields on macOS.
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null,
  );

  const theme = createThemeController({
    preference: core.getSnapshot().prefs.theme,
    override: launch.harness?.theme ?? null,
  });
  const displays = resolved?.displays ?? electronDisplaySource();

  const runTrayAction = (action: TrayAction): void => {
    switch (action.type) {
      case 'open':
        windows.showMain('tray-menu');
        return;
      case 'quit':
        app.quit();
        return;
      case 'template':
        // The card is in the renderer before it measures itself for the show.
        windows.sendCommand({ type: 'confirm-template', templateId: action.templateId });
        windows.showMain('tray-menu', false);
        return;
      case 'extend': {
        const block = primaryBlock(core.getSnapshot().state);
        if (!block) return;
        // Same 5 s undo queue as the tiles; the window shows so «Deshacer» is visible.
        void Promise.resolve(
          core.handlers['block:extend'](
            { blockId: block.id, addMinutes: action.minutes },
            { window: 'main' },
          ),
        ).then((result) => {
          if (!result.ok) log.warn('tray_extend_refused', { code: result.error.code });
        });
        windows.showMain('tray-menu', false);
        return;
      }
    }
  };

  const tray = new TrayController({
    platform,
    iconsDir: paths.trayIconsDir,
    clock: systemClock,
    log: appLog('tray'),
    surface: () => ({
      darkSystemUi: theme.darkSystemUi(),
      darkApp: nativeTheme.shouldUseDarkColors,
      desktop: process.env['XDG_CURRENT_DESKTOP'] ?? null,
    }),
    onToggle: () => windows.toggleFromTray(),
    onAction: runTrayAction,
    onView: (view) => windows.setMainTitle(view.title),
  });
  windows.attach({ core, displays, theme, trayBounds: () => tray.bounds() });
  theme.onChange(() => tray.refreshIcon());

  deps.registerIpcHandlers(core, windows);
  registerWindowIpc({
    shell: windows,
    core,
    log: appLog('ipc'),
    quit: () => app.quit(),
    openGuide: (guide) => {
      void electronShell.openExternal(GUIDE_URLS[guide]);
    },
  });

  const autostart = createAutostart({
    platform,
    packaged: packaged && !resolved,
    productName: PRODUCT_NAME,
    log: appLog('autostart'),
  });
  const applyPrefs = (snapshot: UiSnapshot): void => {
    theme.setPreference(snapshot.prefs.theme);
    autostart.apply(snapshot.prefs.autostart);
  };

  // The tray, titles and notifications read their copy in the active locale: set it from
  // each snapshot before anything is built from it.
  const applyLocale = (snapshot: UiSnapshot): void => {
    const locale = snapshotLocale(snapshot);
    if (locale === activeLocale()) return;
    setActiveLocale(locale);
    windows.relocalize();
  };

  applyLocale(core.getSnapshot());
  tray.create(core.getSnapshot());
  applyPrefs(core.getSnapshot());
  core.subscribe((snapshot) => {
    applyLocale(snapshot);
    windows.pushSnapshot(snapshot);
    tray.update(snapshot);
    applyPrefs(snapshot);
  });

  const shortcuts = createShortcutRegistry(appLog('shortcuts'));
  // Phase 1 has no global shortcut («Atajo global» in Ajustes comes later).
  shortcuts.apply([]);

  if (harnessModule && resolved) {
    windows.setHarnessLoad(harnessModule.initialHarnessLoad(resolved));
    harnessModule.installHarnessApi(
      harnessModule.createHarnessApi({
        core,
        shell: windows,
        tray,
        theme,
        displays: resolved.displays,
        initial: resolved.fixture,
        customWorkArea: resolved.customWorkArea,
        lang: resolved.lang,
      }),
    );
  }

  const startHidden =
    launch.hidden || openedAtLogin(platform) || (launch.harness !== null && !launch.harness.show);
  windows.createMainWindow(() => {
    launched = true;
    if (!startHidden) windows.showMain('launch');
    const fixture = resolved?.fixture;
    if (fixture) {
      windows.prewarmDetail();
      if (fixture.window !== 'main' && fixture.detailRequest) {
        void windows.openDetail(fixture.detailRequest, { show: !startHidden });
      }
      return;
    }
    setTimeout(() => windows.prewarmDetail(), DETAIL_PREWARM_DELAY_MS);
  });

  core.start();
  powerMonitor.on('resume', () => core.refreshNow('resume'));
  powerMonitor.on('unlock-screen', () => core.refreshNow('resume'));
  // The OS is going away: let the windows close instead of hiding.
  powerMonitor.on('shutdown', () => {
    quitting = true;
  });

  let shutdownDone = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    const budget = new Promise<void>((resolve) => setTimeout(resolve, QUIT_BUDGET_MS + 500));
    void Promise.race([core.shutdown(QUIT_BUDGET_MS), budget])
      .catch((error: unknown) => log.error('shutdown_failed', { message: describe(error) }))
      .finally(() => {
        shutdownDone = true;
        shortcuts.clear();
        tray.destroy();
        // Next macrotask, never inside this `before-quit`: a quit started natively (SIGTERM /
        // SIGINT on Linux, Cmd+Q on macOS) emits it with no JS on the stack, so a shutdown
        // that settles in microtasks would re-enter `app.quit()` while Electron is still in
        // its first (prevented) quit, which then resets the quitting flag: the windows close
        // but the process never exits.
        setImmediate(() => app.quit());
      });
  });
}
