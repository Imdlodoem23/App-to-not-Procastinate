/**
 * Every **send** channel (renderer → main, fire-and-forget; docs/DESKTOP.md §4.2). Invoke
 * channels are MAIN-GUARDIAN's `registerIpcHandlers`.
 *
 * Each message is dropped unless its sender is one of our windows showing our document
 * (`WindowHost.windowOf`) and its payload passes `SEND_GUARDS`. The window kind always comes
 * from the sender, never from the payload.
 */
import { ipcMain, type IpcMainEvent } from 'electron';
import type { Core } from '../contracts';
import {
  SEND_CHANNELS,
  type GuideId,
  type SendChannel,
  type SendHandlers,
  type SendPayload,
} from '../../shared/ipc';
import { phase5SendStubs } from '../../shared/phase5-stubs';
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
    // Phase 5 surfaces report readiness to PLATFORM's windows (not registered yet).
    'window:ready': (payload, ctx) => {
      if (ctx.window === 'main' || ctx.window === 'detail') {
        shell.markReady(ctx.window, payload.stateId);
      }
    },
    'window:hide': (_payload, ctx) => {
      if (ctx.window === 'main') shell.hideAll();
      else shell.closeDetail();
    },
    'window:open-detail': (request) => void shell.openDetail(request, { show: true }),
    'window:close-detail': () => shell.closeDetail(),
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
    // Phase 5 (docs/DESKTOP.md §15): PLATFORM routes these to `PlatformServices.sendHandlers`.
    ...phase5SendStubs(),
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
  window: 'main' | 'detail',
): void {
  const handler = handlers[channel] as (p: SendPayload<C>, ctx: { window: typeof window }) => void;
  handler(payload as SendPayload<C>, { window });
}
