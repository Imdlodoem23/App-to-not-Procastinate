import { describe, expect, it } from 'vitest';
import type { DarkQuery } from '../../src/pages/shared/theme';
import { followSystemTheme, themeFor } from '../../src/pages/shared/theme';

describe('followSystemTheme', () => {
  it('sets data-theme from prefers-color-scheme and follows it live', () => {
    const listeners = new Set<() => void>();
    const query: DarkQuery & { matches: boolean } = {
      matches: true,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const root = { dataset: {} as DOMStringMap };
    const stop = followSystemTheme(root, query);
    expect(root.dataset['theme']).toBe('dark');
    query.matches = false;
    for (const listener of listeners) listener();
    expect(root.dataset['theme']).toBe('light');
    stop();
    expect(listeners.size).toBe(0);
    expect(themeFor(true)).toBe('dark');
  });
});
