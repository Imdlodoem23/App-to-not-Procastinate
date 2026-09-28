/**
 * Filesystem locations of the app (docs/DESKTOP.md §6.1, §8.6). Pure: every input is passed
 * in, so tests cover each platform and the packaged / unpackaged split.
 *
 * Unpackaged, resources resolve from the built main bundle (`out/main/../../resources`),
 * which works both for `electron .` and `electron out/main/index.js` (the e2e launch).
 */
import { join, win32 } from 'node:path';
import type { Platform } from '../../shared/ui-state';
import { TRAY_ICON_DIR } from '../tray/icons';

export const GUARDIAN_EXECUTABLE = 'centrate-guardian';

export interface AppPathsInput {
  platform: Platform;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** `__dirname` of the main bundle (`…/out/main`). */
  mainDir: string;
  /** `process.resourcesPath` (packaged app). */
  resourcesPath: string;
  /** `app.getPath('userData')` after any override. */
  userDataDir: string;
  /** `CENTRATE_DATA_DIR` (already restricted to unpackaged runs by `parseLaunchOptions`). */
  sysDirOverride: string | null;
}

export interface AppPaths {
  userDataDir: string;
  /** Guardian system directory holding `client.json`. */
  sysDir: string;
  /** Where the bundled guardian would be (the caller checks it exists). */
  guardianBinary: string;
  trayIconsDir: string;
  preload: string;
  rendererHtml: string;
}

/** `%ProgramData%\Centrate`, `/Library/Application Support/Centrate`, `/var/lib/centrate`. */
export function defaultSysDir(
  platform: Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'win32') {
    return win32.join(env['ProgramData'] ?? env['PROGRAMDATA'] ?? 'C:\\ProgramData', 'Centrate');
  }
  if (platform === 'darwin') return '/Library/Application Support/Centrate';
  return '/var/lib/centrate';
}

export function resolveAppPaths(input: AppPathsInput): AppPaths {
  const resources = input.packaged
    ? input.resourcesPath
    : join(input.mainDir, '..', '..', 'resources');
  const exe = input.platform === 'win32' ? `${GUARDIAN_EXECUTABLE}.exe` : GUARDIAN_EXECUTABLE;
  return {
    userDataDir: input.userDataDir,
    sysDir: input.sysDirOverride ?? defaultSysDir(input.platform, input.env),
    guardianBinary: join(resources, 'guardian', exe),
    trayIconsDir: join(resources, ...TRAY_ICON_DIR),
    preload: join(input.mainDir, '..', 'preload', 'index.js'),
    rendererHtml: join(input.mainDir, '..', 'renderer', 'index.html'),
  };
}
