/**
 * Typed IPC contract between the main process and the renderers (docs/DESKTOP.md §4).
 *
 * Three kinds of channel:
 * - **invoke** (renderer → main, awaited): `ipcRenderer.invoke` / `ipcMain.handle`. Every
 *   fallible call resolves to a `CommandResult` and never rejects (Electron flattens errors).
 * - **send** (renderer → main, fire-and-forget): window and app lifecycle.
 * - **push** (main → renderer): `webContents.send`. The snapshot is pushed whole, only when
 *   its `rev` changed; there is no per-second traffic in either direction.
 *
 * Rules: every payload is structured-cloneable plain data; main validates every payload
 * (`src/main/ipc-guards.ts`) and checks the sender frame before handling it; the guardian
 * token never appears in any channel. Adding a channel = one line in a contract interface +
 * one line in its channel record below (the typecheck enforces both), then a handler.
 *
 * Runtime-light on purpose: only type imports plus the channel lists, because the sandboxed
 * preload bundles this file.
 */
import type {
  BlockId,
  DailyLimit,
  EmergencyId,
  EmergencyUnlock,
  GuardianSettings,
  LimitId,
  PointsSummary,
  Schedule,
  ScheduleId,
} from '@centrate/shared/domain';
import type {
  ConfirmEmergencyResponse,
  CreateBlockRequest,
  DailyLimitInput,
  DeleteDataResponse,
  EmergencyPreviewResponse,
  PairingCodeResponse,
  RedeemRewardResponse,
  RewardsResponse,
  ScheduleInput,
  SettingsResponse,
} from '@centrate/shared/guardian-api';
import type {
  AchievementStatus,
  CameraTestOutcome,
  InstallOutcome,
  OsdRequest,
  PermissionOutcome,
  RunningProcess,
  SoundData,
  UpdaterState,
} from './platform';
import type { SoundId } from './prefs';
import type {
  CsvExportKind,
  CsvExportResult,
  EventLogPage,
  EventLogQuery,
  HeatmapQuery,
  StatsHeatmap,
  StatsOverview,
  StatsQuery,
} from './stats';
import type {
  BlockDraft,
  BlockTemplate,
  CommandResult,
  DetailLocalState,
  DetailRequest,
  IntentId,
  LayoutReport,
  MainLocalState,
  Platform,
  TemplateInput,
  UiPrefs,
  UiPrefsPatch,
  UiSnapshot,
  UiWindow,
  WindowLayout,
} from './ui-state';

/** `window.centrate` in every renderer (exposed by the preload with `contextBridge`). */
export const BRIDGE_KEY = 'centrate';

/** Why a window was shown (analytics-free: only changes focus behaviour). */
export type ShowReason =
  'launch' | 'tray' | 'tray-menu' | 'second-instance' | 'notification' | 'command' | 'harness';

/** Guides «Instalar…» opens; main maps each to a fixed URL (no URL crosses IPC). */
export const GUIDE_IDS = [
  'extension-chromium',
  'extension-firefox',
  'extension-incognito',
] as const;
export type GuideId = (typeof GUIDE_IDS)[number];

/** Renderer-local state a harness fixture imposes (initial load or in-place switch). */
export interface HarnessLoad {
  stateId: string;
  main: MainLocalState;
  detail: DetailLocalState;
}

/** `app:init`: everything a renderer needs for its first render. */
export interface InitPayload {
  window: UiWindow;
  platform: Platform;
  snapshot: UiSnapshot;
  layout: WindowLayout;
  /** Detail window: the view to show first (`null` in the main window). */
  detail: DetailRequest | null;
  visible: boolean;
  /** Harness mode only. */
  harness: HarnessLoad | null;
}

/** Commands main routes to the main window (tray menu, Bloqueos form). */
export type UiCommand =
  /** Focus «¿Qué quieres hacer?» (opens the field under an active block). */
  | { type: 'focus-field' }
  /** Tray «Bloqueo rápido ▸»: open the confirmation card for a template. */
  | { type: 'confirm-template'; templateId: string }
  /** Bloqueos «Bloquear…»: open the confirmation card with the form's draft. */
  | { type: 'confirm-draft'; draft: BlockDraft };

// ---------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------

/** renderer → main, awaited. `req: null` means no payload. */
export interface InvokeContract {
  /** First call of every renderer. The window kind comes from the sender, not the payload. */
  'app:init': { req: null; res: InitPayload };

