/**
 * Tray icon files (docs/DESKTOP.md §8.6). Pure and **free of runtime imports**: the
 * generator `scripts/gen-tray-icons.mjs` imports this file directly with Node's type
 * stripping, so names and sizes are defined once.
 *
 * Files live in `resources/assets/tray/` (packaged as `<resources>/assets/tray/`):
 * `tray-<key>[-cam]-<variant>.png` at 16 px plus `@1.25x` (20 px), `@1.5x` (24 px) and
 * `@2x` (32 px), which `nativeImage.createFromPath` picks per scale factor. macOS's idle
 * icon is a template image (`tray-idleTemplate*.png`, black + alpha, tinted by the system).
 */
import type { Platform } from '../../shared/ui-state';

/** Strongest active thing: punishment/hardcore/exam > strict > normal; study with its flag. */
export type TrayIconKey = 'idle' | 'normal' | 'strict' | 'red' | 'study';
/**
 * `light` / `dark`: the surface the icon sits on (a dark taskbar gets the `dark` file, drawn
 * with the dark theme's colors). `template`: macOS idle.
 */
export type TrayIconVariant = 'light' | 'dark' | 'template';

export const TRAY_ICON_KEYS: readonly TrayIconKey[] = ['idle', 'normal', 'strict', 'red', 'study'];

/** 16/20/24/32 px for scale factors 1/1.25/1.5/2 (Electron's `@<scale>x` file suffixes). */
export const TRAY_ICON_SIZES = [
  { px: 16, scale: 1, suffix: '' },
  { px: 20, scale: 1.25, suffix: '@1.25x' },
  { px: 24, scale: 1.5, suffix: '@1.5x' },
  { px: 32, scale: 2, suffix: '@2x' },
] as const;

/** Relative location under the app's resources (`resources/assets` is packaged as `assets`). */
export const TRAY_ICON_DIR = ['assets', 'tray'] as const;

/** Accent of each colored key (token name in `tokens.ts`); `idle` is monochrome `fg`. */
export const TRAY_ICON_ACCENT = {
  idle: 'fg',
  normal: 'blue',
  strict: 'orange',
  red: 'red',
  study: 'green',
} as const satisfies Record<TrayIconKey, string>;

export interface TrayIconSpec {
  key: TrayIconKey;
  /** Red dot: camera on (Study Mode, with its flag). */
  camera: boolean;
  variant: TrayIconVariant;
}

/** File name without scale suffix and extension. */
export function trayIconBaseName(spec: TrayIconSpec): string {
  if (spec.variant === 'template') return `tray-${spec.key}${spec.camera ? '-cam' : ''}Template`;
  return `tray-${spec.key}${spec.camera ? '-cam' : ''}-${spec.variant}`;
}

/** The 16 px file (Electron finds the `@…x` siblings itself). */
export function trayIconFileName(spec: TrayIconSpec, suffix: string = ''): string {
  return `${trayIconBaseName(spec)}${suffix}.png`;
}

/** Every icon the generator draws and the app may load. */
export function trayIconSet(): TrayIconSpec[] {
  const specs: TrayIconSpec[] = [{ key: 'idle', camera: false, variant: 'template' }];
  for (const key of TRAY_ICON_KEYS) {
    for (const variant of ['light', 'dark'] as const) {
      specs.push({ key, camera: false, variant });
      // The camera is only ever on during Study Mode.
      if (key === 'study') specs.push({ key, camera: true, variant });
    }
  }
  return specs;
}

export interface TraySurface {
  /** Windows: `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` (the taskbar). */
  darkSystemUi: boolean;
  /** `nativeTheme.shouldUseDarkColors`. */
  darkApp: boolean;
  /** `XDG_CURRENT_DESKTOP` (Linux). */
  desktop: string | null;
}

/** GNOME-based panels (Ubuntu, Unity, Pop!_OS…) are dark whatever the app theme. */
function alwaysDarkPanel(desktop: string | null): boolean {
  return desktop !== null && /gnome|unity|ubuntu|pop|budgie|pantheon/i.test(desktop);
}

/** Which file variant suits the surface the tray draws on. */
export function trayIconVariant(
  platform: Platform,
  key: TrayIconKey,
  surface: TraySurface,
): TrayIconVariant {
  if (platform === 'darwin') {
    if (key === 'idle') return 'template';
    return surface.darkApp ? 'dark' : 'light';
  }
  if (platform === 'win32') return surface.darkSystemUi ? 'dark' : 'light';
  return alwaysDarkPanel(surface.desktop) || surface.darkApp ? 'dark' : 'light';
}
