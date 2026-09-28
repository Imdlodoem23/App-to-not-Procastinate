/**
 * Pure view models of the Estadísticas window (PROMPT §9 «Estadísticas», §10 «Ventanas de
 * detalle › Estadísticas»; docs/DESKTOP.md §15). Components only map these to the kit.
 *
 * - The chart section: «Concentrado: 14 h» · «21–27 sept», «Día | Semana | Mes», the period
 *   row «‹ Semana anterior | Esta semana | Semana siguiente ›», one bar per hour or day (focus
 *   plus credited block minutes, the minutes the daily goal counts) and, beside it, the text
 *   summary a screen reader reads instead of the bars (with a table of every bar).
 * - The heatmap: «Racha: 5 días» · «récord: 12 días», 53 weeks Monday first, green by
 *   `HeatmapCell.level`, and its one-line summary.
 * - «Lo que más intentas abrir» and «Tus mejores horas»: short ranked lists.
 * - «Registro: 12 eventos»: filter tiles, one row per event (time, what, points), «Mostrar más».
 * - «Exportar CSV»: the result on the row's help line.
 *
 * Pure module: no DOM, Node or Electron imports.
 */
import { getApp, getBrowser, getCategory, getService } from '@centrate/shared/catalog';
import {
  EVENT_TYPES,
  type EventType,
  type LocalDay,
  type PointsSummary,
} from '@centrate/shared/domain';
import { addDays, dayNumber, isLocalDay } from '@centrate/shared/points';
import {
  DEFAULT_TEMPLATES,
  draftFromTemplate,
  type BlockDraft,
  type BlockTemplate,
  type UiPrefs,
} from '../../../../shared/ui-state';
import {
  appLabel,
  categoryName,
  formatInt,
  formatMinutes,
  formatSignedInt,
  modeLabel,
} from '../../../../shared/format';
import {
  EVENT_LOG_FILTERS,
  STATS_RANGES,
  isoWeekdayIndex,
  statsPeriod,
  type CsvExportResult,
  type EventLogEntry,
  type EventLogFilter,
  type EventLogPage,
  type HeatmapLevel,
  type StatsHeatmap,
  type StatsOverview,
  type StatsRange,
  type TopTarget,
} from '../../../../shared/stats';
import {
  dayCount,
  formatBarDay,
  formatDayLong,
  formatHour,
  formatHourRange,
  formatLogTime,
  formatMonthShort,
  formatPeriod,
  formatWeekTick,
} from './dates';
import { ESTADISTICAS } from './i18n';

const E = ESTADISTICAS;

/** DOM ids and row ids of the window (help focus, `aria-describedby`, e2e). */
export const EST_IDS = Object.freeze({
  chart: 'est-chart',
  ranges: 'est-range',
  nav: 'est-nav',
  chartHelp: 'est-chart-help',
  summary: 'est-summary',
  table: 'est-table',
  heatmap: 'est-heat',
  heatmapHelp: 'est-heat-help',
  targets: 'est-targets',
  hours: 'est-hours',
  log: 'est-log',
  filters: 'est-filter',
  more: 'est-more',
  exports: 'est-export',
  empty: 'est-empty',
  retry: 'est-retry',
});

/** The ids of the navigation tiles (help focus, e2e). */
export const NAV_TILES = Object.freeze({
  previous: 'previous',
  current: 'current',
  next: 'next',
});

/** How many hours «Tus mejores horas» lists. */
export const BEST_HOURS = 3;
/** Events per page of the log (`stats:events` allows up to 200). */
export const LOG_PAGE = 50;
/** Weeks of the heatmap (a year, like GitHub). */
export const HEATMAP_WEEKS = 53;

export type TextTone = 'default' | 'muted' | 'green' | 'red';

// ---------------------------------------------------------------------------------------
// Period: «Día | Semana | Mes» and «‹ anterior | actual | siguiente ›»
// ---------------------------------------------------------------------------------------

export interface RangeOptionView {
  value: StatsRange;
  label: string;
  help: string;
  mnemonic: string;
}

export function rangeOptions(): RangeOptionView[] {
  return STATS_RANGES.map((value) => ({
    value,
    label: E.ranges[value],
    help: E.ranges.help[value],
    mnemonic: E.keys.ranges[value],
  }));
}

