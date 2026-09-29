/**
 * Theme (PROMPT §10 «Tema»): the pages follow the system theme live. tokens.css already
 * follows `prefers-color-scheme` without `data-theme` (no flash before the script runs); the
 * script then sets `data-theme="dark|light"` on `<html>` and keeps it in sync, like the app.
 */

export type ThemeName = 'light' | 'dark';

export function themeFor(prefersDark: boolean): ThemeName {
  return prefersDark ? 'dark' : 'light';
}

/** The subset of `MediaQueryList` used here (a plain object in tests). */
export interface DarkQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Sets `data-theme` on `root` from `query` and follows its changes; returns the stop. */
export function followSystemTheme(
  root: { dataset: DOMStringMap },
  query: DarkQuery = window.matchMedia('(prefers-color-scheme: dark)'),
): () => void {
  const apply = (): void => {
    root.dataset['theme'] = themeFor(query.matches);
  };
  apply();
  query.addEventListener('change', apply);
  return () => query.removeEventListener('change', apply);
}
