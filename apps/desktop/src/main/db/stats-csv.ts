/**
 * «Exportar CSV» (PROMPT §9, docs/DESKTOP.md §15): the event log or one row per day, as RFC 4180
 * text with CRLF lines and a UTF-8 byte order mark (spreadsheets then read «Céntrate» right).
 * Every field goes through the shared `csvLine`, which quotes commas, quotes and line breaks and
 * defuses spreadsheet formulas («=», «+», «−», «@» at the start).
 *
 * Pure: the rows come in, a string goes out; main shows the save dialog and writes the file.
 */
import type { LocalDay } from '@centrate/shared/domain';
import { csvLine, type CsvExportKind } from '../../shared/stats';
import {
  displayMs,
  localDateTime,
  logEntry,
  type DayRow,
  type LogLookups,
  type StoredEvent,
} from './stats-compute';

/** Byte order mark: Excel opens UTF-8 without it as ANSI. */
export const CSV_BOM = '\uFEFF';

/** Column titles in the user's language (six each, in the order the rows use). */
export interface CsvHeaders {
  events: readonly string[];
  days: readonly string[];
}

/** Log rows oldest first: date, type, points, target, minutes, mode. */
export function eventsCsv(
  rows: readonly StoredEvent[],
  lookups: LogLookups,
  headers: CsvHeaders['events'],
): { text: string; rows: number } {
  let text = CSV_BOM + csvLine(headers);
  for (const row of rows) {
    const entry = logEntry(row, lookups);
    text += csvLine([
      localDateTime(displayMs(row)),
      entry.type,
      entry.points,
      entry.target,
      entry.minutes,
      entry.mode,
    ]);
  }
  return { text, rows: rows.length };
}

/** Day rows: day, focus minutes, block minutes, attempts, points, goal met (1/0). */
export function daysCsv(
  days: readonly DayRow[],
  headers: CsvHeaders['days'],
): { text: string; rows: number } {
  let text = CSV_BOM + csvLine(headers);
  for (const d of days) {
    text += csvLine([
      d.day,
      d.focusMinutes,
      d.blockMinutes,
      d.attempts,
      d.points,
      d.goalMet ? 1 : 0,
    ]);
  }
  return { text, rows: days.length };
}

/** «centrate-eventos-2026-09-28.csv» (the base names come from the active language). */
export function csvFileName(
  kind: CsvExportKind,
  today: LocalDay,
  names: Readonly<Record<CsvExportKind, string>>,
): string {
  const base = names[kind].replace(/[^A-Za-z0-9_-]/g, '');
  return `centrate-${base || kind}-${today}.csv`;
}
