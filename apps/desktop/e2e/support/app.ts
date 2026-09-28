/**
 * Electron launcher for the e2e suite and the screenshot capture (docs/DESKTOP.md §10, §12).
 *
 * - Runs the **built** app (`out/main/index.js`): build first with
 *   `npm run build -w apps/desktop`.
 * - Harness mode (`state` set): `--harness-state`, `CENTRATE_HARNESS=1`; main seeds the core
 *   from the fixture, runs the fake guardian on a frozen clock and installs
 *   `globalThis.__centrateHarness` (`HarnessApi`), which `harness` below drives.
 * - Mock mode (`state: null`): the production bootstrap with `CENTRATE_MOCK_GUARDIAN=1` (the
 *   in-memory guardian on the real clock), no fixtures and no harness API.
 * - Every launch gets its own `userData` (`CENTRATE_USER_DATA`), removed on `close()`.
 * - `--force-device-scale-factor` is process-wide, so a scale change means a new launch; the
 *   fake display (work area, frame) switches in-process with `harness.load(id, { display })`.
 * - Linux: `--no-sandbox` (CI containers and root cannot use Chromium's SUID sandbox; every
 *   renderer still runs with `sandbox: true`), and a display is required: run under
 *   `xvfb-run -a -s "-screen 0 2880x1800x24"` (the default xvfb screen is 640×480×8).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import type { ThemeName } from '@centrate/shared/design/tokens';
import {
  HARNESS_ARGS,
  HARNESS_ENV,
  HARNESS_GLOBAL,
  type HarnessApi,
} from '../../src/main/contracts';
import {
  DISPLAY_PRESETS,
  type DisplayPresetId,
  type HarnessStateId,
  type Rect,
} from '../../src/shared/fixtures';
import type { WindowKind } from '../../src/shared/ui-state';
import { LAUNCH_ENV } from '../../src/main/app/launch-options';

export const APP_DIR = resolve(__dirname, '..', '..');
export const MAIN_ENTRY = join(APP_DIR, 'out', 'main', 'index.js');

/** `src/main/guardian/mock.ts` (`MOCK_GUARDIAN_ENV`): the in-memory guardian, unpackaged only. */
export const MOCK_GUARDIAN_ENV = 'CENTRATE_MOCK_GUARDIAN';

const localRequire = createRequire(__filename);

/** The Electron binary of the workspace (`require('electron')` is its path under Node). */
export function electronBinary(): string {
  return localRequire('electron') as string;
}

export interface LaunchOptions {
  /** Harness fixture to start on; `null`: production bootstrap with the mock guardian. */
  state: HarnessStateId | null;
  /** Fake display preset (harness only). Default: the fixture's own. */
  display?: DisplayPresetId;
  /** `--force-device-scale-factor`. Default: the display preset's, else 1. */
  scaleFactor?: number;
  /** Custom fake work area in DIP (`CENTRATE_FAKE_WORKAREA`), instead of the preset's. */
  workArea?: Rect;
  /** Forced theme (harness only). Default: the fixture's prefs (`system`). */
  theme?: ThemeName;
  /** Show the main window at start (harness only; mock mode always shows it). */
  show?: boolean;
  /**
   * Without a harness state: `mock` (default) runs the in-memory guardian
   * (`CENTRATE_MOCK_GUARDIAN=1`); `http` talks to a real HTTP guardian through the production
   * client, with `client.json` from `sysDir` (`CENTRATE_DATA_DIR`).
   */
  guardian?: 'mock' | 'http';
  sysDir?: string;
  /** Extra environment and arguments. */
  env?: Record<string, string>;
  args?: string[];
}

export interface LaunchedApp {
  electron: ElectronApplication;
  options: LaunchOptions;
  scaleFactor: number;
  userDataDir: string;
  /** Typed `HarnessApi` calls (harness mode only). */
  harness: HarnessClient;
  /** The page of a window (waits until it exists and has loaded its document). */
  page(kind: WindowKind): Promise<Page>;
  close(): Promise<void>;
}

export type HarnessClient = {
  [K in keyof HarnessApi]: (
    ...args: Parameters<HarnessApi[K]>
  ) => Promise<Awaited<ReturnType<HarnessApi[K]>>>;
};

function assertBuilt(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`${MAIN_ENTRY} is missing: run \`npm run build -w apps/desktop\` first.`);
  }
}

