/**
 * Dates of the Estadísticas window, in the active locale: local days (`YYYY-MM-DD`, the
 * guardian's `day`) are named with `Intl` read in UTC, so a day never shifts with the time zone;
 * instants (the event log's display times) use the process time zone like every clock in the
 * app (`formatClock`). Pure: no DOM, Node or Electron imports.
 */
import type { LocalDay } from '@centrate/shared/domain';
import { addDays, dayNumber, isLocalDay } from '@centrate/shared/points';
import { activeLocale, intlTag, type Locale } from '../../../../shared/i18n/locale';
import { formatClock } from '../../../../shared/format';
import { statsPeriod, type StatsRange } from '../../../../shared/stats';
import { ESTADISTICAS } from './i18n';

const D = ESTADISTICAS.dates;

/** One cached `Intl.DateTimeFormat` per locale and option set. */
function cachedFormat(
  options: Intl.DateTimeFormatOptions,
): (locale: Locale) => Intl.DateTimeFormat {
  const cache = new Map<Locale, Intl.DateTimeFormat>();
  return (locale) => {
    let format = cache.get(locale);
    if (!format) {
      format = new Intl.DateTimeFormat(intlTag(locale), { timeZone: 'UTC', ...options });
      cache.set(locale, format);
    }
    return format;
  };
}

const weekdayShortFormat = cachedFormat({ weekday: 'short' });
const weekdayLongFormat = cachedFormat({ weekday: 'long' });
const monthShortFormat = cachedFormat({ month: 'short' });
const monthLongFormat = cachedFormat({ month: 'long' });
const monthYearFormat = cachedFormat({ month: 'long', year: 'numeric' });

/** Midnight UTC of a local day (only ever formatted in UTC). */
function utcDate(day: LocalDay): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Without the trailing dot some locales add to abbreviations («jue.», «sept.»). */
function bare(text: string): string {
  return text.replace(/\.$/, '');
}

export interface DayParts {
  /** «jue», «Thu». */
  weekdayShort: string;
  /** «jueves», «Thursday». */
  weekdayLong: string;
  /** 1–31. */
  day: number;
  /** «sept», «Sep». */
  monthShort: string;
  /** «septiembre», «September». */
  monthLong: string;
  year: number;
}

export function dayParts(day: LocalDay, locale: Locale = activeLocale()): DayParts {
  const date = utcDate(day);
  return {
    weekdayShort: bare(weekdayShortFormat(locale).format(date)),
    weekdayLong: weekdayLongFormat(locale).format(date),
    day: date.getUTCDate(),
    monthShort: bare(monthShortFormat(locale).format(date)),
    monthLong: monthLongFormat(locale).format(date),
    year: date.getUTCFullYear(),
  };
}

/** The local day of an instant in the process time zone. */
export function localDayOf(ms: number): LocalDay {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** «Jueves 24 de septiembre» (`Thursday, September 24`): starts a sentence. */
export function formatDayLong(day: LocalDay): string {
  const p = dayParts(day);
  return D.dayLong(p.weekdayLong, p.day, p.monthLong);
}

/** A bar of a week or month: «Jueves 24». */
export function formatBarDay(day: LocalDay): string {
  const p = dayParts(day);
  return D.barDay(p.weekdayLong, p.day);
}

/** X axis of a week: «lun 21». */
export function formatWeekTick(day: LocalDay): string {
  const p = dayParts(day);
  return D.weekTick(p.weekdayShort, p.day);
}

/** Month columns of the heatmap: «sept», «Sep». */
export function formatMonthShort(day: LocalDay): string {
  return dayParts(day).monthShort;
}

/** Local clock time of the start of `hour` on a fixed day («17:00», «5:00 PM»). */
export function formatHour(hour: number): string {
  return formatClock(new Date(2026, 0, 5, hour, 0, 0, 0).getTime());
}

/** «17:00–18:00» (`5:00 PM–6:00 PM`); hour 23 ends at «00:00». */
export function formatHourRange(hour: number): string {
  return D.hourRange(formatHour(hour), formatHour((hour + 1) % 24));
}

/**
 * The header datum: a day («hoy», «ayer», «jue 24 sept»), a week («21–27 sept», «28 sept – 4
 * oct») or a month («septiembre de 2026»). Years other than today's are spelt out.
 */
export function formatPeriod(range: StatsRange, anchor: LocalDay, today: LocalDay): string {
  const { from, to } = statsPeriod(range, anchor);
  const thisYear = Number(today.slice(0, 4));
  if (range === 'day') {
    if (from === today) return D.today;
    if (from === addDays(today, -1)) return D.yesterday;
    const p = dayParts(from);
    const text = D.dayShort(p.weekdayShort, p.day, p.monthShort);
    return p.year === thisYear ? text : D.withYear(text, p.year);
  }
  if (range === 'week') {
    const a = dayParts(from);
    const b = dayParts(to);
    const text =
      a.monthShort === b.monthShort && a.year === b.year
        ? D.weekSameMonth(a.day, b.day, b.monthShort)
        : D.weekTwoMonths(a.day, a.monthShort, b.day, b.monthShort);
    return b.year === thisYear && a.year === thisYear ? text : D.withYear(text, b.year);
  }
  return monthYearFormat(activeLocale()).format(utcDate(from));
}

/** Event log times: «hoy 16:42», «ayer 23:10», «24 sept 18:10». */
export function formatLogTime(atMs: number, today: LocalDay): string {
  const day = localDayOf(atMs);
  const time = formatClock(atMs);
  if (day === today) return D.logToday(time);
  if (day === addDays(today, -1)) return D.logYesterday(time);
  const p = dayParts(day);
  return D.logOlder(p.day, p.monthShort, time);
}

/** Days from `from` to `to` inclusive (0 when `to` is before `from`). */
export function dayCount(from: LocalDay, to: LocalDay): number {
  if (!isLocalDay(from) || !isLocalDay(to)) return 0;
  return Math.max(0, dayNumber(to) - dayNumber(from) + 1);
}
