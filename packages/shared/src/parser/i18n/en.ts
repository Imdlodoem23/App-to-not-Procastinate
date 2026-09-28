import { formatClock } from '../../i18n/format';
import type { ParserMessages } from './es';

/**
 * English strings for parser chips and the «No he entendido» line. The parser still reads
 * Spanish phrases only; this is just how what it understood is shown. Durations keep the
 * short units of the Spanish chips («45 min», «1 h 30 min»); clock times follow the
 * `en-US` clock («8:30 PM»).
 */
export const PARSER_EN: ParserMessages = {
  minutes: (minutes: number): string => `${minutes} min`,
  hours: (hours: number): string => `${hours} h`,
  hoursMinutes: (hours: number, minutes: number): string => `${hours} h ${minutes} min`,
  clock: (date: Date): string => formatClock(date, 'en'),
  dayMonth: (date: Date): string => `${date.getMonth() + 1}/${date.getDate()}`,
  until: (time: string): string => `until ${time}`,
  untilTomorrow: (time: string): string => `until tomorrow ${time}`,
  untilDate: (date: string, time: string): string => `until ${date} ${time}`,
  notUnderstood: (fragments: readonly string[]): string =>
    `Not understood: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
};