/** The day the window shows: the stored anchor, else today. */
export function effectiveAnchor(anchor: string | null, today: LocalDay): LocalDay {
  return anchor !== null && isLocalDay(anchor) ? anchor : today;
}

/** Whether the period of `range` around `anchor` contains `today`. */
export function isCurrentPeriod(range: StatsRange, anchor: LocalDay, today: LocalDay): boolean {
  const { from, to } = statsPeriod(range, anchor);
  return from <= today && today <= to;
}

export interface NavTileView {
  id: string;
  label: string;
  help: string;
  mnemonic: string;
  disabledReason: string | null;
}

export interface NavView {
  previous: NavTileView;
  current: NavTileView;
  next: NavTileView;
}

export function deriveNav(range: StatsRange, anchor: LocalDay, today: LocalDay): NavView {
  const { to } = statsPeriod(range, anchor);
  return {
    previous: {
      id: NAV_TILES.previous,
      label: E.nav.previous[range],
      help: E.nav.previousHelp,
      mnemonic: E.keys.previous,
      disabledReason: null,
    },
    current: {
      id: NAV_TILES.current,
      label: E.nav.current[range],
      help: E.nav.currentHelp,
      mnemonic: E.keys.current[range],
      disabledReason: isCurrentPeriod(range, anchor, today) ? E.nav.atCurrent : null,
    },
    next: {
      id: NAV_TILES.next,
      label: E.nav.next[range],
      help: E.nav.nextHelp,
      mnemonic: E.keys.next,
      // The next period starts after `to`: nothing has happened there yet.
      disabledReason: to >= today ? E.nav.future : null,
    },
  };
}

// ---------------------------------------------------------------------------------------
// The chart section
// ---------------------------------------------------------------------------------------

export interface ChartBarView {
  /** `StatsBucket.key` (the category of the X axis). */
  key: string;
  /** Focus + credited block minutes. */
  minutes: number;
  attempts: number;
  points: number;
  /** The help line while this bar is hovered or focused. */
  readout: string;
  /** The first column of the screen-reader table. */
  when: string;
}

export interface SummaryPart {
  text: string;
  tone: TextTone;
}

export interface SummaryItemView {
  id: string;
  label: string;
  value: SummaryPart[];
}

export interface ChartTableView {
  caption: string;
  columns: [string, string, string, string];
  rows: [string, string, string, string][];
}

export interface ChartView {
  range: StatsRange;
  /** «Concentrado: 14 h». */
  title: string;
  /** «21–27 sept». */
  datum: string;
  /** «Minutos concentrado por día»: the chart's accessible name. */
  caption: string;
  bars: ChartBarView[];
  /** Keys labelled on the X axis, and their labels. */
  ticks: string[];
  tickLabels: Record<string, string>;
  /** The tallest bar (labelled with its value), `null` when every bar is 0. */
  maxKey: string | null;
  maxLabel: string | null;
  /** The resting help line under the chart. */
  hint: string;
  summary: SummaryItemView[];
  table: ChartTableView;
}

export interface ChartInputs {
  overview: StatsOverview;
  today: LocalDay;
  /** `snapshot.state?.points`: today's goal progress and the goal. */
  points: PointsSummary | null;
  /** Daily goal in minutes (the heatmap's, else today's, else 60). */
  goalMinutes: number;
  studyEnabled: boolean;
}

function bucketHour(key: string): number {
  const hour = Number(key.slice(11, 13));
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 0;
}

function bucketDay(key: string): LocalDay {
  return key.slice(0, 10);
}

/** The X axis: every day of a week, 4 hours of a day, 5 days of a month. */
function axisTicks(range: StatsRange, keys: readonly string[]): string[] {
  if (range === 'week') return [...keys];
  if (range === 'day') return keys.filter((k) => bucketHour(k) % 6 === 0);
  return keys.filter((k) => [1, 8, 15, 22, 29].includes(Number(k.slice(8, 10))));
}

function tickLabel(range: StatsRange, key: string): string {
  if (range === 'day') return formatHour(bucketHour(key));
  if (range === 'week') return formatWeekTick(bucketDay(key));
  return String(Number(key.slice(8, 10)));
}

function barWhen(range: StatsRange, key: string): string {
  return range === 'day' ? formatHourRange(bucketHour(key)) : formatBarDay(bucketDay(key));
}

