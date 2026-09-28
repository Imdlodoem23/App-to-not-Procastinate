/**
 * Sandboxed preload (contextIsolation + sandbox): exposes only the typed `CentrateBridge`
 * as `window.centrate`. Channels outside the contract lists are refused here and again in
 * main; `ipcRenderer` itself never reaches the page. Generic over `src/shared/ipc.ts`, so
 * adding a channel never touches this file.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  BRIDGE_KEY,
  isInvokeChannel,
  isPushChannel,
  isSendChannel,
  type CentrateBridge,
  type InvokeChannel,
  type InvokeReq,
  type InvokeRes,
  type PushChannel,
  type PushPayload,
  type SendChannel,
  type SendPayload,
} from '../shared/ipc';

// Kept local (not `toPlatform` from ui-state.ts) so the preload bundle stays tiny: ipc.ts has
// no runtime imports, ui-state.ts pulls the guardian validators.
const platform =
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

const bridge: CentrateBridge = {
  platform,

  invoke<C extends InvokeChannel>(channel: C, req: InvokeReq<C>): Promise<InvokeRes<C>> {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`Unknown invoke channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, req) as Promise<InvokeRes<C>>;
  },

  send<C extends SendChannel>(channel: C, payload: SendPayload<C>): void {
    if (!isSendChannel(channel)) return;
    ipcRenderer.send(channel, payload);
  },

  on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): () => void {
    if (!isPushChannel(channel)) return () => undefined;
    const handler = (_event: IpcRendererEvent, payload: PushPayload<C>): void => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