  /** Create a block (POST /v1/blocks with `Idempotency-Key: intentId`, 3 s timeout). */
  'block:create': {
    req: { intentId: IntentId; request: CreateBlockRequest };
    res: CommandResult<{ blockId: BlockId }>;
  };
  /** «Reintentar»: resend the pending create with the same key. */
  'block:create-retry': { req: { intentId: IntentId }; res: CommandResult<{ blockId: BlockId }> };
  /** Queue an extension (sent after 5 s; clicks on the same block add up). */
  'block:extend': {
    req: { blockId: BlockId; addMinutes: number };
    res: CommandResult<{ entryId: string; commitAt: number }>;
  };
  /** «Deshacer»: only a `waiting` entry can be undone. */
  'block:extend-undo': { req: { entryId: string }; res: 'undone' | 'too_late' };
  /** Resend a `failed` extension with its original key. */
  'block:extend-retry': { req: { entryId: string }; res: CommandResult<null> };

  /** «Perderás 620 puntos y tu racha de 5 días». `null`: every eligible block. */
  'emergency:preview': {
    req: { blockIds: BlockId[] | null };
    res: CommandResult<EmergencyPreviewResponse>;
  };
  'emergency:request': {
    req: { intentId: IntentId; blockIds: BlockId[]; phrase: string };
    res: CommandResult<EmergencyUnlock>;
  };
  /** «Cancelar (recomendado)»: free. */
  'emergency:cancel': { req: { id: EmergencyId }; res: CommandResult<EmergencyUnlock> };
  /** «Desbloquear» (after the in-place «¿Seguro?»). */
  'emergency:confirm': {
    req: { intentId: IntentId; id: EmergencyId };
    res: CommandResult<ConfirmEmergencyResponse>;
  };

  'schedules:list': { req: null; res: CommandResult<Schedule[]> };
  /** Row switch in Bloqueos (PUT with the schedule's own fields and `enabled`). */
  'schedules:set-enabled': {
    req: { id: ScheduleId; enabled: boolean };
    res: CommandResult<Schedule>;
  };

  /** Bloqueos «Límites diarios»: GET /v1/limits (exact usage, creation order). */
  'limits:list': { req: null; res: CommandResult<DailyLimit[]> };
  /**
   * The main window's «Límite diario» card and Bloqueos «Nuevo límite» (POST /v1/limits,
   * `Idempotency-Key: intentId`). Applies at once.
   */
  'limits:create': {
    req: { intentId: IntentId; input: DailyLimitInput };
    res: CommandResult<DailyLimit>;
  };
  /**
   * Full replace (PUT): stricter parts apply at once, weaker ones wait 24 h in
   * `pendingChange`; re-sending the effective definition cancels a pending change.
   */
  'limits:update': { req: { id: LimitId; input: DailyLimitInput }; res: CommandResult<DailyLimit> };
  /** DELETE: never at once, a pending deletion (`pendingChange.definition: null`). */
  'limits:delete': { req: { id: LimitId }; res: CommandResult<DailyLimit> };

  'templates:save': { req: TemplateInput; res: CommandResult<BlockTemplate[]> };
  'templates:delete': { req: { id: string }; res: CommandResult<BlockTemplate[]> };
  /** Theme, autostart, default mode, last reason… (applied at once, no «Guardar»). */
  'prefs:set': { req: UiPrefsPatch; res: CommandResult<UiPrefs> };

  /** New 6-digit code (shown at 32 px, «Puerto: N» if not 47600). */
  'pairing:new-code': { req: null; res: CommandResult<PairingCodeResponse> };
  /** Main writes the clipboard itself; the text never crosses IPC. */
  'diagnostics:copy': { req: null; res: CommandResult<{ source: 'guardian' | 'fallback' }> };
  /** «Borrar todos mis datos» (`confirm` is what the user typed: BORRAR). */
  'data:delete': {
    req: { intentId: IntentId; confirm: string };
    res: CommandResult<DeleteDataResponse>;
  };
  /** «Reparar»: start (or reinstall) the guardian with fixed arguments and elevation. */
  'guardian:repair': {
    req: null;
    res: CommandResult<{ outcome: 'started' | 'cancelled' | 'unsupported' }>;
  };
  /** Running process names for the apps autocomplete in Bloqueos. */
  'system:process-names': { req: null; res: CommandResult<string[]> };

