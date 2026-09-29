/**
 * The Recompensas detail window (PROMPT §7 «Tienda de recompensas», §10 «Ventanas de detalle ›
 * Recompensas»; docs/DESKTOP.md §15). Default export, no props: `DetailWindow` loads it lazily.
 *
 * One section whose title is the state («Recompensas: 1.240 puntos», «Recompensas: cerradas»)
 * and, side by side, the mascot in large with its phase and the shop in rows: «15 min de
 * YouTube · 150 pts · Canjear». «Canjear» confirms in place («¿Seguro? Canjear», the price and
 * how long it opens in red on the help line); disabled, the help line says why («Te faltan 40
 * puntos»). The outcome of a redeem goes on its own line under the shop, and the window's polite
 * region says it. With nothing blocked there is nothing to open: an empty state points to
 * Bloqueos.
 *
 * Keyboard: every «Canjear» has its Alt + number (the row's), the arrow keys move between them,
 * and a door puts the focus on the first one that can be redeemed (else the first one).
 */
import { Gift, Lock, RotateCcw } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import {
  HelpLine,
  Icon,
  InPlaceConfirm,
  Pill,
  Section,
  ServiceIcon,
  Tile,
  TileRow,
} from '../../components';
import { Announcer } from '../bloqueos/announcer';
import { Mascot } from '../../components/mascot';
import { useLocaleSwitch } from '../../app/Localized';
import { useAppStore } from '../../store/context';
import type { DetailRequest } from '../../../../shared/ui-state';
import { RECOMPENSAS } from './i18n';
import { useRecompensas, type RecompensasApi } from './useRecompensas';
import {
  MASCOT_SIZE,
  RWD_IDS,
  loadErrorText,
  offerLabelId,
  redeemArmId,
  type MascotView,
  type OfferRowView,
} from './view';
import './recompensas.css';

const R = RECOMPENSAS;

function MascotFigure(props: { mascot: MascotView }): React.JSX.Element {
  const { mascot } = props;
  return (
    <figure className="rwd-mascot" aria-label={R.mascot.label}>
      <Mascot stage={mascot.stage} size={MASCOT_SIZE} />
      <figcaption className="rwd-mascot-caption">
        <span className="rwd-mascot-name">{mascot.name}</span>
        <span className="rwd-mascot-text">{mascot.text}</span>
      </figcaption>
    </figure>
  );
}

function OfferRow(props: { row: OfferRowView; api: RecompensasApi }): React.JSX.Element {
  const { row, api } = props;
  const busy = api.busy === row.id;
  // Each row is its own group named by the offer, so every «Canjear» says which one it is
  // («15 min de YouTube, grupo · Canjear»), like ScheduleRow in Bloqueos (WCAG 2.4.6).
  const labelId = offerLabelId(row.id);
  return (
    <div className="rwd-offer" data-offer={row.id} role="group" aria-labelledby={labelId}>
      <ServiceIcon className="rwd-monogram" monogram={row.monogram} />
      <span className="rwd-offer-label" id={labelId} data-fit="">
        {row.label}
      </span>
      <span className="rwd-offer-price" data-fit="">
        {row.price}
      </span>
      <InPlaceConfirm
        id={row.id}
        armId={redeemArmId(row.id)}
        className="rwd-redeem"
        label={busy ? R.shop.redeeming : R.shop.redeem}
        size="text"
        help={row.help}
        consequence={row.consequence}
        mnemonic={row.mnemonic}
        disabled={row.disabledReason !== null || (api.busy !== null && !busy)}
        disabledReason={row.disabledReason ?? undefined}
        onConfirm={() => api.redeem(row.id)}
      />
    </div>
  );
}

function Shop(props: { api: RecompensasApi }): React.JSX.Element | null {
  const { api } = props;
  const { view } = api;
  if (view.rows.length === 0) return null;
  return (
    <TileRow
      id={RWD_IDS.row}
      label={R.shop.rowLabel}
      className="rwd-shop"
      help={view.help.text}
      helpTone={view.help.tone}
      helpLive="polite"
    >
      {view.rows.map((row) => (
        <OfferRow key={row.id} row={row} api={api} />
      ))}
    </TileRow>
  );
}

