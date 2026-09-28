/**
 * App-shell constants. `APP_ID` equals electron-builder's `appId`: Windows groups the
 * taskbar and routes notifications by it (`app.setAppUserModelId`, before `ready`).
 */
import type { GuideId } from '../../shared/ipc';

export const APP_ID = 'io.github.imdlodoem23.centrate';

/** Budget for «Salir»: waiting extensions are sent within it (docs/DESKTOP.md §8.1). */
export const QUIT_BUDGET_MS = 1_500;

/** Detail window pre-warm delay after the main window is ready. */
export const DETAIL_PREWARM_DELAY_MS = 1_000;

/** Harness: how long `load` / `openDetail` wait for the renderers' `window:ready`. */
export const HARNESS_READY_TIMEOUT_MS = 10_000;

/**
 * Fixed pages «Instalar…» opens (no URL ever crosses IPC). The web's download page has the
 * step-by-step extension guide, incognito included (docs/web/copy.md «Descargar»).
 */
const DOWNLOAD_PAGE = 'https://centrate.onrender.com/descargar';

export const GUIDE_URLS: Readonly<Record<GuideId, string>> = Object.freeze({
  'extension-chromium': `${DOWNLOAD_PAGE}#extension`,
  'extension-firefox': `${DOWNLOAD_PAGE}#extension`,
  'extension-incognito': `${DOWNLOAD_PAGE}#extension`,
});
