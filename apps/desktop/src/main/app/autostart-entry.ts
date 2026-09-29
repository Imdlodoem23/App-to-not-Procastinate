/**
 * Pure half of «Arranque automático» (docs/DESKTOP.md §6.7): the Linux autostart entry and
 * where it goes. The Electron half is `autostart.ts`.
 */
// Linux-only paths: POSIX separators whatever the host running the code (tests on Windows).
import { posix } from 'node:path';
import { HIDDEN_ARG } from './launch-options';

export const LINUX_AUTOSTART_FILE = 'centrate.desktop';

/** `$XDG_CONFIG_HOME/autostart/centrate.desktop` (default `~/.config`). */
export function linuxAutostartPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  const config = env['XDG_CONFIG_HOME']?.trim() || posix.join(home, '.config');
  return posix.join(config, 'autostart', LINUX_AUTOSTART_FILE);
}

/** Quotes an `Exec=` argument (Desktop Entry spec: `"`, `` ` ``, `$` and `\` escaped). */
export function desktopExecQuote(arg: string): string {
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

/**
 * The entry started at login. `executable` is `$APPIMAGE` for AppImages (the mounted path
 * changes every run) and `process.execPath` otherwise.
 */
export function linuxAutostartEntry(executable: string, name: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${name}`,
    `Exec=${desktopExecQuote(executable)} ${HIDDEN_ARG}`,
    'Terminal=false',
    'NoDisplay=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}
