/**
 * Where renderers load from and which frames may talk to main (docs/DESKTOP.md §11). Pure.
 *
 * One bundle for every window: `index.html?window=main|detail` (plus `&state=<id>` in the
 * harness, which the browser harness also understands, and `&neutral-service-icons=1` for
 * marketing captures). A sender is trusted only if its
 * frame shows that document: the packaged `file://…/renderer/index.html`, or the dev server
 * (unpackaged only).
 */
import { pathToFileURL } from 'node:url';
import { NEUTRAL_SERVICE_ICONS_PARAM } from '@centrate/shared/service-icon';
import type { Platform, WindowKind } from '../../shared/ui-state';

export type RendererSource =
  | { kind: 'file'; path: string }
  /** `ELECTRON_RENDERER_URL` of `electron-vite dev` (honoured only when unpackaged). */
  | { kind: 'dev'; url: string };

export function rendererQuery(
  window: WindowKind,
  harnessStateId: string | null,
  neutralServiceIcons = false,
): Record<string, string> {
  const query: Record<string, string> = harnessStateId
    ? { window, state: harnessStateId }
    : { window };
  if (neutralServiceIcons) query[NEUTRAL_SERVICE_ICONS_PARAM] = '1';
  return query;
}

/** Full URL for `loadURL` (dev) or the query for `loadFile` (file). */
export function rendererUrl(source: RendererSource, query: Record<string, string>): string {
  const base = source.kind === 'dev' ? new URL(source.url) : pathToFileURL(source.path);
  for (const [key, value] of Object.entries(query)) base.searchParams.set(key, value);
  return base.href;
}

function normalisedPath(pathname: string, platform: Platform): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return '';
  }
  return platform === 'win32' ? decoded.toLowerCase() : decoded;
}

/** Whether `frameUrl` is our renderer document (query and hash ignored). */
export function isTrustedFrameUrl(
  frameUrl: string | null,
  source: RendererSource,
  platform: Platform,
): boolean {
  if (!frameUrl) return false;
  let url: URL;
  try {
    url = new URL(frameUrl);
  } catch {
    return false;
  }
  if (source.kind === 'dev') {
    let dev: URL;
    try {
      dev = new URL(source.url);
    } catch {
      return false;
    }
    if (url.origin !== dev.origin) return false;
    const devPath = dev.pathname.endsWith('/') ? dev.pathname : `${dev.pathname}/`;
    return url.pathname === devPath || url.pathname === `${devPath}index.html`;
  }
  if (url.protocol !== 'file:') return false;
  const expected = pathToFileURL(source.path);
  return (
    url.host === expected.host &&
    normalisedPath(url.pathname, platform) === normalisedPath(expected.pathname, platform)
  );
}
