/**
 * The Estadísticas detail window (PROMPT §9 «Estadísticas», §10 «Ventanas de detalle ›
 * Estadísticas»; docs/DESKTOP.md §15). Default export, no props: `DetailWindow` loads it lazily.
 *
 * Top to bottom, in the section pattern (title = state, 12 px help lines, no cards):
 * - «Concentrado: 14 h» · «21–27 sept»: «Día | Semana | Mes», «‹ Semana anterior | Esta semana
 *   | Semana siguiente ›», the bar chart (Recharts, its own lazy chunk) with its help line, and
 *   beside it the text summary (plus a screen-reader table of every bar);
 * - «Racha: 5 días» · «récord: 12 días»: the last year as a green heatmap and its summary;
 * - «Lo que más intentas abrir» | «Tus mejores horas», side by side;
 * - «Registro: 12 eventos»: «Todo | Bloqueos | Intentos | Puntos», the rows, «Mostrar más» and
 *   «Exportar eventos… | Exportar días…» (main shows the save dialog; only the file name comes
 *   back, on the row's help line and the window's polite region).
 * Before the first session: «Tus estadísticas aparecerán después de tu primera sesión» and
 * «Empezar 25 min», which hands a 25 min «Deberes» draft to the main window's card.
 *
 * Keyboard: every tile has its Alt + letter; the chart is one tab stop whose ← → move the
 * active bar; a door puts the focus on the selected period (or on «Empezar 25 min»).
 */
import {
  Ban,
  CalendarDays,
  ChartColumn,
  Clock,
  Download,
  FileDown,
  Play,
  RotateCcw,
  ScrollText,
} from 'lucide-react';
import { Suspense, lazy, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bar, HelpLine, Icon, Section, Segmented, Tile, TileRow } from '../../components';
import { RENDERER } from '../../i18n/messages';
import { useAppStore } from '../../store/context';
import { useLocaleSwitch } from '../../app/Localized';
import type { DetailRequest } from '../../../../shared/ui-state';
import { Announcer } from './announcer';
import { Heatmap } from './Heatmap';
import { ESTADISTICAS } from './i18n';
import { useEstadisticas, type EstadisticasApi } from './useEstadisticas';
import {
  EST_IDS,
  deriveChart,
  deriveHeatmap,
  deriveHours,
  deriveLog,
  deriveNav,
  deriveTargets,
  exportNotice,
  rangeOptions,
  type ChartView,
  type HeatCellView,
  type NavTileView,
  type SummaryItemView,
} from './view';
import './estadisticas.css';

const E = ESTADISTICAS;

/** Recharts and the chart: fetched when the first chart is drawn, not with the window. */
const BarsChart = lazy(() => import('./BarsChart'));

/** Plot + value label + X axis, in CSS px (the Suspense stand-in keeps the same box). */
const CHART_HEIGHT = 136;

function NavTile(props: { tile: NavTileView; onPress(): void }): React.JSX.Element {
  const { tile } = props;
  return (
    <Tile
      id={tile.id}
      label={tile.label}
      size="text"
      help={tile.help}
      mnemonic={tile.mnemonic}
      disabled={tile.disabledReason !== null}
      disabledReason={tile.disabledReason ?? undefined}
      onPress={props.onPress}
    />
  );
}

