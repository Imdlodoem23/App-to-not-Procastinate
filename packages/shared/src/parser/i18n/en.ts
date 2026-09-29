import { formatClock, formatDayMonth, type LanguageTags } from '../../i18n/format';
import type { NamedTime, ParserMessages } from './es';

/** «a and b», «a, b, and c» (en-US serial comma). */
function joinEn(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1] ?? ''}`;
}

const TIME_NAMES: Readonly<Record<NamedTime, string>> = { noon: 'noon', midnight: 'midnight' };

/**
 * English strings for parser chips and the «No he entendido» line: how what the parser
 * understood is shown, whatever language the phrase was typed in. Durations keep the short
 * units of the Spanish chips («45 min», «1 h 30 min»); clock times and dates follow the
 * user's region (en-US by default: «8:30 PM», «9/30»). Noon and midnight are named, since
 * «12:00 PM» and «12:00 AM» are easy to misread. Conventions: en-US spelling, sentence case.
 */
export const PARSER_EN: ParserMessages = {
  minutes: (minutes: number): string => `${minutes} min`,
  hours: (hours: number): string => `${hours} h`,
  hoursMinutes: (hours: number, minutes: number): string => `${hours} h ${minutes} min`,
  clock: (date: Date, tags?: LanguageTags): string => formatClock(date, 'en', tags),
  dayMonth: (date: Date, tags?: LanguageTags): string => formatDayMonth(date, 'en', tags),
  until: (time: string): string => `until ${time}`,
  untilTomorrow: (time: string): string => `until tomorrow ${time}`,
  untilDate: (date: string, time: string): string => `until ${date} ${time}`,
  untilNamed: (time: NamedTime, tomorrow: boolean): string =>
    tomorrow ? `until ${TIME_NAMES[time]} tomorrow` : `until ${TIME_NAMES[time]}`,
  notUnderstood: (fragments: readonly string[]): string =>
    `Not understood: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
  perDay: (duration: string): string => `${duration} a day`,
  weekdayNames: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  everyDay: 'every day',
  weekdays: 'weekdays',
  weekends: 'weekends',
  dayRange: (from: string, to: string): string => `${from} to ${to}`,
  dayList: joinEn,
};
