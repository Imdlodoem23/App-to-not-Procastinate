/**
 * The foreground window on each OS behind one interface: koffi FFI on Windows and macOS, fixed
 * `xprop` calls on Linux X11, nothing on Wayland. The FFI libraries load on the first read, so
 * a run without blocks never loads them.
 */
import type * as KoffiModule from 'koffi';
import type { PermissionOutcome } from '../../shared/platform';
import type { Platform } from '../../shared/ui-state';
import type { ExecRunner } from '../system/exec';
import type { DarwinForeground } from './darwin';
import type { ForegroundWindow } from './match';
import type { Win32Foreground } from './win32';
import { readX11Foreground, x11Available } from './xprop';

type Koffi = typeof KoffiModule;

export type ForegroundRead =
  | { kind: 'window'; window: ForegroundWindow }
  /** Nothing in front (the desktop, a locked screen, a window without a title). */
  | { kind: 'none' }
  /** macOS without Screen Recording: titles cannot be read. */
  | { kind: 'needs-permission' }
  /** Wayland, no display, no xprop, or the FFI library would not load. */
  | { kind: 'unsupported' }
  | { kind: 'error' };

export interface ForegroundReader {
  read(): Promise<ForegroundRead>;
  /** Asks for what the layer needs (macOS Screen Recording); elsewhere nothing is needed. */
  requestPermission(): Promise<PermissionOutcome>;
}

/** System Settings › Privacy & Security › Screen Recording (fixed URL, fixed argv). */
const MAC_SCREEN_RECORDING_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface ReaderOptions {
  platform: Platform;
  env: Readonly<Record<string, string | undefined>>;
  exec: ExecRunner;
  /** Tests replace koffi; production imports it lazily. */
  loadKoffi?: () => Promise<Koffi>;
}

async function importKoffi(): Promise<Koffi> {
  const mod = (await import('koffi')) as Koffi & { default?: Koffi };
  return mod.default ?? mod;
}

export function createForegroundReader(options: ReaderOptions): ForegroundReader {
  const load = options.loadKoffi ?? importKoffi;
  let win32: Promise<Win32Foreground | null> | null = null;
  let darwin: Promise<DarwinForeground | null> | null = null;

  const winReader = (): Promise<Win32Foreground | null> => {
    win32 ??= (async () => {
      try {
        const { createWin32Foreground } = await import('./win32');
        return createWin32Foreground(await load());
      } catch {
        return null;
      }
    })();
    return win32;
  };
  const macReader = (): Promise<DarwinForeground | null> => {
    darwin ??= (async () => {
      try {
        const { createDarwinForeground } = await import('./darwin');
        return createDarwinForeground(await load());
      } catch {
        return null;
      }
    })();
    return darwin;
  };

  const fromWindow = (win: ForegroundWindow | null): ForegroundRead =>
    win && win.title.trim() !== '' ? { kind: 'window', window: win } : { kind: 'none' };

  return {
    async read(): Promise<ForegroundRead> {
      try {
        switch (options.platform) {
          case 'win32': {
            const reader = await winReader();
            return reader ? fromWindow(reader.read()) : { kind: 'unsupported' };
          }
          case 'darwin': {
            const reader = await macReader();
            if (!reader) return { kind: 'unsupported' };
            if (!reader.permitted()) return { kind: 'needs-permission' };
            return fromWindow(reader.read());
          }
          case 'linux': {
            if (!x11Available(options.env)) return { kind: 'unsupported' };
            const r = await readX11Foreground(options.exec);
            return r.kind === 'window' ? fromWindow(r.window) : r;
          }
        }
      } catch {
        return { kind: 'error' };
      }
    },

    async requestPermission(): Promise<PermissionOutcome> {
      if (options.platform === 'win32') return (await winReader()) ? 'granted' : 'unsupported';
      if (options.platform === 'linux') {
        return x11Available(options.env) ? 'granted' : 'unsupported';
      }
      const reader = await macReader();
      if (!reader) return 'unsupported';
      if (reader.permitted()) return 'granted';
      // The system prompt appears only the first time; Settings is where it is granted after.
      if (reader.requestPermission()) return 'granted';
      await options.exec('/usr/bin/open', [MAC_SCREEN_RECORDING_SETTINGS], { timeoutMs: 5_000 });
      return 'opened-settings';
    },
  };
}
