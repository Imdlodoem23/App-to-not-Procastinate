/**
 * Session and web-contents hardening (docs/DESKTOP.md §11). Installed once, before any
 * window exists. Renderers are sandboxed, context-isolated and Node-free; on top of that:
 * every permission is denied, no window can open another, nothing navigates away from the
 * app document and no `<webview>` can attach.
 */
import { app, session, type WebContents } from 'electron';
import type { AppLog } from './log';

export function hardenSessions(options: { devTools: boolean; log: AppLog }): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    options.log.warn('permission_denied', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => hardenContents(contents, options));
}

function hardenContents(contents: WebContents, options: { devTools: boolean; log: AppLog }): void {
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
