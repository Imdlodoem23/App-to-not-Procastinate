/**
 * Auto-update decisions (PROMPT §12, footer «Actualizar a v1.3.0», Ajustes › Sistema). Pure.
 *
 * - `full`: electron-updater downloads and installs (Windows NSIS, Linux AppImage).
 * - `check-only`: the app only checks (GitHub releases) and «Actualizar a vX» opens the web's
 *   download page: macOS builds are unsigned (Squirrel.Mac refuses them) and a `.deb` is updated
 *   by installing the new package.
 * - `unsupported`: unpackaged runs (dev, e2e) never touch the network.
 */
import type { UpdaterState } from '../../shared/platform';
import type { Platform } from '../../shared/ui-state';

export type UpdaterMode = 'full' | 'check-only' | 'unsupported';

/** Where «Actualizar a vX» sends a check-only install (fixed URL, never from IPC). */
export const UPDATE_DOWNLOAD_PAGE = 'https://centrate.onrender.com/descargar';

export function updaterMode(input: {
  platform: Platform;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): UpdaterMode {
  if (!input.packaged) return 'unsupported';
  if (input.platform === 'win32') return 'full';
  if (input.platform === 'linux' && input.env['APPIMAGE']) return 'full';
  return 'check-only';
}

/** `1.3.0` > `1.2.9`; pre-release suffixes sort before the release. Invalid: never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): { nums: number[]; pre: boolean } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(v.trim());
    if (!m) return null;
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  return !a.pre && b.pre;
}

/** A short code for the help line («network», «signature»…), never the message itself. */
export function updaterErrorCode(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === 'string'
        ? error
        : '';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::|network|socket/i.test(text)) {
    return 'network';
  }
  if (/signature|signed|certificate|sha512 checksum/i.test(text)) return 'signature';
  if (/\b404\b|not found|No published versions/i.test(text)) return 'not_found';
  if (/ENOSPC|disk/i.test(text)) return 'disk';
  return 'unknown';
}

/** The state after a finished check. */
export function afterCheck(
  prev: UpdaterState,
  found: string | null,
  currentVersion: string,
  nowMs: number,
): UpdaterState {
  if (found !== null && isNewerVersion(found, currentVersion)) {
    // A download of the same version that already finished stays ready.
    if (prev.status === 'ready' && prev.version === found)
      return { ...prev, checkedAt: nowMs, error: null };
    return { status: 'available', version: found, percent: null, checkedAt: nowMs, error: null };
  }
  return { status: 'current', version: null, percent: null, checkedAt: nowMs, error: null };
}

export function withError(prev: UpdaterState, code: string, nowMs: number): UpdaterState {
  // A failed download keeps the version so the footer can offer it again.
  return {
    status: 'error',
    version: prev.version,
    percent: null,
    checkedAt: prev.status === 'checking' ? nowMs : prev.checkedAt,
    error: code,
  };
}

/**
 * A failed check while a version is already `available` or `ready` (files in electron-updater's
 * cache): the status and version stay, the error code is only recorded. Turning it into
 * `error` would drop «Reiniciar para actualizar» whenever a periodic check runs offline.
 */
export function checkFailedKeeping(prev: UpdaterState, code: string, nowMs: number): UpdaterState {
  return { ...prev, checkedAt: nowMs, error: code };
}

export function unsupportedState(): UpdaterState {
  return { status: 'unsupported', version: null, percent: null, checkedAt: null, error: null };
}

/** `app.updateVersion` for the footer: the version to offer, if any. */
export function offeredVersion(state: UpdaterState): string | null {
  return state.status === 'available' ||
    state.status === 'downloading' ||
    state.status === 'ready' ||
    (state.status === 'error' && state.version !== null)
    ? state.version
    : null;
}