function pointsParts(earned: number, lost: number): SummaryPart[] {
  if (earned <= 0 && lost <= 0) return [{ text: formatInt(0), tone: 'default' }];
  const parts: SummaryPart[] = [];
  if (earned > 0) parts.push({ text: formatSignedInt(earned), tone: 'green' });
  if (earned > 0 && lost > 0) parts.push({ text: ' · ', tone: 'muted' });
  if (lost > 0) parts.push({ text: formatSignedInt(-lost), tone: 'red' });
  return parts;
}

function text(value: string): SummaryPart[] {
  return [{ text: value, tone: 'default' }];
}

export function deriveChart(inputs: ChartInputs): ChartView {
  const { overview, today, points, goalMinutes, studyEnabled } = inputs;
  const { range, totals } = overview;
  const bars: ChartBarView[] = overview.buckets.map((b) => {
    const minutes = b.focusMinutes + b.blockMinutes;
    const when = barWhen(range, b.key);
    return {
      key: b.key,
      minutes,
      attempts: b.attempts,
      points: b.points,
      readout: E.chart.readout(when, formatMinutes(minutes), b.attempts),
      when,
    };
  });
  const keys = bars.map((b) => b.key);
  const ticks = axisTicks(range, keys);
  const tickLabels = Object.fromEntries(ticks.map((k) => [k, tickLabel(range, k)]));

  let best: ChartBarView | null = null;
  for (const bar of bars) if (bar.minutes > 0 && (!best || bar.minutes > best.minutes)) best = bar;

  const total = totals.focusMinutes + totals.blockMinutes;
  const summary: SummaryItemView[] = [];
  const goal = Math.max(1, Math.round(goalMinutes));

  if (range === 'day') {
    const hour = best ? bucketHour(best.key) : null;
    summary.push({
      id: 'best',
      label: E.summary.bestHour,
      value: text(
        best && hour !== null
          ? E.summary.best(formatHour(hour), formatMinutes(best.minutes))
          : E.summary.noBest,
      ),
    });
    const isToday = overview.from === today;
    const done = isToday && points ? points.today.focusMinutes : total;
    const met = isToday && points ? points.today.goalMet : total >= goal;
    summary.push({
      id: 'goal',
      label: isToday ? E.summary.goalToday : E.summary.goalDay,
      value: text(
        met ? E.summary.goalMet : E.summary.goalProgress(formatMinutes(done), formatMinutes(goal)),
      ),
    });
  } else {
    const lastLived = overview.to < today ? overview.to : today;
    const livedDays = dayCount(overview.from, lastLived);
    summary.push({
      id: 'average',
      label: E.summary.average,
      value: text(formatMinutes(livedDays > 0 ? Math.round(total / livedDays) : 0)),
    });
    summary.push({
      id: 'best',
      label: E.summary.bestDay,
      value: text(
        best
          ? E.summary.best(formatWeekTick(bucketDay(best.key)), formatMinutes(best.minutes))
          : E.summary.noBest,
      ),
    });
    const lastClosed = overview.to < today ? overview.to : addDays(today, -1);
    const closedDays = dayCount(overview.from, lastClosed);
    if (closedDays > 0 || !points || today < overview.from || today > overview.to) {
      summary.push({
        id: 'goal',
        label: E.summary.goal,
        value: text(E.summary.goalDays(totals.goalDaysMet, closedDays)),
      });
    } else {
      // Only today has happened in this period: its progress, like Progreso shows it.
      summary.push({
        id: 'goal',
        label: E.summary.goalToday,
        value: text(
          points.today.goalMet
            ? E.summary.goalMet
            : E.summary.goalProgress(
                formatMinutes(points.today.focusMinutes),
                formatMinutes(points.today.goalMinutes),
              ),
        ),
      });
    }
  }
  if (studyEnabled) {
    summary.push({
      id: 'study',
      label: E.summary.study,
      value: text(formatMinutes(totals.focusMinutes)),
    });
  }
  summary.push({
    id: 'blocks',
    label: E.summary.blocks,
    value: text(formatInt(totals.completedBlocks)),
  });
  summary.push({
    id: 'attempts',
    label: E.summary.attempts,
    value: text(formatInt(totals.attempts)),
  });
  summary.push({
    id: 'points',
    label: E.summary.points,
    value: pointsParts(totals.pointsEarned, totals.pointsLost),
  });

  const caption = E.chart.caption[range];
  return {
    range,
    title: E.title(formatMinutes(total)),
    datum: formatPeriod(range, overview.from, today),
    caption,
    bars,
    ticks,
    tickLabels,
    maxKey: best?.key ?? null,
    maxLabel: best ? formatMinutes(best.minutes) : null,
    hint: total > 0 ? E.chart.hint : E.chart.none,
    summary,
    table: {
      caption,
      columns: [
        E.chart.table.when[range],
        E.chart.table.minutes,
        E.chart.table.attempts,
        E.chart.table.points,
      ],
      rows: bars.map((b) => [
        b.when,
        formatMinutes(b.minutes),
        formatInt(b.attempts),
        formatSignedInt(b.points),
      ]),
    },
  };
}

