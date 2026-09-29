/**
 * Hover and focus help (PROMPT §10: the grey 12 px line under a row explains the tile under the
 * mouse or with the focus; no tooltips). The focus lives in the window's local state
 * (`main.help` / `detail.help`) so fixtures can set it. `TileRow` uses it for its tiles; a
 * section can use it for its own controls (the main field, chips).
 */
import { useCallback, useMemo } from 'react';
import { useAppStore, useAppStoreApi } from '../store/context';

export interface HelpApi {
  /** Item of `row` whose help shows now, or `null`. */
  active: string | null;
  /** Mouse enters or focus lands on `item`. */
  enter(item: string): void;
  /**
   * Mouse leaves or focus leaves `item`: the help falls back to the focused item of the row
   * (`focusedItem`), else to the row's default.
   */
  leave(item: string, focusedItem?: string | null): void;
  clear(): void;
}

export function useHelp(row: string): HelpApi {
  const api = useAppStoreApi();
  const active = useAppStore((s) => {
    const help = s.env.window === 'main' ? s.main.help : s.detail.help;
    return help?.row === row ? help.item : null;
  });

  const current = useCallback(() => {
    const s = api.getState();
    return s.env.window === 'main' ? s.main.help : s.detail.help;
  }, [api]);

  const enter = useCallback((item: string) => api.getState().setHelp({ row, item }), [api, row]);

  const leave = useCallback(
    (item: string, focusedItem: string | null = null) => {
      const help = current();
      if (help?.row !== row || help.item !== item) return;
      api
        .getState()
        .setHelp(focusedItem && focusedItem !== item ? { row, item: focusedItem } : null);
    },
    [api, row, current],
  );

  const clear = useCallback(() => {
    if (current()?.row === row) api.getState().setHelp(null);
  }, [api, row, current]);

  return useMemo(() => ({ active, enter, leave, clear }), [active, enter, leave, clear]);
}