function Summary(props: { items: readonly SummaryItemView[] }): React.JSX.Element {
  return (
    <dl id={EST_IDS.summary} className="est-summary">
      {props.items.map((item) => (
        <div key={item.id} className="est-summary-item">
          <dt>{item.label}</dt>
          <dd>
            {item.value.map((part, i) => (
              <span key={i} data-tone={part.tone === 'default' ? undefined : part.tone}>
                {part.text}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ChartBlock(props: { chart: ChartView; stale: boolean }): React.JSX.Element {
  const { chart } = props;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const onActiveChange = useCallback((key: string | null) => setActiveKey(key), []);
  const active = activeKey ? chart.bars.find((b) => b.key === activeKey) : undefined;
  return (
    <div className="est-chart-row" data-stale={props.stale ? '' : undefined}>
      <figure className="est-figure">
        <div className="est-chart-frame" style={{ height: CHART_HEIGHT }}>
          <Suspense fallback={null}>
            <BarsChart
              bars={chart.bars}
              ticks={chart.ticks}
              tickLabels={chart.tickLabels}
              maxKey={chart.maxKey}
              maxLabel={chart.maxLabel}
              title={chart.caption}
              describedBy={EST_IDS.summary}
              height={CHART_HEIGHT}
              onActiveChange={onActiveChange}
            />
          </Suspense>
        </div>
        <HelpLine id={EST_IDS.chartHelp}>{active ? active.readout : chart.hint}</HelpLine>
        <table id={EST_IDS.table} className="sr-only">
          <caption>{chart.table.caption}</caption>
          <thead>
            <tr>
              {chart.table.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.table.rows.map((row, i) => (
              <tr key={chart.bars[i]?.key ?? i}>
                <th scope="row">{row[0]}</th>
                <td>{row[1]}</td>
                <td>{row[2]}</td>
                <td>{row[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
      <Summary items={chart.summary} />
    </div>
  );
}

function PeriodRows(props: { api: EstadisticasApi }): React.JSX.Element {
  const { api } = props;
  const range = api.local.range;
  const nav = deriveNav(range, api.anchor, api.today);
  return (
    <>
      <Segmented
        id={EST_IDS.ranges}
        label={E.ranges.rowLabel}
        options={rangeOptions()}
        value={range}
        onChange={api.setRange}
        columns={3}
        help={E.ranges.help[range]}
      />
      <TileRow
        id={EST_IDS.nav}
        label={E.nav.rowLabel}
        columns={3}
        help={nav.current.disabledReason ?? E.nav.currentHelp}
      >
        <NavTile tile={nav.previous} onPress={() => api.shift(-1)} />
        <NavTile tile={nav.current} onPress={api.goToday} />
        <NavTile tile={nav.next} onPress={() => api.shift(1)} />
      </TileRow>
    </>
  );
}

function ErrorRow(props: { api: EstadisticasApi }): React.JSX.Element {
  return (
    <TileRow
      id={EST_IDS.retry}
      label={E.error.retry}
      columns={3}
      help={E.error.text}
      helpTone="red"
    >
      <Tile
        id="retry"
        label={E.error.retry}
        icon={RotateCcw}
        size="text"
        help={E.error.retryHelp}
        mnemonic={E.keys.retry}
        onPress={props.api.retry}
      />
    </TileRow>
  );
}

function RankedSections(props: { api: EstadisticasApi }): React.JSX.Element | null {
  const overview = props.api.overview;
  const targets = useMemo(() => (overview ? deriveTargets(overview) : null), [overview]);
  const hours = useMemo(() => (overview ? deriveHours(overview) : null), [overview]);
  if (!targets || !hours) return null;
  return (
    <div className="est-columns" data-stale={props.api.stale ? '' : undefined}>
      <Section id={EST_IDS.targets} icon={Ban} title={targets.title}>
        {targets.empty ? (
          <p className="est-note">{targets.empty}</p>
        ) : (
          <ul className="est-rank" aria-label={targets.label}>
            {targets.rows.map((row) => (
              <li key={row.id} className="est-rank-item">
                <span className="est-rank-line">
                  <span className="est-rank-name">{row.name}</span>
                  <span className="est-rank-value">{row.attempts}</span>
                  {row.points ? (
                    <span className="est-rank-points" data-tone="red">
                      {row.points}
                    </span>
                  ) : null}
                </span>
                <Bar value={row.share} height={3} tone="orange" />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id={EST_IDS.hours} icon={Clock} title={hours.title}>
        {hours.empty ? (
          <p className="est-note">{hours.empty}</p>
        ) : (
          <ul className="est-rank" aria-label={hours.label}>
            {hours.rows.map((row) => (
              <li key={row.hour} className="est-rank-item">
                <span className="est-rank-line">
                  <span className="est-rank-name">{row.label}</span>
                  <span className="est-rank-value">{row.minutes}</span>
                </span>
                <Bar value={row.share} height={3} tone="green" />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function LogSection(props: { api: EstadisticasApi }): React.JSX.Element {
  const { api } = props;
  const log = useMemo(
    () => deriveLog(api.log, api.today, api.studyEnabled),
    [api.log, api.today, api.studyEnabled],
  );
  const notice = exportNotice(api.local.exported, api.exportFailed);
  return (
    <Section id={EST_IDS.log} icon={ScrollText} title={log.title}>
      <Segmented
        id={EST_IDS.filters}
        label={E.log.filters.rowLabel}
        options={log.filters}
        value={api.local.eventFilter}
        onChange={api.setFilter}
        help={E.log.filters.help[api.local.eventFilter]}
      />
      {log.empty ? <p className="est-note">{log.empty}</p> : null}
      {log.rows.length > 0 ? (
        <ul className="est-log" aria-label={E.log.listLabel}>
          {log.rows.map((row) => (
            <li key={row.id} className="est-log-row">
              <span className="est-log-when">{row.when}</span>
              <span className="est-log-text">{row.text}</span>
              <span className="est-log-points" data-tone={row.points ? row.tone : undefined}>
                {row.points ?? ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {log.more ? (
        <TileRow id={EST_IDS.more} label={log.more.label} columns={3} help={log.more.help}>
          <Tile
            id="more"
            label={api.logBusy ? E.log.loadingMore : log.more.label}
            size="text"
            help={log.more.help}
            mnemonic={log.more.mnemonic}
            disabled={api.logBusy}
            onPress={api.loadMore}
          />
        </TileRow>
      ) : null}
      <TileRow
        id={EST_IDS.exports}
        label={E.exports.rowLabel}
        className="est-row-2"
        help={notice.text}
        helpTone={notice.tone}
      >
        <Tile
          id="events"
          label={api.exporting === 'events' ? E.exports.saving : E.exports.events}
          icon={Download}
          size="text"
          door={api.exporting !== 'events'}
          help={api.lastExport === 'events' ? notice.text : E.exports.eventsHelp}
          mnemonic={E.keys.exportEvents}
          disabled={api.exporting !== null}
          onPress={() => api.exportCsv('events')}
        />
        <Tile
          id="days"
          label={api.exporting === 'days' ? E.exports.saving : E.exports.days}
          icon={FileDown}
          size="text"
          door={api.exporting !== 'days'}
          help={api.lastExport === 'days' ? notice.text : E.exports.daysHelp}
          mnemonic={E.keys.exportDays}
          disabled={api.exporting !== null}
          onPress={() => api.exportCsv('days')}
        />
      </TileRow>
    </Section>
  );
}

function EmptyView(props: { api: EstadisticasApi }): React.JSX.Element {
  return (
    <div className="c-empty est-empty">
      <Icon icon={ChartColumn} size="empty" />
      <p className="c-empty-text">{E.empty.text}</p>
      <TileRow id={EST_IDS.empty} label={E.empty.action} columns={3} help={E.empty.help}>
        <Tile
          id="start"
          label={E.empty.action}
          icon={Play}
          size="text"
          help={E.empty.help}
          mnemonic={E.keys.empty}
          onPress={props.api.startFirstSession}
        />
      </TileRow>
    </div>
  );
}

function focusDoorTarget(empty: boolean): void {
  const selector = empty
    ? `[data-row-tile="${EST_IDS.empty}"]`
    : `[data-row-tile="${EST_IDS.ranges}"][aria-checked="true"]`;
  document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}

export default function EstadisticasWindow(): React.JSX.Element {
  const api = useEstadisticas();
  const request = useAppStore((s) => (s.env.detail?.name === 'estadisticas' ? s.env.detail : null));
  const { overview, heatmap, points, today, studyEnabled } = api;

  const goalMinutes = heatmap?.goalMinutes ?? points?.today.goalMinutes ?? 60;
  const chart = useMemo(
    () => (overview ? deriveChart({ overview, today, points, goalMinutes, studyEnabled }) : null),
    [overview, today, points, goalMinutes, studyEnabled],
  );
  const heat = useMemo(() => (heatmap ? deriveHeatmap(heatmap, points) : null), [heatmap, points]);
  const [activeCell, setActiveCell] = useState<HeatCellView | null>(null);

  const empty = overview !== null && overview.empty && !api.stale;
  const ready = overview !== null || api.overviewFailed;

  // Every door puts the focus on a control (never <body>): the selected period, or the empty
  // state's action. Once per request; a language switch keeps the focus where it was.
  const localeSwitch = useLocaleSwitch();
  const doorFor = useRef<DetailRequest | null>(null);
  useLayoutEffect(() => {
    if (!request || !ready || doorFor.current === request) return;
    doorFor.current = request;
    if (localeSwitch.current) return;
    focusDoorTarget(empty);
  }, [request, ready, empty, localeSwitch]);

  // One root and one polite region for every stage (loading, empty, the statistics), so the
  // region screen readers track is never replaced.
  let body: React.JSX.Element;
  if (!ready) {
    body = <p className="sr-only">{E.loading}</p>;
  } else if (empty) {
    body = <EmptyView api={api} />;
  } else {
    body = (
      <>
        <Section
          id={EST_IDS.chart}
          icon={ChartColumn}
          title={
            chart && !api.overviewFailed ? chart.title : RENDERER.shell.detailTitles.estadisticas
          }
          datum={chart && !api.overviewFailed ? chart.datum : undefined}
        >
          <PeriodRows api={api} />
          {api.overviewFailed || !chart ? (
            <ErrorRow api={api} />
          ) : (
            <ChartBlock chart={chart} stale={api.stale} />
          )}
        </Section>
        {heat ? (
          <Section id={EST_IDS.heatmap} icon={CalendarDays} title={heat.title} datum={heat.datum}>
            <Heatmap
              id={`${EST_IDS.heatmap}-graphic`}
              helpId={EST_IDS.heatmapHelp}
              view={heat}
              active={activeCell}
              onActive={setActiveCell}
            />
          </Section>
        ) : null}
        {api.overviewFailed ? null : <RankedSections api={api} />}
        <LogSection api={api} />
      </>
    );
  }

  return (
    <div
      className="est"
      data-loading={api.loading ? '' : undefined}
      aria-busy={ready ? undefined : true}
    >
      {body}
      <Announcer announcement={api.announcement} />
    </div>
  );
}
