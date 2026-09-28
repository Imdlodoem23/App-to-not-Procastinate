/**
 * Registers every invoke channel of `src/shared/ipc.ts` (docs/DESKTOP.md §3.1, §4.1):
 *
 * 1. the sender must be one of our windows showing the app URL (`WindowHost.windowOf`),
 *    otherwise the call is rejected;
 * 2. the payload must pass its guard (`ipc-guards.ts`): a fallible channel answers a bad
 *    payload with `fail(rejected / validation_failed / 422)`;
 * 3. `app:init` gets `{ ...host.initPayload(window), snapshot }`; every other channel goes to
 *    `core.handlers`;
 * 4. no exception escapes a `CommandResult` channel.
 *
 * Returns a function that removes every handler.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  INVOKE_CHANNELS,
  type InvokeChannel,
  type InvokeHandlers,
  type InvokeReq,
  type InvokeRes,
} from '../shared/ipc';
import { fail, toUiError, uiError } from '../shared/ui-state';
import type { Core, IpcSenderInfo, WindowHost } from './contracts';
import { NON_RESULT_CHANNELS, isValidInvokePayload } from './ipc-guards';
import { appLog } from './logs/logger';

/** Thrown to the renderer (Electron turns it into a rejected `invoke`). */
export class UntrustedSenderError extends Error {
  constructor(channel: string) {
    super(`untrusted sender for ${channel}`);
    this.name = 'UntrustedSenderError';
  }
}

/** Handles one invoke (pure apart from the core and host it is given). */
export async function dispatchInvoke<C extends InvokeChannel>(
  core: Core,
  host: WindowHost,
  channel: C,
  sender: IpcSenderInfo,
  req: unknown,
): Promise<InvokeRes<C>> {
  const window = host.windowOf(sender);
  if (window === null) {
    appLog().warn('ipc_untrusted_sender', { channel });
    throw new UntrustedSenderError(channel);
  }
  if (!isValidInvokePayload(channel, req)) {
    appLog().warn('ipc_bad_payload', { channel });
    if (channel === 'block:extend-undo') return 'too_late' as InvokeRes<C>;
    if (!NON_RESULT_CHANNELS.has(channel)) {
      return fail(uiError('rejected', 'validation_failed', 422)) as InvokeRes<C>;
    }
    // app:init takes no payload: ignore whatever came.
  }
  const ctx = { window };
  if (channel === 'app:init') {
    return { ...host.initPayload(window), snapshot: core.getSnapshot() } as InvokeRes<C>;
  }
  const handler = (core.handlers as Omit<InvokeHandlers, 'app:init'>)[
    channel as Exclude<InvokeChannel, 'app:init'>
  ] as unknown as (
    req: InvokeReq<C>,
    ctx: { window: typeof window },
  ) => InvokeRes<C> | Promise<InvokeRes<C>>;
  try {
    return await handler(req as InvokeReq<C>, ctx);
  } catch (error) {
    const e = toUiError(error);
    appLog().error('ipc_handler_threw', { channel, kind: e.kind, code: e.code });
    if (channel === 'block:extend-undo') return 'too_late' as InvokeRes<C>;
    return fail(e) as InvokeRes<C>;
  }
}

export function registerIpcHandlers(core: Core, host: WindowHost): () => void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, req: unknown) =>
      dispatchInvoke(
        core,
        host,
        channel,
        { webContentsId: event.sender.id, frameUrl: event.senderFrame?.url ?? null },
        req,
      ),
    );
  }
  return () => {
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
  };
}