  // -------------------------------------------------------------------------------------
  // Phase 5 (docs/DESKTOP.md §15). Owners: PLATFORM implements every handler; the callers
  // are named per channel. `not_implemented` (501) answers until PLATFORM lands.
  // -------------------------------------------------------------------------------------

  /** Bloqueos «Nuevo horario» (POST /v1/schedules, `Idempotency-Key: intentId`). PLANNER. */
  'schedules:create': {
    req: { intentId: IntentId; input: ScheduleInput };
    res: CommandResult<Schedule>;
  };
  /** Full replace (PUT); 409 `schedule_in_progress` / `schedule_starting_soon`. PLANNER. */
  'schedules:update': {
    req: { id: ScheduleId; input: ScheduleInput };
    res: CommandResult<Schedule>;
  };
  /** DELETE; same guards as update. PLANNER. */
  'schedules:delete': { req: { id: ScheduleId }; res: CommandResult<null> };

  /** GET /v1/settings: effective settings plus the pending (24 h) weakening changes. SETUP, PLANNER. */
  'settings:get': { req: null; res: CommandResult<SettingsResponse> };
  /**
   * PUT /v1/settings with the **full** settings: strengthening changes apply at once, weakening
   * ones come back in `pending` with their `effectiveAt` («Se aplicará mañana a las 17:00»).
   * SETUP (goal, penalties, browsers), PLANNER (exam whitelist extras).
   */
  'settings:put': { req: { settings: GuardianSettings }; res: CommandResult<SettingsResponse> };

  /** GET /v1/rewards (the shop, `shortBy` → «Te faltan 40 puntos»). REWARDS. */
  'rewards:list': { req: null; res: CommandResult<RewardsResponse> };
  /** POST /v1/rewards/redeem after the in-place «¿Seguro?». REWARDS. */
  'rewards:redeem': {
    req: { intentId: IntentId; offerId: string };
    res: CommandResult<RedeemRewardResponse>;
  };

  /** GET /v1/points (fresh; `state.points` is the same summary from the last poll). REWARDS. */
  'points:summary': { req: null; res: CommandResult<PointsSummary> };
  /** The Logros grid from the local event log (opening it clears `progress.fresh`). REWARDS. */
  'achievements:list': { req: null; res: CommandResult<AchievementStatus[]> };

  /** Bars, totals, top targets and hours of one period. STATS. */
  'stats:overview': { req: StatsQuery; res: CommandResult<StatsOverview> };
  /** GitHub-style heatmap cells. STATS. */
  'stats:heatmap': { req: HeatmapQuery; res: CommandResult<StatsHeatmap> };
  /** One page of the event log, newest first. STATS. */
  'stats:events': { req: EventLogQuery; res: CommandResult<EventLogPage> };
  /** «Exportar CSV»: main shows the save dialog and writes the file. STATS, SETUP (Datos). */
  'stats:export-csv': { req: { kind: CsvExportKind }; res: CommandResult<CsvExportResult> };

  /** Running processes with their catalog app (apps autocomplete). PLANNER. */
  'system:processes': { req: null; res: CommandResult<RunningProcess[]> };

  /** macOS Screen Recording for the active-window layer. SETUP (Sistema), onboarding. */
  'activewin:request-permission': { req: null; res: CommandResult<{ outcome: PermissionOutcome }> };

  /** Check now. SETUP (Sistema). */
  'updater:check': { req: null; res: CommandResult<UpdaterState> };
  /** Download the available version. SETUP, SURFACES (footer). */
  'updater:download': { req: null; res: CommandResult<UpdaterState> };
  /** Quit and install a `ready` update (blocks stay: the guardian runs apart). SETUP, SURFACES. */
  'updater:install': { req: null; res: CommandResult<UpdaterState> };

  /** The WAV bytes of a concentration loop (read by main from resources/sounds/). PLANNER. */
  'sounds:load': { req: { sound: SoundId }; res: CommandResult<SoundData> };

  /**
   * Onboarding step 2 «Instalar»: install and start the guardian with elevation (the same
   * path as «Reparar»). Navigation and «Omitir» are `prefs:set { onboarding }`. SETUP.
   */
  'onboarding:install-guardian': { req: null; res: CommandResult<{ outcome: InstallOutcome }> };
  /** Onboarding step 4 placeholder: `unavailable` until Study Mode ships. SETUP. */
  'onboarding:test-camera': { req: null; res: CommandResult<{ outcome: CameraTestOutcome }> };
}

