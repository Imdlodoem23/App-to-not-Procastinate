import type { IsoWeekday } from '../domain';
import type { LanguageTags } from '../i18n/format';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale';
import { parserMessages } from './i18n/index';

/** «45 min», «2 h», «1 h 30 min» (the same short units in Spanish and English). */
export function durationLabel(minutes: number, locale: Locale = DEFAULT_LOCALE): string {
  const t = parserMessages(locale);
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return t.minutes(whole);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? t.hours(hours) : t.hoursMinutes(hours, rest);
}

/** A daily allowance: «30 min al día», «1 h al día»; «30 min a day» in English. */
export function dailyLabel(minutes: number, locale: Locale = DEFAULT_LOCALE): string {
  return parserMessages(locale).perDay(durationLabel(minutes, locale));
}

/**
 * The days a limit applies: «todos los días», «entre semana», «fines de semana», «de lunes
 * a jueves», «lunes y miércoles»; in English «every day», «weekdays», «weekends», «Monday
 * to Thursday», «Monday and Wednesday». Invalid and repeated days are ignored; no days at
 * all reads as every day (the default of a limit).
 */
export function daysLabel(days: readonly number[], locale: Locale = DEFAULT_LOCALE): string {
  const t = parserMessages(locale);
  const set = [...new Set(days)]
    .filter((day): day is IsoWeekday => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  const key = set.join(',');
  if (set.length === 0 || set.length === 7) return t.everyDay;
  if (key === '1,2,3,4,5') return t.weekdays;
  if (key === '6,7') return t.weekends;
  const name = (day: IsoWeekday): string => t.weekdayNames[day - 1] ?? '';
  // Three or more days in a row, maybe past Sunday («de viernes a domingo», «de domingo a
  // martes»): the run starts at the day whose previous day is missing.
  const has = (day: number): boolean => set.includes((((day - 1 + 7) % 7) + 1) as IsoWeekday);
  const first = set.find((day) => !has(day - 1));
  const runs = set.filter((day) => !has(day - 1)).length;
  if (set.length >= 3 && runs === 1 && first !== undefined) {
    const last = (((first - 1 + set.length - 1) % 7) + 1) as IsoWeekday;
    return t.dayRange(name(first), name(last));
  }
  return t.dayList(set.map(name));
}

function calendarDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * «hasta 20:30», «hasta mañana 08:00», «hasta el 30/9 08:00» (local time); in English
 * «until 8:30 PM», «until tomorrow 8:00 AM», «until 9/30 8:00 AM». The midnight that ends
 * today reads «hasta 00:00», the one that ends tomorrow «hasta el 30/9 00:00». English
 * names noon and midnight: «until noon», «until noon tomorrow», «until midnight», «until
 * midnight tomorrow». `tags` are the user's language tags, for the region's clock and
 * dates (see `intlTag`; es-ES and en-US by default).
 */
export function untilLabel(
  endsAt: Date,
  now: Date,
  locale: Locale = DEFAULT_LOCALE,
  tags?: LanguageTags,
): string {
  const t = parserMessages(locale);
  const days = calendarDays(now, endsAt);
  const minuteOfDay = endsAt.getHours() * 60 + endsAt.getMinutes();
  const midnight = minuteOfDay === 0;
  if (t.untilNamed) {
    // Midnight belongs to the day it ends: 00:00 on the 29th is «tonight's» midnight.
    if (midnight && (days === 1 || days === 2)) return t.untilNamed('midnight', days === 2);
    if (minuteOfDay === 12 * 60 && (days === 0 || days === 1)) {
      return t.untilNamed('noon', days === 1);
    }
  }
  const time = t.clock(endsAt, tags);
  if (days <= 0 || (days === 1 && midnight)) return t.until(time);
  if (days === 1) return t.untilTomorrow(time);
  return t.untilDate(t.dayMonth(endsAt, tags), time);
}

/**
 * «No he entendido: "mañana tarde"» («Not understood: "mañana tarde"»), or '' when
 * everything was understood.
 */
export function notUnderstoodMessage(
  unparsed: readonly string[],
  locale: Locale = DEFAULT_LOCALE,
): string {
  return unparsed.length === 0 ? '' : parserMessages(locale).notUnderstood(unparsed);
}
