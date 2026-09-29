/**
 * Main-process entry: wires MAIN-GUARDIAN's core and invoke handlers into the app shell
 * (docs/DESKTOP.md §3.1, §8.1). Everything else lives in `app/`, `windows/` and `tray/`.
 */
import { startApp } from './app/bootstrap';
import { createCore } from './guardian/core';
import { registerIpcHandlers } from './ipc-handlers';

startApp({ createCore, registerIpcHandlers, mainDir: __dirname });