/** renderer → main, fire-and-forget. `null` means no payload. */
export interface SendContract {
  /** Measured content height and density; sent only when it changed. */
  'window:layout': LayoutReport;
  /** Answer to `ui:prepare-show` (synchronous render + measure while hidden). */
  'window:show-ack': { seq: number; layout: LayoutReport };
  /** Rendered after init or a harness load (Playwright waits on it). */
  'window:ready': { stateId: string | null; rev: number };
  /** Esc with nothing left to back out of. */
  'window:hide': null;
  /** Doors («Más…», «Ajustes…», «Desbloqueo de emergencia…», «y 3 más…»). */
  'window:open-detail': DetailRequest;
  'window:close-detail': null;
  /** Bloqueos «Bloquear…»: main focuses the main window and pushes `confirm-draft`. */
  'window:confirm-draft': { draft: BlockDraft };
  /** Esc on a failed «Bloqueando…» card: forget the pending create. */
  'block:create-dismiss': { intentId: IntentId };
  'app:open-guide': { guide: GuideId };
  /** «Salir» (flushes the extend queue first; blocks stay active). */
  'app:quit': null;
  'app:renderer-error': { message: string; stack: string | null };

  // Phase 5 (docs/DESKTOP.md §15); PLATFORM handles them.
  /** Footer «Mini temporizador», tray checkbox, shortcut. `visible: null` toggles. */
  'mini-timer:toggle': { visible: boolean | null };
  /** Keyboard nudge or «Recolocar» (`null`: back to the default corner); drags persist in main. */
  'mini-timer:position': { position: { x: number; y: number } | null };
  /** A renderer asks for the OSD (shown only when «Avisos grandes» is on). */
  'osd:show': OsdRequest;
  /** The Nuclear overlay's only button: open Emergencia above the overlay. */
  'nuclear:emergency-exit': null;
}

/** main → renderer. */
export interface PushContract {
  /** Whole snapshot, only when `rev` changed; also to hidden windows (cheap, keeps them current). */
  'ui:snapshot': UiSnapshot;
  /** Height budget changed (display metrics, fake display in the harness). */
  'ui:layout': WindowLayout;
  /** Shown / hidden / focused. `focusField`: put the caret in «¿Qué quieres hacer?». */
  'ui:visibility': {
    visible: boolean;
    focused: boolean;
    reason: ShowReason | null;
    focusField: boolean;
  };
  /** Before `show()`: render the latest snapshot synchronously, measure, answer `window:show-ack`. */
  'ui:prepare-show': { seq: number; layout: WindowLayout };
  /** Detail window: switch to this view (one reusable window). */
  'ui:detail': DetailRequest;
  'ui:command': UiCommand;
  /** Harness only: replace the renderer-local state with a fixture's. */
  'ui:harness': HarnessLoad;
}

// ---------------------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------------------

export type InvokeChannel = keyof InvokeContract;
export type SendChannel = keyof SendContract;
export type PushChannel = keyof PushContract;

export type InvokeReq<C extends InvokeChannel> = InvokeContract[C]['req'];
export type InvokeRes<C extends InvokeChannel> = InvokeContract[C]['res'];
export type SendPayload<C extends SendChannel> = SendContract[C];
export type PushPayload<C extends PushChannel> = PushContract[C];

/** Who sent a message (resolved by main from the sender's webContents, never from the payload). */
export interface IpcContext {
  window: UiWindow;
}

/** Main-side handler table for invoke channels (a missing channel fails the typecheck). */
export type InvokeHandlers = {
  [C in InvokeChannel]: (
    req: InvokeReq<C>,
    ctx: IpcContext,
  ) => InvokeRes<C> | Promise<InvokeRes<C>>;
};

/** Main-side handler table for send channels. */
export type SendHandlers = {
  [C in SendChannel]: (payload: SendPayload<C>, ctx: IpcContext) => void;
};

/**
 * The API the preload exposes as `window.centrate` (`BRIDGE_KEY`). Renderers use only
 * this; `ipcRenderer` itself is never exposed. `on` returns its unsubscribe function
 * (React StrictMode runs effects twice).
 */
export interface CentrateBridge {
  readonly platform: Platform;
  invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>>;
  send<C extends SendChannel>(channel: C, payload: SendPayload<C>): void;
  on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): () => void;
}

