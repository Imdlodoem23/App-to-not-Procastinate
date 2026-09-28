/**
 * One decision = one row of 3 or 4 equal tiles (PROMPT §10): a 4 (or 3) column grid with a 4 px
 * gap and, under it, the row's 12 px help line with its height reserved. The help line shows
 * the help of the tile under the mouse or with the focus (or the armed tile's consequence),
 * else the row's own `help`. Tiles are described by it (`aria-describedby`).
 *
 * `kind="radiogroup"` when the row is a choice (mode, theme): tiles become radios, one tab stop
 * (the checked one), and the arrow keys move and select. In a plain group every tile is a tab
 * stop and the arrow keys move the focus. Home and End go to the ends.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useHelp, type HelpApi } from '../hooks/useHelp';
import { HelpLine, type HelpTone } from './HelpLine';
import { RowHelpRegistry, rowHelpText } from './row-help';

export interface RowContextValue {
  rowId: string;
  helpId: string;
  kind: 'group' | 'radiogroup';
  registry: RowHelpRegistry;
  help: HelpApi;
}

const RowContext = createContext<RowContextValue | null>(null);

/** The row a tile belongs to (`null` for a tile outside any row). */
export function useRowContext(): RowContextValue | null {
  return useContext(RowContext);
}

export interface TileRowProps {
  /** Row id: help focus (`{row, item}`), `${id}-help` for the help line. */
  id: string;
  /** Accessible name of the group («Plantillas», «Modo»). */
  label: string;
  columns?: 3 | 4;
  kind?: 'group' | 'radiogroup';
  /** The row's own help, shown when no tile claims the line. */
  help?: ReactNode;
  helpTone?: HelpTone;
  /** `polite` when the row's help reports results («+30 min · termina a las 18:12»). */
  helpLive?: 'polite' | 'off';
  className?: string;
  children: ReactNode;
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true';
}

export function TileRow(props: TileRowProps): React.JSX.Element {
  const { id, label, columns = 4, kind = 'group', help, helpTone = 'muted', helpLive } = props;
  const helpId = `${id}-help`;
  const [registry] = useState(() => new RowHelpRegistry());
  const helpApi = useHelp(id);
  const gridRef = useRef<HTMLDivElement>(null);

  const context = useMemo<RowContextValue>(
    () => ({ rowId: id, helpId, kind, registry, help: helpApi }),
    [id, helpId, kind, registry, helpApi],
  );

  // Radiogroup: one tab stop, the checked radio (else the first enabled one).
  useLayoutEffect(() => {
    if (kind !== 'radiogroup') return;
    const tiles = rowTiles(gridRef.current, id);
    const stop =
      tiles.find((t) => t.getAttribute('aria-checked') === 'true') ??
      tiles.find((t) => !isDisabled(t)) ??
      tiles[0];
    for (const tile of tiles) tile.tabIndex = tile === stop ? 0 : -1;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!NAV_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const tiles = rowTiles(gridRef.current, id);
    const current = tiles.findIndex((t) => t === document.activeElement);
    if (current < 0) return;
    const candidates = kind === 'radiogroup' ? tiles.filter((t) => !isDisabled(t)) : tiles;
    if (candidates.length === 0) return;
    const from = candidates.indexOf(tiles[current] as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'Home') next = candidates[0];
    else if (event.key === 'End') next = candidates[candidates.length - 1];
    else {
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const base = from < 0 ? (step > 0 ? -1 : 0) : from;
      next = candidates[(base + step + candidates.length) % candidates.length];
    }
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (kind === 'radiogroup' && next.getAttribute('aria-checked') !== 'true') next.click();
  };

  return (
    <RowContext.Provider value={context}>
      <div className={props.className ? `c-tilerow ${props.className}` : 'c-tilerow'}>
        <div
          ref={gridRef}
          role={kind}
          aria-label={label}
          className="c-tilegrid"
          data-columns={columns}
          onKeyDown={onKeyDown}
        >
          {props.children}
        </div>
        <RowHelpLine
          id={helpId}
          registry={registry}
          active={helpApi.active}
          fallback={help}
          fallbackTone={helpTone}
          live={helpLive}
        />
      </div>
    </RowContext.Provider>
  );
}

function rowTiles(grid: HTMLElement | null, rowId: string): HTMLElement[] {
  if (!grid) return [];
  return Array.from(grid.querySelectorAll<HTMLElement>(`[data-row-tile="${CSS.escape(rowId)}"]`));
}

function RowHelpLine(props: {
  id: string;
  registry: RowHelpRegistry;
  active: string | null;
  fallback: ReactNode;
  fallbackTone: HelpTone;
  live: 'polite' | 'off' | undefined;
}): React.JSX.Element {
  const { registry } = props;
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const shown = rowHelpText(registry, props.active, { text: null, tone: props.fallbackTone });
  return (
    <HelpLine id={props.id} tone={shown.text ? shown.tone : props.fallbackTone} live={props.live}>
      {shown.text ?? props.fallback}
    </HelpLine>
  );
}
