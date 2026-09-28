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

function calendarDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * «hasta 20:30», «hasta mañana 08:00», «hasta el 30/9 08:00» (local time); in English
 * «until 8:30 PM», «until tomorrow 8:00 AM», «until 9/30 8:00 AM». The midnight that ends
 * today reads «hasta 00:00» («until 12:00 AM»).
 */
export function untilLabel(endsAt: Date, now: Date, locale: Locale = DEFAULT_LOCALE): string {
  const t = parserMessages(locale);
  const time = t.clock(endsAt);
  const days = calendarDays(now, endsAt);
  const midnight = endsAt.getHours() === 0 && endsAt.getMinutes() === 0;
  if (days <= 0 || (days === 1 && midnight)) return t.until(time);
  if (days === 1) return t.untilTomorrow(time);
  return t.untilDate(t.dayMonth(endsAt), time);
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
