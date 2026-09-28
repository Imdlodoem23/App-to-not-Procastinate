/**
 * Harness mode (docs/DESKTOP.md §10): the launch fixture, the fake display and
 * `globalThis.__centrateHarness` (`HarnessApi` in `contracts.ts`), what Playwright drives
 * through `electronApp.evaluate`. The bootstrap imports this module lazily, and only for an
 * unpackaged app started with a harness switch, so fixtures never load in a release.
 */
import type { ThemeName } from '@centrate/shared/design/tokens';
import {
  HARNESS_GLOBAL,
  type Core,
  type CoreHarness,
  type HarnessApi,
  type ShownNotification,
} from '../contracts';
import {
  DISPLAY_PRESET_IDS,
  HARNESS_STATE_IDS,
  harnessFixture,
  harnessLoad,
  isHarnessStateId,
  type DisplayPresetId,
  type HarnessFixture,
  type HarnessStateId,
} from '../../shared/fixtures';
import type { HarnessLoad } from '../../shared/ipc';
import type { DetailName, DetailRequest } from '../../shared/ui-state';
import type { TrayController } from '../tray/controller';
import { fakeDisplaySource, type FakeDisplaySource } from '../windows/fake-display';
import type { WindowShell } from '../windows/shell';
import { HARNESS_READY_TIMEOUT_MS } from './constants';
import type { HarnessLaunch } from './launch-options';
import type { ThemeController } from './theme';

export interface ResolvedHarness {
  fixture: HarnessFixture;
  displays: FakeDisplaySource;
  customWorkArea: boolean;
  problems: string[];
}

function isDisplayPresetId(value: string): value is DisplayPresetId {
  return (DISPLAY_PRESET_IDS as readonly string[]).includes(value);
}

/** Checks the launch switches against the fixtures and builds the fixture and fake display. */
export function resolveHarness(launch: HarnessLaunch): ResolvedHarness {
  const problems: string[] = [];
  let stateId: HarnessStateId = 'idle';
  if (isHarnessStateId(launch.stateId)) stateId = launch.stateId;
  else problems.push(`unknown harness state "${launch.stateId}", using "idle"`);
  const fixture = harnessFixture(stateId);
  let preset: DisplayPresetId = fixture.display;
  if (launch.display !== null) {
    if (isDisplayPresetId(launch.display)) preset = launch.display;
    else problems.push(`unknown display preset "${launch.display}", using "${preset}"`);
  }
  return {
    fixture,
    displays: fakeDisplaySource({ preset, workArea: launch.fakeWorkArea }),
    customWorkArea: launch.fakeWorkArea !== null,
    problems,
  };
}

export interface HarnessDeps {
  core: Core;
  shell: WindowShell;
  tray: TrayController;
  theme: ThemeController;
  displays: FakeDisplaySource;
  /** The fixture the app was launched with. */
  initial: HarnessFixture;
  /** `CENTRATE_FAKE_WORKAREA`: kept across loads unless a preset is asked for explicitly. */
  customWorkArea: boolean;
}

/** What renderers receive in `app:init` for the launch fixture. */
export function initialHarnessLoad(resolved: ResolvedHarness): HarnessLoad {
  return harnessLoad(resolved.fixture);
}

function coreHarness(core: Core): CoreHarness {
  if (!core.harness) throw new Error('the core was not created in harness mode');
  return core.harness;
}

/** The request a door would send, for `openDetail(name)` outside a detail fixture. */
export function defaultDetailRequest(name: DetailName): DetailRequest {
  switch (name) {
    case 'bloqueos':
      return { name, seed: null, focus: null };
    case 'emergencia':
      return { name, blockIds: null };
    case 'ajustes':
      return { name, group: null };
  }
}

const FOCUS_PROBE = `new Promise((resolve) => {
  const ok = () => document.activeElement !== null && document.activeElement !== document.body;
  if (ok()) { resolve(true); return; }
  const timer = setTimeout(() => resolve(ok()), 1000);
  document.addEventListener('focusin', () => { clearTimeout(timer); resolve(true); }, { once: true });
})`;

export function createHarnessApi(deps: HarnessDeps): HarnessApi {
  const { core, shell, tray, theme, displays } = deps;
  let fixture = deps.initial;

  const detailFor = (name: DetailName): DetailRequest =>
    fixture.window === name && fixture.detailRequest
      ? fixture.detailRequest
      : defaultDetailRequest(name);

  const api: HarnessApi = {
    states: () => HARNESS_STATE_IDS,

    async load(id: HarnessStateId, options: { theme?: ThemeName; display?: DisplayPresetId } = {}) {
      fixture = harnessFixture(id);
      if (options.theme) theme.setOverride(options.theme);
      const current = displays.spec();
      if (options.display) displays.set({ preset: options.display, workArea: null });
      else if (!deps.customWorkArea) displays.set({ preset: fixture.display, workArea: null });
      else displays.set({ preset: current.preset, workArea: current.workArea });

      const load = harnessLoad(fixture);
      shell.setHarnessLoad(load);
      shell.resetReady();
      coreHarness(core).load(fixture);
      shell.pushAll('ui:harness', load);
      if (fixture.window !== 'main' && fixture.detailRequest) {
        shell.openDetail(fixture.detailRequest);
      } else {
        shell.closeDetail();
      }
      await shell.waitReady(id, HARNESS_READY_TIMEOUT_MS);
    },

    async showMain() {
      const main = shell.window('main');
      if (!main) throw new Error('no main window');
      const t0 = performance.now();
      await shell.show('harness', { focusField: true });
      const focused = (await main.webContents.executeJavaScript(FOCUS_PROBE, true)) as boolean;
      const ms = performance.now() - t0;
      if (!focused) throw new Error(`nothing in the main window took focus (${Math.round(ms)} ms)`);
      return ms;
    },

    hideMain: () => shell.hideAll(),

    async openDetail(name) {
      if (name === 'main') return;
      if (!shell.window('main')?.isVisible()) await shell.show('harness', { focusField: false });
      shell.openDetail(detailFor(name), { show: true });
      await shell.flushRenderers();
    },

    async advance(ms: number) {
      coreHarness(core).advance(ms);
      await shell.flushRenderers();
    },

    trayClick: () => {
      shell.toggleFromTray();
    },
    trayMenu: () => tray.currentMenu(),
    clickTrayItem: (id: string) => tray.dispatch(id),
    trayTooltip: () => tray.tooltip(),
    windowTitle: () => shell.mainTitle(),
    bounds: () => shell.bounds(),
    snapshot: () => core.getSnapshot(),
    guardianCalls: () => coreHarness(core).guardianCalls(),
    notifications: (): ShownNotification[] =>
      [...coreHarness(core).notifications(), ...shell.shownNotifications()].sort(
        (a, b) => a.at - b.at,
      ),
  };
  return api;
}

export function installHarnessApi(api: HarnessApi): void {
  (globalThis as Record<string, unknown>)[HARNESS_GLOBAL] = api;
}
