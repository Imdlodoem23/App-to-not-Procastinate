/**
 * Every **send** channel (renderer → main, fire-and-forget; docs/DESKTOP.md §4.2). Invoke
 * channels are MAIN-GUARDIAN's `registerIpcHandlers`.
 *
 * Each message is dropped unless its sender is one of our windows showing our document
 * (`WindowHost.windowOf`) and its payload passes `SEND_GUARDS`. The window kind always comes
 * from the sender, never from the payload.
 */
import { ipcMain, type IpcMainEvent } from 'electron';
import type { Core, PlatformServices } from '../contracts';
import {
  SEND_CHANNELS,
  type GuideId,
  type IpcContext,
  type SendChannel,
  type SendHandlers,
  type SendPayload,
} from '../../shared/ipc';
import { phase5SendStubs } from '../../shared/phase5-stubs';
import { isSurfaceKind, type SurfaceKind, type UiWindow } from '../../shared/ui-state';
import type { AppLog } from '../app/log';
import { logRendererError } from '../logs/logger';
import { SEND_GUARDS } from './send-guards';
import type { WindowShell } from './shell';

export interface WindowIpcOptions {
  shell: WindowShell;
  core: Core;
  log: AppLog;
  /** «Salir»: `app.quit()` (the bootstrap's `before-quit` flushes the core). */
  quit(): void;
  openGuide(guide: GuideId): void;
  /**
   * The main window's «Despierto» chip: pop up the «Mantener despierto» choices at this point
   * of the main window. Without it (tests) the message is ignored.
   */
  keepAwakeMenu?(anchor: { x: number; y: number }): void;
  /**
   * Phase 5 (docs/DESKTOP.md §15): the platform services take the new send channels and the
   * surfaces' readiness. Without them (tests) the new channels are ignored.
   */
  platform?: SurfaceIpc;
}

/** What the send channels need from PLATFORM's services. */
export interface SurfaceIpc {
  readonly sendHandlers: PlatformServices['sendHandlers'];
  /** `window:ready` from a surface window (several Nuclear windows share the kind). */
  markSurfaceReady(webContentsId: number, kind: SurfaceKind, stateId: string | null): void;
}

export function createSendHandlers(options: WindowIpcOptions): SendHandlers {
  const { shell, core } = options;
  return {
    'window:layout': (report, ctx) => {
      if (ctx.window === 'main') shell.applyLayout(report);
    },
    'window:show-ack': (payload, ctx) => {
      if (ctx.window === 'main' || ctx.window === 'detail') {
        shell.handleShowAck(payload.seq, payload.layout, ctx.window);
      }
    },
    // Surfaces report readiness to PLATFORM (`registerWindowIpc` routes it with the sender).
    'window:ready': (payload, ctx) => {
      if (ctx.window === 'main' || ctx.window === 'detail') {
        shell.markReady(ctx.window, payload.stateId);
      }
    },
    // Esc in a surface (mini timer, OSD, Nuclear) closes nothing.
    'window:hide': (_payload, ctx) => {
      if (ctx.window === 'main') shell.hideAll();
      else if (ctx.window === 'detail') shell.closeDetail();
    },
    'window:open-detail': (request) => void shell.openDetail(request, { show: true }),
    'window:close-detail': (_payload, ctx) => {
      if (ctx.window === 'main' || ctx.window === 'detail') shell.closeDetail();
    },
    'window:confirm-draft': ({ draft }) => {
      // The card must be in the renderer before it measures itself for the show.
      shell.sendCommand({ type: 'confirm-draft', draft });
      shell.showMain('command', false);
    },
    'block:create-dismiss': (payload, ctx) =>
      core.sendHandlers['block:create-dismiss'](payload, ctx),
    'app:open-guide': ({ guide }) => options.openGuide(guide),
    'app:quit': () => options.quit(),
    // MAIN-GUARDIAN's app log keeps only the first line and frames, scrubbed.
    'app:renderer-error': ({ message, stack }) => logRendererError(message, stack),
    'keep-awake:menu': (anchor, ctx) => {
      if (ctx.window === 'main') options.keepAwakeMenu?.(anchor);
    },
    // Phase 5 (docs/DESKTOP.md §15): PLATFORM's `PlatformServices.sendHandlers`.
    ...(options.platform?.sendHandlers ?? phase5SendStubs()),
  };
}

/** Registers every send channel on `ipcMain`; returns the unregister function. */
export function registerWindowIpc(options: WindowIpcOptions): () => void {
  const handlers = createSendHandlers(options);
  const listeners = new Map<SendChannel, (event: IpcMainEvent, payload: unknown) => void>();

  for (const channel of SEND_CHANNELS) {
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      const kind = options.shell.windowOf({
        webContentsId: event.sender.id,
        frameUrl: senderFrameUrl(event),
      });
      if (!kind) {
        options.log.warn('send_rejected_sender', { channel });
        return;
      }
      if (!SEND_GUARDS[channel](payload)) {
        options.log.warn('send_rejected_payload', { channel, window: kind });
        return;
      }
      if (channel === 'window:ready' && isSurfaceKind(kind)) {
        const ready = payload as SendPayload<'window:ready'>;
        options.platform?.markSurfaceReady(event.sender.id, kind, ready.stateId);
        return;
      }
      try {
        dispatch(handlers, channel, payload, kind);
      } catch (error) {
        options.log.error('send_handler_failed', { channel, message: String(error) });
      }
    };
    listeners.set(channel, listener);
    ipcMain.on(channel, listener);
  }

  return () => {
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  };
}

/** `senderFrame` is `null` (or throws on older builds) once the frame is gone. */
function senderFrameUrl(event: IpcMainEvent): string | null {
  try {
    return event.senderFrame?.url ?? null;
  } catch {
    return null;
  }
}

function dispatch<C extends SendChannel>(
  handlers: SendHandlers,
  channel: C,
  payload: unknown,
  window: UiWindow,
): void {
  const handler = handlers[channel] as (p: SendPayload<C>, ctx: IpcContext) => void;
  handler(payload as SendPayload<C>, { window });
}
