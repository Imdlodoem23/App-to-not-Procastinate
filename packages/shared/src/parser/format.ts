import { PARSER_ES } from './i18n/es';

/** «45 min», «2 h», «1 h 30 min». */
export function durationLabel(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return PARSER_ES.minutes(whole);
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? PARSER_ES.hours(hours) : PARSER_ES.hoursMinutes(hours, rest);
}

const pad = (value: number): string => String(value).padStart(2, '0');

function calendarDays(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * «hasta 20:30», «hasta mañana 08:00», «hasta el 30/9 08:00» (local time). The midnight
 * that ends today reads «hasta 00:00».
 */
export function untilLabel(endsAt: Date, now: Date): string {
  const time = `${pad(endsAt.getHours())}:${pad(endsAt.getMinutes())}`;
  const days = calendarDays(now, endsAt);
  const midnight = endsAt.getHours() === 0 && endsAt.getMinutes() === 0;
  if (days <= 0 || (days === 1 && midnight)) return PARSER_ES.until(time);
  if (days === 1) return PARSER_ES.untilTomorrow(time);
  return PARSER_ES.untilDate(`${endsAt.getDate()}/${endsAt.getMonth() + 1}`, time);
}

/** «No he entendido: "mañana tarde"», or '' when everything was understood. */
export function notUnderstoodMessage(unparsed: readonly string[]): string {
  return unparsed.length === 0 ? '' : PARSER_ES.notUnderstood(unparsed);
}
