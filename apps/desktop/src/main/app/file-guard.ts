/**
 * Which `file:` requests a renderer may make (docs/DESKTOP.md §11, ARCHITECTURE §9.2). Pure.
 *
 * Renderers load from `file://…/out/renderer/index.html`, and Chromium lets a `file:` page
 * read every other `file:` URL (the CSP's `'self'` included): the main window could fetch
 * `<sys>/client.json`, the app token in it, or any user file. `hardenSessions` cancels every
 * `file:` request outside the renderer's own folder. Other schemes are left to the CSP.
 */
import { fileURLToPath } from 'node:url';
import { posix, win32 } from 'node:path';
import type { Platform } from '../../shared/ui-state';

/**
 * Whether a request of the app's session may proceed: any non-`file:` URL, or a `file:` URL
 * naming the renderer folder `rendererDir` or something inside it (`null`: no `file:` URL at
 * all, e.g. renderers served by the dev server). Anything unparsable is refused.
 */
export function isAllowedFileRequest(
  url: string,
  rendererDir: string | null,
  platform: Platform,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return true;
  if (!rendererDir) return false;
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  let target: string;
  try {
    // Refuses encoded separators and, on POSIX, any host but `localhost`.
    target = fileURLToPath(parsed, { windows });
  } catch {
    return false;
  }
  const fold = (p: string): string => (windows ? p.toLowerCase() : p);
  const relative = path.relative(fold(path.resolve(rendererDir)), fold(path.resolve(target)));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