/** The whole summary as one line of text (`aria-description` of the chart, tests). */
export function summaryText(items: readonly SummaryItemView[]): string {
  return items.map((i) => `${i.label}: ${i.value.map((p) => p.text).join('')}`).join('. ');
}

// ---------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------

export interface HeatCellView {
  day: LocalDay;
  /** Week column, 0 = the oldest. */
  col: number;
  /** 0 = Monday … 6 = Sunday. */
  row: number;
  level: HeatmapLevel;
  readout: string;
}

export interface HeatmapView {
  title: string;
  datum: string | null;
  /** «Último año: 321 días con actividad · 313 con el objetivo». */
  summary: string;
  weeks: number;
  cells: HeatCellView[];
  months: { col: number; label: string }[];
  weekdays: { row: number; label: string }[];
  less: string;
  more: string;
}

/** Days in a row, ending with the last cell (or the day before when today is still open). */
function trailingRun(cells: readonly { level: HeatmapLevel }[]): number {
  let i = cells.length - 1;
  if (i >= 0 && cells[i]?.level !== 4) i -= 1;
  let run = 0;
  for (; i >= 0 && cells[i]?.level === 4; i -= 1) run += 1;
  return run;
}

function longestRun(cells: readonly { level: HeatmapLevel }[]): number {
  let best = 0;
  let run = 0;
  for (const cell of cells) {
    run = cell.level === 4 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

export function deriveHeatmap(heatmap: StatsHeatmap, points: PointsSummary | null): HeatmapView {
  const cells = heatmap.cells.filter((c) => isLocalDay(c.day));
  const firstDay = cells[0]?.day ?? heatmap.from;
  const start = addDays(firstDay, -isoWeekdayIndex(firstDay));
  const colOf = (day: LocalDay): number => Math.floor((dayNumber(day) - dayNumber(start)) / 7);
  const views: HeatCellView[] = cells.map((c) => {
    const minutes = c.focusMinutes + c.blockMinutes;
    const name = formatDayLong(c.day);
    return {
      day: c.day,
      col: colOf(c.day),
      row: isoWeekdayIndex(c.day),
      level: c.level,
      readout:
        minutes > 0
          ? E.heatmap.readout(name, formatMinutes(minutes), c.level === 4)
          : E.heatmap.readoutNone(name),
    };
  });
  const lastDay = isLocalDay(heatmap.to) && heatmap.to > firstDay ? heatmap.to : firstDay;
  const weeks = Math.max(1, colOf(lastDay) + 1, ...views.map((c) => c.col + 1));

  // A month is named over the week that holds its 1st (the first column too, when the next
  // name is far enough not to collide).
  const months: { col: number; label: string }[] = [];
  for (let col = 0; col < weeks; col += 1) {
    const monday = addDays(start, col * 7);
    const first = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).find((d) =>
      d.endsWith('-01'),
    );
    if (first) months.push({ col, label: formatMonthShort(first) });
  }
  if (months[0]?.col !== 0 && (months[0]?.col ?? weeks) >= 3) {
    months.unshift({ col: 0, label: formatMonthShort(firstDay) });
  }
  // A name needs about three columns: one that would run past the last week is left out.
  const named = months.filter((m) => m.col <= weeks - 3);

  const active = views.filter((_, i) => {
    const c = cells[i];
    return c !== undefined && c.focusMinutes + c.blockMinutes > 0;
  }).length;
  const goalDays = cells.filter((c) => c.level === 4).length;
  const streak = points ? points.streakDays : trailingRun(cells);
  const record = points ? points.bestStreakDays : longestRun(cells);
  return {
    title: E.heatmap.title(streak),
    datum: record > 0 ? E.heatmap.best(record) : null,
    summary: E.heatmap.summary(active, goalDays),
    weeks,
    cells: views,
    months: named,
    weekdays: E.heatmap.weekdays.map((label, i) => ({ row: i * 2, label })),
    less: E.heatmap.less,
    more: E.heatmap.more,
  };
}

// ---------------------------------------------------------------------------------------
// «Lo que más intentas abrir» and «Tus mejores horas»
// ---------------------------------------------------------------------------------------

/** A catalog service, category, app or browser by id, else the text as it came. */
export function targetName(target: string): string {
  const service = getService(target);
  if (service) return service.name;
  if (getCategory(target)) return categoryName(target);
  if (getApp(target)) return appLabel(target);
  return getBrowser(target)?.name ?? target;
}

function topTargetName(target: TopTarget): string {
  if (target.kind === 'service') return getService(target.id)?.name ?? target.id;
  if (target.kind === 'app') return getApp(target.id) ? appLabel(target.id) : target.id;
  return target.id;
}

export interface TargetRowView {
  id: string;
  name: string;
  attempts: string;
  /** «−75 puntos» (red), `null` when they cost nothing. */
  points: string | null;
  /** Bar length against the first row. */
  share: number;
}

export interface RankedListView<Row> {
  title: string;
  label: string;
  rows: Row[];
  /** Shown instead of the rows when there are none. */
  empty: string | null;
}

export function deriveTargets(overview: StatsOverview): RankedListView<TargetRowView> {
  const rows = overview.topTargets.filter((t) => t.attempts > 0);
  const max = Math.max(1, ...rows.map((t) => t.attempts));
  return {
    title: E.targets.title,
    label: E.targets.listLabel,
    rows: rows.map((t) => ({
      id: `${t.kind}:${t.id}`,
      name: topTargetName(t),
      attempts: E.targets.attempts(t.attempts),
      points: t.pointsLost > 0 ? formatSignedInt(-t.pointsLost) : null,
      share: t.attempts / max,
    })),
    empty: rows.length === 0 ? E.targets.none : null,
  };
}

export interface HourRowView {
  hour: number;
  label: string;
  minutes: string;
  share: number;
}

export function deriveHours(overview: StatsOverview): RankedListView<HourRowView> {
  const ranked = [...overview.hours]
    .filter((h) => h.focusMinutes + h.blockMinutes > 0)
    .sort(
      (a, b) =>
        b.focusMinutes + b.blockMinutes - (a.focusMinutes + a.blockMinutes) || a.hour - b.hour,
    )
    .slice(0, BEST_HOURS);
  const max = Math.max(1, ...ranked.map((h) => h.focusMinutes + h.blockMinutes));
  return {
    title: E.hours.title,
    label: E.hours.listLabel,
    rows: ranked.map((h) => {
      const minutes = h.focusMinutes + h.blockMinutes;
      return {
        hour: h.hour,
        label: formatHourRange(h.hour),
        minutes: formatMinutes(minutes),
        share: minutes / max,
      };
    }),
    empty: ranked.length === 0 ? E.hours.none : null,
  };
}

// ---------------------------------------------------------------------------------------
// «Registro» and «Exportar CSV»
// ---------------------------------------------------------------------------------------

function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

const BLOCK_EVENTS: ReadonlySet<string> = new Set([
  'block_created',
  'block_extended',
  'block_completed',
  'block_cancelled',
  'block_reactivated',
]);

/** «Bloqueo: YouTube · 1 h · Estricto», «Ampliado: Instagram · +30 min», «Intento: YouTube». */
export function eventText(entry: EventLogEntry): string {
  const label = isEventType(entry.type) ? E.log.events[entry.type] : E.log.unknownEvent;
  const head = entry.target ? `${label}: ${targetName(entry.target)}` : label;
  const parts = [head];
  if (entry.minutes !== null && entry.minutes > 0) {
    const minutes = formatMinutes(entry.minutes);
    parts.push(entry.type === 'block_extended' ? `+${minutes}` : minutes);
  }
  if (entry.mode && BLOCK_EVENTS.has(entry.type)) parts.push(modeLabel(entry.mode));
  return parts.join(' · ');
}

export interface LogRowView {
  id: string;
  when: string;
  text: string;
  /** «+60», «−10»; `null` for events without points. */
  points: string | null;
  tone: TextTone;
}

export interface FilterOptionView {
  value: EventLogFilter;
  label: string;
  help: string;
  mnemonic: string;
}

export interface LogView {
  title: string;
  filters: FilterOptionView[];
  rows: LogRowView[];
  empty: string | null;
  more: { label: string; help: string; mnemonic: string } | null;
}

export function logFilters(studyEnabled: boolean): FilterOptionView[] {
  return EVENT_LOG_FILTERS.filter((f) => f !== 'study' || studyEnabled).map((value) => ({
    value,
    label: E.log.filters[value],
    help: E.log.filters.help[value],
    mnemonic: E.keys.filters[value],
  }));
}

export function deriveLog(
  page: EventLogPage | null,
  today: LocalDay,
  studyEnabled: boolean,
): LogView {
  const rows: LogRowView[] = (page?.entries ?? []).map((entry) => {
    const at = Date.parse(entry.at);
    return {
      id: entry.id,
      when: Number.isFinite(at) ? formatLogTime(at, today) : '',
      text: eventText(entry),
      points: entry.points !== 0 ? formatSignedInt(entry.points) : null,
      tone: entry.points > 0 ? 'green' : entry.points < 0 ? 'red' : 'muted',
    };
  });
  const total = page ? Math.max(page.total, rows.length) : 0;
  return {
    title: page ? E.log.title(formatInt(total), total) : E.log.titleLoading,
    filters: logFilters(studyEnabled),
    rows,
    empty: page && rows.length === 0 ? E.log.none : null,
    more:
      page && page.nextBefore !== null
        ? {
            label: E.log.more,
            help: E.log.moreHelp(formatInt(rows.length), formatInt(total)),
            mnemonic: E.keys.more,
          }
        : null,
  };
}

export interface ExportNotice {
  text: string;
  tone: 'muted' | 'green' | 'red';
}

/** The export row's help line: the last result, else what the tiles do. */
export function exportNotice(exported: CsvExportResult | null, failed: boolean): ExportNotice {
  if (failed) return { text: E.exports.failed, tone: 'red' };
  if (!exported) return { text: E.exports.help, tone: 'muted' };
  if (exported.outcome === 'cancelled' || !exported.fileName) {
    return { text: E.exports.cancelled, tone: 'muted' };
  }
  return {
    text: E.exports.saved(exported.fileName, formatInt(exported.rows), exported.rows),
    tone: 'green',
  };
}

// ---------------------------------------------------------------------------------------
// Empty state: «Empezar 25 min»
// ---------------------------------------------------------------------------------------

/** Minutes of the empty state's first session (PROMPT §10 «Empezar 25 min»). */
export const FIRST_SESSION_MINUTES = 25;

/**
 * The draft «Empezar 25 min» hands to the main window's card (the one confirmation path):
 * the «Deberes» template's distractions for 25 min, in the default mode.
 */
export function firstSessionDraft(templates: readonly BlockTemplate[], prefs: UiPrefs): BlockDraft {
  const template =
    templates.find((t) => t.id === 'deberes') ??
    DEFAULT_TEMPLATES.find((t) => t.id === 'deberes') ??
    DEFAULT_TEMPLATES[0];
  if (!template) throw new Error('no built-in template');
  return {
    ...draftFromTemplate(template, prefs),
    end: { kind: 'duration', minutes: FIRST_SESSION_MINUTES },
  };
}

// ---------------------------------------------------------------------------------------
// Mnemonics (tests)
// ---------------------------------------------------------------------------------------

/** Every Alt + letter the full window can show at once (range, nav, filters, more, export). */
export function windowMnemonics(range: StatsRange, studyEnabled: boolean): string[] {
  return [
    ...STATS_RANGES.map((r) => E.keys.ranges[r]),
    E.keys.previous,
    E.keys.current[range],
    E.keys.next,
    ...logFilters(studyEnabled).map((f) => f.mnemonic),
    E.keys.more,
    E.keys.exportEvents,
    E.keys.exportDays,
    E.keys.retry,
  ];
}
