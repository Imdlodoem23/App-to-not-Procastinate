/**
 * Contracts between the main-process owners (docs/DESKTOP.md §3.1), types and constants
 * only, no `electron` import (the e2e tests import it too):
 *
 * - MAIN-GUARDIAN implements `Core` (`createCore` in `src/main/guardian/core.ts`) and
 *   `registerIpcHandlers` (`src/main/ipc-handlers.ts`).
 * - MAIN-WINDOW implements `CoreHost` and `WindowHost` (`src/main/windows/**`), wires
 *   everything in `src/main/index.ts` and installs `HarnessApi` in harness mode.
 * - HARNESS drives `HarnessApi` from Playwright (`electronApp.evaluate`).
 * - Phase 5 (docs/DESKTOP.md §15): PLATFORM implements `PlatformServices` (mini timer, OSD,
 *   Nuclear overlay, updater, shortcuts, reminders, active window) and publishes their state
 *   through `Core.patchSnapshot`; it also replaces the core's Phase 5 stub handlers.
 *
 * Changing this file is a lead decision: every owner compiles against it.
 */
import type { Locale } from '../shared/i18n/locale';
import type { ThemeName } from '@centrate/shared/design/tokens';
import type { GuardianClient } from '@centrate/shared/guardian-api';
import type { FeatureFlags } from '../shared/features';
import type { DisplayPresetId, HarnessFixture, HarnessStateId, Rect } from '../shared/fixtures';
import type {
  InitPayload,
  InvokeHandlers,
  Phase5SendChannel,
  SendHandlers,
  ShowReason,
} from '../shared/ipc';
import type {
  DetailName,
  Platform,
  PlatformSnapshotPatch,
  SurfaceKind,
  UiSnapshot,
  UiWindow,
} from '../shared/ui-state';

// ---------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Injected everywhere in main: the system clock, or the harness's frozen clock. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------------------
// Core (MAIN-GUARDIAN)
// ---------------------------------------------------------------------------------------

export type RefreshReason =
  'start' | 'show' | 'poll' | 'event' | 'write' | 'resume' | 'block-end' | 'retry' | 'harness';

/** What the core needs from the app shell (MAIN-WINDOW implements it). */
export interface CoreHost {
  /** Any Céntrate window visible (2 s poll) and whether the main window has focus. */
  visibility(): { anyVisible: boolean; mainFocused: boolean };
  /** Notification click and similar. */
  showMain(reason: ShowReason): void;
  /** Electron `clipboard.writeText` («Copiar diagnóstico»). */
  writeClipboard(text: string): void;
}

/** The OS's input idleness (Electron `powerMonitor`); daily-limit usage counts only while present. */
export interface IdleSource {
  /** Seconds since the last keyboard or mouse input. */
  idleSeconds(): number;
  /** The screen is locked. */
  locked(): boolean;
}

/**
 * A daily limit's alert for the OSD («Te quedan 5 min de YouTube hoy», «Has gastado tus 30
 * min de YouTube de hoy»), from `limit_warning` / `limit_reached` events.
 */
export interface LimitAlert {
  kind: 'warning' | 'reached';
  text: string;
}

export interface CoreOptions {
  platform: Platform;
  appVersion: string;
  packaged: boolean;
  /** `app.getPath('userData')`, or `CENTRATE_USER_DATA` when unpackaged. */
  userDataDir: string;
  /** Guardian system directory holding `client.json` (`CENTRATE_DATA_DIR`, the guardian's own test override, only when unpackaged). */
  sysDir: string;
  /** Bundled guardian executable («Reparar», diagnostics fallback); `null` when absent. */
  guardianBinary: string | null;
  clock: Clock;
  features: FeatureFlags;
  /** The OS language as an app locale (`app.getPreferredSystemLanguages()`); default `es`. */
  systemLocale?: Locale;
  /** Harness mode: `FakeGuardianClient` and the frozen clock come from this fixture. */
  harness: HarnessFixture | null;
  host: CoreHost;
  /** `powerMonitor` (daily-limit usage); absent in tests (every second counts). */
  idle?: IdleSource;
}

