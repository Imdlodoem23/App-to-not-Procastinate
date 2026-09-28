/**
 * Clock phrases of section 2 that `src/shared/format.ts` does not cover: day-relative end
 * times («a las 23:42», «mañana a las 08:00», «el jue a las 08:00») and the next schedule
 * («18:00», «mañana 16:00»). Local time zone, the active locale's clock. Pure: no DOM, Node or Electron imports.
 */
import { untilLabel } from '@centrate/shared/parser';
import { activeLocale } from '../../../../shared/i18n/locale';
import { formatClock, formatWeekday } from '../../../../shared/format';
import { BLOQUEO } from './i18n';

/** Local calendar days from `fromMs` to `toMs` (0 today, 1 tomorrow…). */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

type DayKind = 'today' | 'tomorrow' | 'weekday';

/** Midnight ending today counts as today («a las 00:00»), like the parser's `untilLabel`. */
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

/** «18:00», «mañana 16:00», «jue 16:00» (header «Próximo horario: …»). */
export function whenLabel(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return time;
    case 'tomorrow':
      return BLOQUEO.when.tomorrow(time);
    case 'weekday':
      return BLOQUEO.when.weekday(weekday(ms), time);
  }
}

/** «a las 23:42», «mañana a las 08:00», «el jue a las 08:00» («termina …»). */
export function endsPhrase(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return BLOQUEO.ends.today(time);
    case 'tomorrow':
      return BLOQUEO.ends.tomorrow(time);
    case 'weekday':
      return BLOQUEO.ends.weekday(weekday(ms), time);
  }
}

/** «hasta las 20:42», «hasta mañana a las 08:00» (the no-emergency consequence line). */
export function untilPhrase(ms: number, nowMs: number): string {
  const time = formatClock(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return BLOQUEO.untilLong.today(time);
    case 'tomorrow':
      return BLOQUEO.untilLong.tomorrow(time);
    case 'weekday':
      return BLOQUEO.untilLong.weekday(weekday(ms), time);
  }
}

/**
 * «hasta 17:42», «hasta mañana 08:00» (header datum, chips, «Bloquear hasta 17:42»): the
 * parser's own `untilLabel` in Spanish; «until 5:42 PM», «until tomorrow 8:00 AM» in English.
 */
export function untilShort(ms: number, nowMs: number): string {
  if (activeLocale() === 'es') return untilLabel(new Date(ms), new Date(nowMs));
  const time = formatClock(ms);
  const end = new Date(ms);
  switch (dayKind(ms, nowMs)) {
    case 'today':
      return BLOQUEO.untilShort.today(time);
    case 'tomorrow':
      return BLOQUEO.untilShort.tomorrow(time);
    case 'weekday':
      return BLOQUEO.untilShort.date(`${end.getMonth() + 1}/${end.getDate()}`, time);
  }
}
