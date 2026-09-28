/**
 * Theme (docs/DESKTOP.md §6.7): `nativeTheme.themeSource` follows `prefs.theme` (or the
 * harness override), which drives the native title bar (dark in the dark theme) and the
 * renderers' `prefers-color-scheme`. On every change, each window's `backgroundColor` moves
 * to the theme's `bg`, so a show never flashes white, and the tray picks its icon variant.
 */
import { nativeTheme } from 'electron';
import { colors, type ThemeName, type ThemePreference } from '@centrate/shared/design/tokens';

export interface ThemeController {
  /** From `snapshot.prefs.theme`. */
  setPreference(preference: ThemePreference): void;
  /** Harness: force a theme (`null` goes back to the preference). */
  setOverride(theme: ThemeName | null): void;
  resolved(): ThemeName;
  backgroundColor(): string;
  /** Windows taskbar and other system surfaces. */
  darkSystemUi(): boolean;
  /** Called on every `nativeTheme` `updated` (OS switch or `themeSource` change). */
  onChange(listener: () => void): () => void;
}

export function createThemeController(initial: {
  preference: ThemePreference;
  override: ThemeName | null;
}): ThemeController {
  let preference = initial.preference;
  let override = initial.override;
  const listeners = new Set<() => void>();

  const apply = (): void => {
    const source = override ?? preference;
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  };
  apply();
  nativeTheme.on('updated', () => {
    for (const listener of listeners) listener();
  });

  const resolved = (): ThemeName => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  return {
    setPreference(next) {
      preference = next;
      apply();
    },
    setOverride(next) {
      override = next;
      apply();
    },
    resolved,
    backgroundColor: () => colors[resolved()].bg,
    darkSystemUi: () =>
      process.platform === 'win32'
        ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
        : nativeTheme.shouldUseDarkColors,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
