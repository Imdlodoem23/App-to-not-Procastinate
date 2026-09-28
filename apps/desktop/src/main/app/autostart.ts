/**
 * «Arranque automático» (docs/DESKTOP.md §6.7): on by default, applied from
 * `snapshot.prefs.autostart` whenever it changes, and only in a packaged app (a dev run
 * must never register `electron` as a login item).
 *
 * - Windows: login item with `--hidden`.
 * - macOS: login item; `wasOpenedAtLogin` also means «start hidden».
 * - Linux: `~/.config/autostart/centrate.desktop` with `Exec=… --hidden`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { app } from 'electron';
import type { Platform } from '../../shared/ui-state';
import { linuxAutostartEntry, linuxAutostartPath } from './autostart-entry';
import { HIDDEN_ARG } from './launch-options';
import type { AppLog } from './log';

export interface AutostartController {
  /** Apply `enabled` if it differs from the last value applied (no-op when unpackaged). */
  apply(enabled: boolean): void;
}

export function createAutostart(options: {
  platform: Platform;
  packaged: boolean;
  productName: string;
  log: AppLog;
}): AutostartController {
  let applied: boolean | null = null;
  return {
    apply(enabled) {
      if (applied === enabled) return;
      applied = enabled;
      if (!options.packaged) {
        options.log.info('skipped_unpackaged', { enabled });
        return;
      }
      if (options.platform === 'linux') {
        void applyLinux(enabled, options.productName).catch((error: unknown) =>
          options.log.error('apply_failed', { message: String(error) }),
        );
        return;
      }
      try {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          args: options.platform === 'win32' ? [HIDDEN_ARG] : [],
        });
      } catch (error) {
        options.log.error('apply_failed', { message: String(error) });
      }
    },
  };
}

async function applyLinux(enabled: boolean, name: string): Promise<void> {
  const file = linuxAutostartPath(process.env, homedir());
  if (!enabled) {
    await rm(file, { force: true });
    return;
  }
  const executable = process.env['APPIMAGE'] ?? process.execPath;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, linuxAutostartEntry(executable, name), 'utf8');
}

/** macOS login launch counts as `--hidden`. */
export function openedAtLogin(platform: Platform): boolean {
  if (platform !== 'darwin') return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}