function assertDisplay(): void {
  if (process.platform !== 'linux') return;
  if (process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']) return;
  throw new Error(
    'No display: run under xvfb, e.g. `xvfb-run -a -s "-screen 0 2880x1800x24" npm run e2e -w apps/desktop`.',
  );
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // A dev server URL would make main load the renderer from it; Node mode breaks Electron.
  delete env['ELECTRON_RENDERER_URL'];
  delete env['ELECTRON_RUN_AS_NODE'];
  for (const key of [
    ...Object.values(LAUNCH_ENV),
    ...Object.values(HARNESS_ENV),
    MOCK_GUARDIAN_ENV,
  ]) {
    delete env[key];
  }
  return env;
}

function callHarness(electron: ElectronApplication): HarnessClient {
  const call =
    (method: keyof HarnessApi) =>
    (...args: unknown[]): Promise<never> =>
      electron.evaluate(
        async (_electron, input: { key: string; method: string; args: unknown[] }) => {
          const api = (globalThis as Record<string, unknown>)[input.key] as
            Record<string, (...a: unknown[]) => unknown> | undefined;
          if (!api) throw new Error('No harness API: launch with a harness state.');
          const fn = api[input.method];
          if (typeof fn !== 'function') throw new Error(`HarnessApi.${input.method} is missing`);
          return (await fn(...input.args)) as never;
        },
        { key: HARNESS_GLOBAL, method, args },
      );
  const methods: readonly (keyof HarnessApi)[] = [
    'states',
    'load',
    'showMain',
    'hideMain',
    'openDetail',
    'advance',
    'trayClick',
    'trayMenu',
    'clickTrayItem',
    'trayTooltip',
    'windowTitle',
    'bounds',
    'snapshot',
    'guardianCalls',
    'notifications',
  ];
  return Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as HarnessClient;
}

function windowOf(page: Page): WindowKind | null {
  const url = page.url();
  if (/[?&]window=detail\b/.test(url)) return 'detail';
  if (/[?&]window=main\b/.test(url)) return 'main';
  return null;
}

/** The page of `kind`, waiting for Electron to create it. */
async function findPage(electron: ElectronApplication, kind: WindowKind): Promise<Page> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = electron.windows().find((p) => windowOf(p) === kind);
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      return found;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the ${kind} window did not open`);
    await electron.waitForEvent('window', { timeout: left }).catch(() => undefined);
  }
}

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  assertBuilt();
  assertDisplay();
  const preset = options.display ? DISPLAY_PRESETS[options.display] : null;
  const scaleFactor = options.scaleFactor ?? preset?.scaleFactor ?? 1;
  const userDataDir = mkdtempSync(join(tmpdir(), 'centrate-e2e-'));

  const args = [MAIN_ENTRY, `--force-device-scale-factor=${scaleFactor}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const env: Record<string, string> = {
    ...baseEnv(),
    TZ: 'Europe/Madrid',
    LANG: 'es_ES.UTF-8',
    LANGUAGE: 'es_ES:es',
    [HARNESS_ENV.userData]: userDataDir,
  };
  if (options.guardian !== 'http') env[MOCK_GUARDIAN_ENV] = '1';
  if (options.sysDir) env[HARNESS_ENV.sysDir] = options.sysDir;
  if (options.state !== null) {
    env[LAUNCH_ENV.harness] = '1';
    env[LAUNCH_ENV.harnessState] = options.state;
    args.push(`${HARNESS_ARGS.state}=${options.state}`);
    if (options.display) args.push(`${HARNESS_ARGS.display}=${options.display}`);
    if (options.theme) args.push(`${HARNESS_ARGS.theme}=${options.theme}`);
    if (options.show) args.push(HARNESS_ARGS.show);
    if (options.workArea) {
      const { x, y, width, height } = options.workArea;
      env[LAUNCH_ENV.fakeWorkArea] = `${x},${y},${width},${height}`;
    }
  }
  Object.assign(env, options.env ?? {});
  args.push(...(options.args ?? []));

  let electron: ElectronApplication;
  try {
    electron = await _electron.launch({
      executablePath: electronBinary(),
      args,
      env,
      cwd: APP_DIR,
      timeout: 30_000,
      // Playwright emulates `prefers-color-scheme: light` by default; the app's own theme
      // (`nativeTheme.themeSource`, forced by `--harness-theme`) must drive it instead.
      colorScheme: null,
    });
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
  const pages = new Map<WindowKind, Promise<Page>>();

  const launched: LaunchedApp = {
    electron,
    options,
    scaleFactor,
    userDataDir,
    harness: callHarness(electron),
    page(kind) {
      let page = pages.get(kind);
      if (!page) {
        page = findPage(electron, kind);
        pages.set(kind, page);
        page.catch(() => pages.delete(kind));
      }
      return page;
    },
    async close() {
      // «Salir» runs `core.shutdown`; a hung app must not hang the suite.
      await Promise.race([
        electron.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
      try {
        electron.process().kill('SIGKILL');
      } catch {
        // already gone
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows may still hold a file of the killed process; the OS temp cleanup gets it.
      }
    },
  };

  if (options.state !== null) {
    const main = await launched.page('main');
    await waitHarnessReady(main, options.state);
  }
  return launched;
}

/** `<html data-harness-ready="<id>">`: the renderer drew that fixture (useReadySignal). */
export async function waitHarnessReady(page: Page, stateId: string): Promise<void> {
  await page.waitForFunction(
    (id) => document.documentElement.dataset['harnessReady'] === id,
    stateId,
    { timeout: 15_000 },
  );
}

/**
 * Moves the harness's frozen clock by `ms` in steps of at most `stepMs`, letting the fake
 * guardian answer between steps. One big `advance()` runs every due timer synchronously, so
 * a request made inside it times out (3 s) before its answer is processed and the link goes
 * down; steps under the 3 s request timeout behave like real time passing.
 */
export async function advanceInSteps(app: LaunchedApp, ms: number, stepMs = 1_000): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    await app.harness.advance(step);
    left -= step;
  }
}