/**
 * The app's state and guardian I/O: snapshot store, poller, event sync, create and extend
 * operations, notifications, local DB, prefs and templates.
 */
export interface Core {
  /** Synchronous and valid right after `createCore` (prefs are read before any window). */
  getSnapshot(): UiSnapshot;
  /** Called after every `rev` change (microtask-coalesced). */
  subscribe(listener: (snapshot: UiSnapshot) => void): () => void;
  /**
   * Every invoke channel except `app:init` (which `registerIpcHandlers` answers). The Phase 5
   * ones start as `phase5InvokeStubs` (`src/shared/phase5-stubs.ts`) until PLATFORM overrides them.
   */
  readonly handlers: Omit<InvokeHandlers, 'app:init'>;
  /** Send channels that belong to the core. */
  readonly sendHandlers: Pick<SendHandlers, 'block:create-dismiss'>;
  start(): void;
  /** `CoreHost.visibility()` changed: poll cadence and notification suppression follow. */
  visibilityChanged(): void;
  refreshNow(reason: RefreshReason): void;
  /**
   * Phase 5: publish main-owned platform state (progress, updater, active window, shortcuts,
   * OSD, Nuclear, `app.updateVersion`) in the snapshot; a new `rev` only when something changed.
   */
  patchSnapshot(patch: PlatformSnapshotPatch): void;
  /**
   * Daily-limit alerts from fresh events (PLATFORM shows them in the OSD when «Avisos
   * grandes» is on); returns the unsubscribe function.
   */
  onLimitAlert(listener: (alert: LimitAlert) => void): () => void;
  /** «Salir»: send waiting extensions now (within `budgetMs`), stop timers, close the DB. */
  shutdown(budgetMs: number): Promise<void>;
  /** Present only in harness mode. */
  readonly harness: CoreHarness | null;
}

export type CreateCore = (options: CoreOptions) => Core;

export interface CoreHarness {
  /** Replace store, fake guardian and clock with a fixture's (then publish). */
  load(fixture: HarnessFixture): void;
  /** Move the frozen clock and run the timers that became due. */
  advance(ms: number): void;
  guardianCalls(): RecordedGuardianCall[];
  notifications(): ShownNotification[];
}

export interface RecordedGuardianCall {
  at: number;
  method: keyof GuardianClient;
  idempotencyKey: string | null;
  body: unknown;
}

export interface ShownNotification {
  at: number;
  title: string;
  body: string;
  /** Notice kinds grouped into it (`block_started`, `attempt`…). */
  kinds: string[];
}

// ---------------------------------------------------------------------------------------
// Windows (MAIN-WINDOW)
// ---------------------------------------------------------------------------------------

/** Structural view of an IPC event's sender (no Electron types here). */
export interface IpcSenderInfo {
  webContentsId: number;
  /** `event.senderFrame?.url`; `null` when the frame is gone. */
  frameUrl: string | null;
}

/**
 * Implemented by MAIN-WINDOW, used by `registerIpcHandlers`. Phase 5 surfaces (mini timer, OSD,
 * Nuclear) are PLATFORM's windows: its registration makes `windowOf` and `initPayload` know them.
 */
export interface WindowHost {
  /** The trusted window a sender belongs to (registry + app URL check), else `null` (reject). */
  windowOf(sender: IpcSenderInfo): UiWindow | null;
  /** `app:init` for that window; `registerIpcHandlers` adds the current snapshot. */
  initPayload(window: UiWindow): Omit<InitPayload, 'snapshot'>;
}

// ---------------------------------------------------------------------------------------
// Platform services (PLATFORM, Phase 5)
// ---------------------------------------------------------------------------------------

/**
 * PLATFORM's services (`src/main/{activewin,updater,reminders,shortcuts}/**` and
 * `src/main/windows/{mini-timer,osd,nuclear}*.ts`), created by the bootstrap after the core and
 * the shell. They read the snapshot (`core.subscribe`) and publish their state with
 * `core.patchSnapshot`; renderers only ever see the snapshot.
 */
