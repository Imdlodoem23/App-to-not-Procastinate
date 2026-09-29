/**
 * Session and web-contents hardening (docs/DESKTOP.md §11). Installed once, before any
 * window exists. Renderers are sandboxed, context-isolated and Node-free; on top of that:
 * every permission is denied, no `file:` request leaves the renderer folder (so no renderer
 * reads `<sys>/client.json` and its token, or any user file), no window can open another,
 * nothing navigates away from the app document and no `<webview>` can attach.
 */
import { app, session, type WebContents } from 'electron';
import type { Platform } from '../../shared/ui-state';
import { isAllowedFileRequest } from './file-guard';
import type { AppLog } from './log';

export interface HardenOptions {
  devTools: boolean;
  log: AppLog;
  platform: Platform;
  /** Folder of the renderer document (`out/renderer`); `null` when served by the dev server. */
  rendererDir: string | null;
}

export function hardenSessions(options: HardenOptions): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    options.log.warn('permission_denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  // Every request (no URL filter to get wrong): only `file:` ones are ever refused.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedFileRequest(details.url, options.rendererDir, options.platform);
    if (!allowed) options.log.warn('file_request_blocked', { type: details.resourceType });
    callback({ cancel: !allowed });
  });

  app.on('web-contents-created', (_event, contents) => hardenContents(contents, options));
}

function hardenContents(contents: WebContents, options: HardenOptions): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    options.log.warn('navigation_blocked', { scheme: safeScheme(url) });
    event.preventDefault();
  });
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  if (!options.devTools) {
    contents.on('devtools-opened', () => contents.closeDevTools());
  }
}

function safeScheme(url: string): string {
  const colon = url.indexOf(':');
  return colon > 0 && colon < 16 ? url.slice(0, colon) : 'unknown';
}
