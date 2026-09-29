/**
 * Statistics (PROMPT §9 «Estadísticas», §10 «Estadísticas»): the queries the Estadísticas
 * window sends and the shapes main answers from its local copy of the guardian's event log
 * (`userData/centrate.sqlite`, docs/DESKTOP.md §6.5 and §15). Every number is derived from
 * events; nothing here is editable.
 *
 * - `stats:overview` (`StatsQuery`): one period («Día | Semana | Mes») around an anchor day:
 *   the bars, the totals, what you try to open most and your best hours.
 * - `stats:heatmap`: GitHub-style cells, one per local day, the last `weeks` weeks.
 * - `stats:events`: the event log, newest first, one page at a time.
 * - `stats:export-csv`: main shows the save dialog and writes the file (the path never
 *   crosses IPC; only the file name comes back for «Guardado: centrate-eventos.csv»).
 *
 * Times are display time (`at + wallOffsetMs`) and days are the envelope's local `day`.
 * Pure module: no DOM, Node or Electron imports.
 */
import type { BlockMode, LocalDay } from '@centrate/shared/domain';
import { addDays, dayNumber, isLocalDay } from '@centrate/shared/points';

export const STATS_RANGES = ['day', 'week', 'month'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === 'string' && (STATS_RANGES as readonly string[]).includes(value);
}

/** `stats:overview`: the period of `range` that contains `anchor` (`null`: today). */
export interface StatsQuery {
  range: StatsRange;
  anchor: LocalDay | null;
}

/** One bar: an hour of the day (`day`) or a day of the week or month. */
export interface StatsBucket {
  /** `day`: the local hour `'2026-09-28T17'`; `week` / `month`: the local day `'2026-09-28'`. */
  key: string;
  /** Study Mode focus minutes (`focus_minutes`). */
  focusMinutes: number;
  /** Credited minutes of completed manual and schedule blocks (`block_completed`). */
  blockMinutes: number;
  /** Counted attempts (`attempt`). */
  attempts: number;
  /** Net points recorded in the bucket (earned minus lost). */
  points: number;
}

/** «Lo que más intentas abrir»: a service, a custom domain or an app/process. */
export interface TopTarget {
  kind: 'service' | 'domain' | 'app' | 'process';
  /** Catalog service or app id, the domain, or the process name. */
  id: string;
  attempts: number;
  /** Points those attempts cost (a positive number: «−120 puntos» is 120). */
  pointsLost: number;
}

/** «Tus mejores horas»: minutes per local hour of the day over the period. */
export interface HourStat {
  /** 0–23. */
  hour: number;
  focusMinutes: number;
  blockMinutes: number;
}

export interface StatsTotals {
  focusMinutes: number;
  blockMinutes: number;
  completedBlocks: number;
  completedStudySessions: number;
  attempts: number;
  pointsEarned: number;
  /** Positive: 340 means −340 points. */
  pointsLost: number;
  /** Closed days of the period whose daily goal was met. */
  goalDaysMet: number;
}

export interface StatsOverview {
  range: StatsRange;
  /** First and last local day of the period, inclusive. */
  from: LocalDay;
  to: LocalDay;
  /** 24 hourly bars (`day`), 7 (`week`, Monday first) or one per day of the month. */
  buckets: StatsBucket[];
  totals: StatsTotals;
  /** At most `STATS_LIMITS.topTargets`, most attempts first. */
  topTargets: TopTarget[];
  /** Always 24 entries, hour 0 first; the window picks the best ones (`bestHours`). */
  hours: HourStat[];
  /** No event at all in the local log yet: the empty state («Tus estadísticas aparecerán…»). */
  empty: boolean;
}

/** `stats:heatmap`: the `weeks` weeks ending with the week of `end` (`null`: today). */
export interface HeatmapQuery {
  end: LocalDay | null;
  weeks: number;
}

export interface HeatmapCell {
  day: LocalDay;
  focusMinutes: number;
  blockMinutes: number;
  /** Green intensity 0–4 (`heatmapLevel`); days after today are omitted, not 0. */
  level: HeatmapLevel;
}

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

export interface StatsHeatmap {
  from: LocalDay;
  to: LocalDay;
  /** The daily goal the levels were computed against. */
  goalMinutes: number;
  /** Oldest first, one per day up to `min(to, today)`. */
  cells: HeatmapCell[];
}

/** The event log's filter tiles («Todo | Bloqueos | Intentos | Puntos»). */
export const EVENT_LOG_FILTERS = ['all', 'blocks', 'attempts', 'points', 'study'] as const;
export type EventLogFilter = (typeof EVENT_LOG_FILTERS)[number];

export function isEventLogFilter(value: unknown): value is EventLogFilter {
  return typeof value === 'string' && (EVENT_LOG_FILTERS as readonly string[]).includes(value);
}