export interface PlatformServices {
  /** The Phase 5 send channels (`src/main/windows/ipc-window.ts` routes them here). */
  readonly sendHandlers: Pick<SendHandlers, Phase5SendChannel>;
  /** After `core.start()`: surfaces, shortcuts, reminders, updater checks, active window. */
  start(): void;
  /** Harness `load`: reflect the fixture (show its surface, stop real timers). */
  harnessLoad(fixture: HarnessFixture): Promise<void>;
  /** Before quit: unregister shortcuts, close the surfaces, stop timers. */
  dispose(): void;
}

/** Serialisable tray menu (built into an Electron `Menu` by MAIN-WINDOW; asserted by e2e). */
export interface TrayMenuItemModel {
  id: string;
  label: string;
  type: 'normal' | 'separator' | 'checkbox' | 'submenu';
  enabled: boolean;
  checked: boolean;
  submenu: TrayMenuItemModel[];
}

// ---------------------------------------------------------------------------------------
// Harness (MAIN-WINDOW installs it, HARNESS drives it)
// ---------------------------------------------------------------------------------------

/** `globalThis[HARNESS_GLOBAL]` in the main process, harness mode only. */
export const HARNESS_GLOBAL = '__centrateHarness';

/**
 * Launch switches, honoured only when `!app.isPackaged`:
 * `electron out/main/index.js --harness-state=idle --harness-display=1366x768@125 --harness-theme=dark`.
 */
export const HARNESS_ARGS = Object.freeze({
  state: '--harness-state',
  display: '--harness-display',
  theme: '--harness-theme',
  /** `es` or `en`: the language the fake OS reports («Idioma: Sistema» follows it). */
  lang: '--harness-lang',
  /** Start with the main window shown (screenshots); otherwise it starts hidden like `--hidden`. */
  show: '--harness-show',
});

/** Environment overrides, honoured only when `!app.isPackaged`. */
export const HARNESS_ENV = Object.freeze({
  /** Isolated `userData` (prefs.json, centrate.sqlite, logs) per e2e run. */
  userData: 'CENTRATE_USER_DATA',
  /** Guardian system directory (client.json) for wire tests against a mock guardian. */
  sysDir: 'CENTRATE_DATA_DIR',
});

export interface WindowBoundsReport {
  display: { bounds: Rect; workArea: Rect; scaleFactor: number };
  main: { outer: Rect; content: Rect; visible: boolean } | null;
  detail: { outer: Rect; content: Rect; visible: boolean } | null;
}

export interface HarnessApi {
  states(): readonly HarnessStateId[];
  /**
   * Load a fixture into the running app (store, fake guardian, clock, renderer-local state,
   * fake display, theme). Resolves once every open window answered `window:ready` for it.
   */
  load(
    id: HarnessStateId,
    options?: { theme?: ThemeName; display?: DisplayPresetId; lang?: Locale },
  ): Promise<void>;
  /** Tray-click show path; resolves with ms from the call to the field having focus. */
  showMain(): Promise<number>;
  hideMain(): void;
  /** Open (or retarget) the detail window like a door would (`main`: nothing to open). */
  openDetail(name: 'main' | DetailName): Promise<void>;
  /**
   * Phase 5: show a surface (mini timer, OSD, Nuclear overlay) with the current snapshot and
   * resolve once it rendered. PLATFORM implements it with its windows.
   */
  openSurface(kind: SurfaceKind): Promise<void>;
  /** Advance the frozen clock; resolves after the resulting publish reached the renderers. */
  advance(ms: number): Promise<void>;
  trayClick(): void;
  trayMenu(): TrayMenuItemModel[];
  clickTrayItem(id: string): void;
  trayTooltip(): string;
  /**
   * The last «Mantener despierto» popup the footer chip asked for (recorded, never shown in
   * harness mode); its items are clicked with `clickTrayItem` (same ids). `null`: none yet.
   */
  keepAwakeMenu(): TrayMenuItemModel[] | null;
  /** The app holds the display blocker («Mantener también la pantalla encendida»). */
  keepAwakeDisplay(): boolean;
  windowTitle(): string;
  bounds(): WindowBoundsReport;
  snapshot(): UiSnapshot;
  guardianCalls(): RecordedGuardianCall[];
  notifications(): ShownNotification[];
}
