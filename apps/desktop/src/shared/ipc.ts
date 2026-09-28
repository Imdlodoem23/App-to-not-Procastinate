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
  EmergencyId,
  EmergencyUnlock,
  Schedule,
  ScheduleId,
} from '@centrate/shared/domain';
import type {
  ConfirmEmergencyResponse,
  CreateBlockRequest,
  DeleteDataResponse,
  EmergencyPreviewResponse,
  PairingCodeResponse,
} from '@centrate/shared/guardian-api';
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
  WindowKind,
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
  window: WindowKind;
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
  window: WindowKind;
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
  'templates:save': true,
  'templates:delete': true,
  'prefs:set': true,
  'pairing:new-code': true,
  'diagnostics:copy': true,
  'data:delete': true,
  'guardian:repair': true,
  'system:process-names': true,
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

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && Object.hasOwn(INVOKE_RECORD, value);
}

export function isSendChannel(value: unknown): value is SendChannel {
  return typeof value === 'string' && Object.hasOwn(SEND_RECORD, value);
}

export function isPushChannel(value: unknown): value is PushChannel {
  return typeof value === 'string' && Object.hasOwn(PUSH_RECORD, value);
}