/** `stats:events`: a page older than `before` (`null`: the newest page). */
export interface EventLogQuery {
  filter: EventLogFilter;
  /** The previous page's `nextBefore`. */
  before: string | null;
  limit: number;
}

/**
 * One row of the log. Raw event data never reaches the renderer: main keeps what a row shows
 * (its type, time, points and at most a target, minutes and mode).
 */
export interface EventLogEntry {
  /** `${epoch}:${seq}` (stable React key). */
  id: string;
  /** Display time. */
  at: string;
  /** An `EventType`, or the raw type of an event this app version does not know. */
  type: string;
  /** Recorded points (negative for losses). */
  points: number;
  /** The service id, domain, process, schedule name or offer the row is about. */
  target: string | null;
  minutes: number | null;
  mode: BlockMode | null;
}

export interface EventLogPage {
  entries: EventLogEntry[];
  /** Pass as `before` for the next (older) page; `null` at the end. */
  nextBefore: string | null;
  /** Events matching the filter in the whole log. */
  total: number;
}

/** «Exportar CSV»: the event log, or one row per day. */
export const CSV_EXPORT_KINDS = ['events', 'days'] as const;
export type CsvExportKind = (typeof CSV_EXPORT_KINDS)[number];

export function isCsvExportKind(value: unknown): value is CsvExportKind {
  return typeof value === 'string' && (CSV_EXPORT_KINDS as readonly string[]).includes(value);
}

export interface CsvExportResult {
  /** `cancelled`: the user closed the save dialog. */
  outcome: 'saved' | 'cancelled';
  rows: number;
  /** Base name of the saved file («centrate-eventos-2026-09-28.csv»); never a full path. */
  fileName: string | null;
}

export const STATS_LIMITS = Object.freeze({
  topTargets: 5,
  heatmapMaxWeeks: 53,
  eventPageMax: 200,
  /** `before` cursors are opaque strings of at most this length. */
  cursorMaxLength: 64,
});

// ---------------------------------------------------------------------------------------
// Pure helpers (main computes with them; the window labels with them)
// ---------------------------------------------------------------------------------------

/** 0 = Monday … 6 = Sunday (ISO week). */
export function isoWeekdayIndex(day: LocalDay): number {
  const n = dayNumber(day);
  // 1970-01-01 was a Thursday (index 3).
  return (((n + 3) % 7) + 7) % 7;
}

/** The inclusive days of the period of `range` that contains `anchor`. */
export function statsPeriod(range: StatsRange, anchor: LocalDay): { from: LocalDay; to: LocalDay } {
  if (!isLocalDay(anchor)) throw new RangeError('statsPeriod: invalid day');
  if (range === 'day') return { from: anchor, to: anchor };
  if (range === 'week') {
    const from = addDays(anchor, -isoWeekdayIndex(anchor));
    return { from, to: addDays(from, 6) };
  }
  const from = `${anchor.slice(0, 8)}01`;
  const nextMonth = addDays(from, 32);
  return { from, to: addDays(`${nextMonth.slice(0, 8)}01`, -1) };
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: LocalDay, to: LocalDay): LocalDay[] {
  const out: LocalDay[] = [];
  const n = dayNumber(to) - dayNumber(from);
  for (let i = 0; i <= n; i += 1) out.push(addDays(from, i));
  return out;
}

/** The anchor of the previous (`-1`) or next (`+1`) period («‹ | ›» in the window). */
export function shiftAnchor(range: StatsRange, anchor: LocalDay, step: -1 | 1): LocalDay {
  if (range === 'day') return addDays(anchor, step);
  if (range === 'week') return addDays(anchor, 7 * step);
  const { from, to } = statsPeriod('month', anchor);
  return step < 0 ? statsPeriod('month', addDays(from, -1)).from : addDays(to, 1);
}

/**
 * Heatmap intensity of a day's minutes against the daily goal: 0 none, 1 under a quarter,
 * 2 under half, 3 under the goal, 4 goal met.
 */
export function heatmapLevel(minutes: number, goalMinutes: number): HeatmapLevel {
  if (minutes <= 0) return 0;
  const goal = Math.max(1, goalMinutes);
  if (minutes >= goal) return 4;
  if (minutes * 2 >= goal) return 3;
  if (minutes * 4 >= goal) return 2;
  return 1;
}

/** The `count` hours with the most minutes (ties: the earlier hour), best first. */
export function bestHours(hours: readonly HourStat[], count = 3): HourStat[] {
  return [...hours]
    .filter((h) => h.focusMinutes + h.blockMinutes > 0)
    .sort(
      (a, b) =>
        b.focusMinutes + b.blockMinutes - (a.focusMinutes + a.blockMinutes) || a.hour - b.hour,
    )
    .slice(0, count);
}

/** One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. */
export function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  // A leading =, +, − or @ would run as a formula in a spreadsheet: prefix a quote mark.
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV line (CRLF-terminated, as RFC 4180 and spreadsheets expect). */
export function csvLine(values: readonly (string | number | null)[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}
