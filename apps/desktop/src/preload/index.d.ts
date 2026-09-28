import type { CentrateBridge } from '../shared/ipc';

declare global {
  interface Window {
    /**
     * Exposed by the preload in Electron. Absent in the browser harness (`vite dev` with
     * `?state=`), where the renderer builds an in-memory bridge instead.
     */
    centrate?: CentrateBridge;
  }
}

export {};