// ---------------------------------------------------------------------------------------
// Channel lists (preload allowlists and main registration). `satisfies` makes each record
// exhaustive and free of unknown keys, so a channel can never be declared but unregistered.
// ---------------------------------------------------------------------------------------

const INVOKE_RECORD = {
  'app:init': true,
  'block:create': true,
  'block:create-retry': true,
  'block:extend': true,
  'block:extend-undo': true,
  'block:extend-retry': true,
  'emergency:preview': true,
  'emergency:request': true,
  'emergency:cancel': true,
  'emergency:confirm': true,
  'schedules:list': true,
  'schedules:set-enabled': true,
  'limits:list': true,
  'limits:create': true,
  'limits:update': true,
  'limits:delete': true,
  'templates:save': true,
  'templates:delete': true,
  'prefs:set': true,
  'pairing:new-code': true,
  'diagnostics:copy': true,
  'data:delete': true,
  'guardian:repair': true,
  'system:process-names': true,
  'schedules:create': true,
  'schedules:update': true,
  'schedules:delete': true,
  'settings:get': true,
  'settings:put': true,
  'rewards:list': true,
  'rewards:redeem': true,
  'points:summary': true,
  'achievements:list': true,
  'stats:overview': true,
  'stats:heatmap': true,
  'stats:events': true,
  'stats:export-csv': true,
  'system:processes': true,
  'activewin:request-permission': true,
  'updater:check': true,
  'updater:download': true,
  'updater:install': true,
  'sounds:load': true,
  'onboarding:install-guardian': true,
  'onboarding:test-camera': true,
} as const satisfies Record<InvokeChannel, true>;

const SEND_RECORD = {
  'window:layout': true,
  'window:show-ack': true,
  'window:ready': true,
  'window:hide': true,
  'window:open-detail': true,
  'window:close-detail': true,
  'window:confirm-draft': true,
  'block:create-dismiss': true,
  'app:open-guide': true,
  'app:quit': true,
  'app:renderer-error': true,
  'mini-timer:toggle': true,
  'mini-timer:position': true,
  'osd:show': true,
  'nuclear:emergency-exit': true,
} as const satisfies Record<SendChannel, true>;

const PUSH_RECORD = {
  'ui:snapshot': true,
  'ui:layout': true,
  'ui:visibility': true,
  'ui:prepare-show': true,
  'ui:detail': true,
  'ui:command': true,
  'ui:harness': true,
} as const satisfies Record<PushChannel, true>;

export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.freeze(
  Object.keys(INVOKE_RECORD) as InvokeChannel[],
);
export const SEND_CHANNELS: readonly SendChannel[] = Object.freeze(
  Object.keys(SEND_RECORD) as SendChannel[],
);
export const PUSH_CHANNELS: readonly PushChannel[] = Object.freeze(
  Object.keys(PUSH_RECORD) as PushChannel[],
);

/** The Phase 5 invoke channels (stubbed with `not_implemented` until PLATFORM lands). */
export const PHASE5_INVOKE_CHANNELS = [
  'schedules:create',
  'schedules:update',
  'schedules:delete',
  'settings:get',
  'settings:put',
  'rewards:list',
  'rewards:redeem',
  'points:summary',
  'achievements:list',
  'stats:overview',
  'stats:heatmap',
  'stats:events',
  'stats:export-csv',
  'system:processes',
  'activewin:request-permission',
  'updater:check',
  'updater:download',
  'updater:install',
  'sounds:load',
  'onboarding:install-guardian',
  'onboarding:test-camera',
] as const satisfies readonly InvokeChannel[];
export type Phase5InvokeChannel = (typeof PHASE5_INVOKE_CHANNELS)[number];

/** The Phase 5 send channels (PLATFORM's handlers in `src/main/windows/ipc-window.ts`). */
export const PHASE5_SEND_CHANNELS = [
  'mini-timer:toggle',
  'mini-timer:position',
  'osd:show',
  'nuclear:emergency-exit',
] as const satisfies readonly SendChannel[];
export type Phase5SendChannel = (typeof PHASE5_SEND_CHANNELS)[number];

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && Object.hasOwn(INVOKE_RECORD, value);
}

export function isSendChannel(value: unknown): value is SendChannel {
  return typeof value === 'string' && Object.hasOwn(SEND_RECORD, value);
}

export function isPushChannel(value: unknown): value is PushChannel {
  return typeof value === 'string' && Object.hasOwn(PUSH_RECORD, value);
}