function ErrorRow(props: { api: RecompensasApi; text: string }): React.JSX.Element {
  return (
    <TileRow id={RWD_IDS.retry} label={R.errors.retry} columns={3} help={props.text} helpTone="red">
      <Tile
        id="retry"
        label={R.errors.retry}
        icon={RotateCcw}
        size="text"
        help={R.errors.retryHelp}
        mnemonic={R.keys.retry}
        onPress={props.api.retry}
      />
    </TileRow>
  );
}

function EmptyShop(props: { api: RecompensasApi }): React.JSX.Element {
  return (
    <div className="c-empty rwd-empty">
      <Icon icon={Lock} size="empty" />
      <p className="c-empty-text">{R.empty.text}</p>
      <TileRow id={RWD_IDS.empty} label={R.empty.action} columns={3} help={R.empty.help}>
        <Tile
          id="bloqueos"
          label={R.empty.action}
          icon={Lock}
          size="text"
          door
          help={R.empty.help}
          mnemonic={R.keys.empty}
          onPress={props.api.openBloqueos}
        />
      </TileRow>
    </div>
  );
}

/** The first «Canjear» that can be redeemed, else the first one, else the empty state's door. */
function focusDoorTarget(item: string | null): void {
  const tiles = [
    ...document.querySelectorAll<HTMLElement>(
      `[data-row-tile="${RWD_IDS.row}"], [data-row-tile="${RWD_IDS.empty}"], [data-row-tile="${RWD_IDS.retry}"]`,
    ),
  ];
  const target =
    (item ? tiles.find((t) => t.dataset['tileId'] === item) : undefined) ??
    tiles.find((t) => t.getAttribute('aria-disabled') !== 'true') ??
    tiles[0];
  target?.focus({ preventScroll: true });
}

export default function RecompensasWindow(): React.JSX.Element {
  const api = useRecompensas();
  const { view } = api;
  const request = useAppStore((s) => (s.env.detail?.name === 'recompensas' ? s.env.detail : null));
  const help = useAppStore((s) => s.detail.help);

  // Every door puts the focus on a control (never <body>), once per request, where the help
  // already points (a fixture) or on the first offer that can be redeemed. A language switch
  // keeps the focus where it was.
  const localeSwitch = useLocaleSwitch();
  const doorFor = useRef<DetailRequest | null>(null);
  useLayoutEffect(() => {
    if (!request || !api.ready || doorFor.current === request) return;
    doorFor.current = request;
    if (localeSwitch.current) return;
    focusDoorTarget(help?.row === RWD_IDS.row ? help.item : null);
    // Only a new door (or the first answer) moves the focus.
  }, [request, api.ready, localeSwitch]);

  let body: React.JSX.Element;
  if (!api.ready) body = <p className="sr-only">{R.loading}</p>;
  else if (api.loadError) body = <ErrorRow api={api} text={loadErrorText(api.loadError)} />;
  else if (view.empty) body = <EmptyShop api={api} />;
  else {
    body = (
      <>
        {/* With rows, their help line already says why the shop is closed. */}
        {view.locked && view.rows.length === 0 ? (
          <p className="rwd-text" data-tone="orange">
            {view.locked}
          </p>
        ) : null}
        <Shop api={api} />
        {view.result ? (
          <HelpLine id={RWD_IDS.result} tone={view.result.tone}>
            {view.result.text}
          </HelpLine>
        ) : null}
        {view.hidden ? <p className="rwd-text rwd-muted">{view.hidden}</p> : null}
      </>
    );
  }

  return (
    <div
      className="rwd"
      data-loading={api.loading ? '' : undefined}
      aria-busy={api.ready ? undefined : true}
    >
      <Section
        id={RWD_IDS.section}
        icon={Gift}
        title={view.title}
        titleTone={view.titleTone}
        pill={view.pill ? <Pill tone="red">{view.pill}</Pill> : undefined}
        datum={view.datum ?? undefined}
      >
        <div className="rwd-body" data-mascot={view.mascot ? '' : undefined}>
          {view.mascot ? <MascotFigure mascot={view.mascot} /> : null}
          <div className="rwd-main">{body}</div>
        </div>
      </Section>
      <Announcer announcement={api.announcement} />
    </div>
  );
}
