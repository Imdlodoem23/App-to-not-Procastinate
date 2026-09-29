/**
 * The Logros detail window (PROMPT §7 «Logros», §10 «Ventanas de detalle › Logros»;
 * docs/DESKTOP.md §15). Default export, no props: `DetailWindow` loads it lazily.
 *
 * One section whose title is the state («Logros: 3 de 8») with the one reached last on the
 * right, and a 4-column grid of tiles: the badge over the name. Reached ones take the selected
 * style in green and the badge's closed ring; pending ones keep the grey border and the ring
 * with its gap (shape as well as color). The help line under the grid says how to get the one
 * under the mouse or with the focus, and how far you are («… · 12 de 30»).
 *
 * The tiles are plain focusable buttons, not toggles: reached ones only look selected (no
 * `aria-pressed`), and the description says when they were reached.
 *
 * Keyboard: every tile has its Alt + key (a letter or digit of its name), the arrow keys move
 * between them, and a door puts the focus on the requested or new achievement (else the first).
 */
import { RotateCcw, Trophy } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { Section, Tile, TileRow } from '../../components';
import { maskGlyph } from '../../components/mascot';
import { achievementBadgeStyle } from '../../assets/achievements';
import { useLocaleSwitch } from '../../app/Localized';
import { useAppStore } from '../../store/context';
import type { AchievementId } from '@centrate/shared/points';
import type { DetailRequest } from '../../../../shared/ui-state';
import { LOGROS } from './i18n';
import { useLogros, type LogrosApi } from './useLogros';
import { LGR_IDS, loadErrorText, type AchievementTileView } from './view';
import './logros.css';

const L = LOGROS;

/** The badge of `id` as a tile icon (sized by logros.css). */
function badgeIcon(id: AchievementId, achieved: boolean): ReturnType<typeof maskGlyph> {
  return maskGlyph(
    `badge:${id}:${achieved ? 'earned' : 'pending'}`,
    achievementBadgeStyle(id, achieved),
  );
}

/**
 * A reached achievement keeps the kit's selected look (green outline and tint) but is not a
 * toggle: pressing it does nothing, and its state is already in its description («Conseguido el
 * 24 de septiembre»). `Tile` turns `selected` into `aria-pressed`, which would announce a
 * toggle button that never changes (WCAG 4.1.2), so the attribute is taken off right after
 * every commit that sets it (before paint, so assistive technology never reads it).
 * TODO(RENDERER-CORE): replace with a `Tile` option that draws the selected look without
 * toggle semantics.
 */
function useStaticSelected(achieved: boolean): React.RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.removeAttribute('aria-pressed');
  }, [achieved]);
  return ref;
}

function AchievementTile(props: { tile: AchievementTileView }): React.JSX.Element {
  const { tile } = props;
  const ref = useStaticSelected(tile.achieved);
  return (
    <Tile
      ref={ref}
      id={tile.id}
      label={tile.title}
      icon={badgeIcon(tile.id, tile.achieved)}
      help={tile.help}
      selected={tile.achieved}
      tone="green"
      mnemonic={tile.mnemonic}
      className="lgr-tile"
    />
  );
}

function Grid(props: { api: LogrosApi }): React.JSX.Element | null {
  const { view } = props.api;
  if (view.tiles.length === 0) return null;
  return (
    <TileRow
      id={LGR_IDS.row}
      label={L.rowLabel}
      columns={4}
      className="lgr-grid"
      help={view.rowHelp}
    >
      {view.tiles.map((tile) => (
        <AchievementTile key={tile.id} tile={tile} />
      ))}
    </TileRow>
  );
}

function ErrorRow(props: { api: LogrosApi }): React.JSX.Element {
  return (
    <TileRow
      id={LGR_IDS.retry}
      label={L.errors.retry}
      columns={4}
      help={loadErrorText()}
      helpTone="red"
    >
      <Tile
        id="retry"
        label={L.errors.retry}
        icon={RotateCcw}
        size="text"
        help={L.errors.retryHelp}
        mnemonic={L.keys.retry}
        onPress={props.api.retry}
      />
    </TileRow>
  );
}

/** The requested tile, else the one the help points at (a fixture), else the first one. */
function focusDoorTarget(item: string | null): void {
  const tiles = [
    ...document.querySelectorAll<HTMLElement>(
      `[data-row-tile="${LGR_IDS.row}"], [data-row-tile="${LGR_IDS.retry}"]`,
    ),
  ];
  const target = (item ? tiles.find((t) => t.dataset['tileId'] === item) : undefined) ?? tiles[0];
  target?.focus({ preventScroll: true });
}

export default function LogrosWindow(): React.JSX.Element {
  const api = useLogros();
  const { view } = api;
  const request = useAppStore((s) => (s.env.detail?.name === 'logros' ? s.env.detail : null));
  const help = useAppStore((s) => s.detail.help);

  // Every door puts the focus on a tile (never <body>), once per request and after the first
  // answer. A language switch keeps the focus where it was.
  const localeSwitch = useLocaleSwitch();
  const doorFor = useRef<DetailRequest | null>(null);
  useLayoutEffect(() => {
    if (!request || !api.ready || doorFor.current === request) return;
    doorFor.current = request;
    if (localeSwitch.current) return;
    focusDoorTarget(view.focus ?? (help?.row === LGR_IDS.row ? help.item : null));
    // Only a new door (or the first answer) moves the focus.
  }, [request, api.ready, localeSwitch]);

  let body: React.JSX.Element;
  if (!api.ready) body = <p className="sr-only">{L.loading}</p>;
  else if (api.loadError) body = <ErrorRow api={api} />;
  else body = <Grid api={api} />;

  return (
    <div
      className="lgr"
      data-loading={api.loading ? '' : undefined}
      aria-busy={api.ready ? undefined : true}
    >
      <Section
        id={LGR_IDS.section}
        icon={Trophy}
        title={view.title}
        datum={view.datum ?? undefined}
        datumTone={view.datumFresh ? 'green' : 'default'}
      >
        {body}
      </Section>
    </div>
  );
}
