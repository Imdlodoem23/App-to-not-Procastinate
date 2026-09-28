/**
 * Clock phrases of the Bloqueos window that `src/shared/format.ts` does not cover: day-relative
 * ends («hasta las 18:00», «hasta mañana a las 08:00») and starts («18:00», «mañana 16:00»).
 * Local time zone, the active locale's clock. Pure: no DOM, Node or Electron imports.
 */
import { formatClock, formatWeekday } from '../../../../shared/format';
import { BLOQUEOS } from './i18n';

/** Local calendar days from `fromMs` to `toMs` (0 today, 1 tomorrow…). */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

type DayKind = 'today' | 'tomorrow' | 'weekday';

/** Midnight ending today counts as today («hasta las 00:00»), like the parser's labels. */
function dayKind(ms: number, nowMs: number): DayKind {
  const days = calendarDaysBetween(nowMs, ms);
  const date = new Date(ms);
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  if (days <= 0 || (days === 1 && midnight)) return 'today';
  if (days === 1) return 'tomorrow';
  return 'weekday';
}

function weekday(ms: number): string {
  return formatWeekday(ms);
}

/** «hasta las 18:00», «hasta mañana a las 08:00», «hasta el jue a las 08:00». */
export function untilPhrase(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return BLOQUEOS.until.today(time);
    case 'tomorrow':
      return BLOQUEOS.until.tomorrow(time);
    case 'weekday':
      return BLOQUEOS.until.weekday(weekday(ms), time);
  }
}

/** «18:00», «mañana 16:00», «jue 16:00». */
export function whenLabel(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return time;
    case 'tomorrow':
      return BLOQUEOS.when.tomorrow(time);
    case 'weekday':
      return BLOQUEOS.when.weekday(weekday(ms), time);
  }
}
