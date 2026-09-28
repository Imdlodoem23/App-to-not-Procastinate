import { formatClock, formatDayMonth, type LanguageTags } from '../../i18n/format';

/** Chip labels and the «No he entendido» line of the parser, per UI language. */
export interface ParserMessages {
  /** «45 min». */
  minutes: (minutes: number) => string;
  /** «2 h». */
  hours: (hours: number) => string;
  /** «1 h 30 min». */
  hoursMinutes: (hours: number, minutes: number) => string;
  /**
   * Local clock time of an end: «20:30» in Spanish, «8:30 PM» in English (en-US; `tags`
   * picks the user's region, see `intlTag`).
   */
  clock: (date: Date, tags?: LanguageTags) => string;
  /** Day and month of an end more than a day away: «30/9» in Spanish, «9/30» in en-US. */
  dayMonth: (date: Date, tags?: LanguageTags) => string;
  until: (time: string) => string;
  untilTomorrow: (time: string) => string;
  untilDate: (date: string, time: string) => string;
  /**
   * The midnight that ends today (`tomorrow` false) or tomorrow, for languages that name
   * it («until midnight», «until midnight tomorrow»). Null shows the clock like any other
   * time («hasta 00:00», «hasta el 30/9 00:00»).
   */
  untilMidnight: ((tomorrow: boolean) => string) | null;
  notUnderstood: (fragments: readonly string[]) => string;
}

/** Spanish strings for parser chips and the «No he entendido» line. */
export const PARSER_ES: ParserMessages = {
  minutes: (minutes: number): string => `${minutes} min`,
  hours: (hours: number): string => `${hours} h`,
  hoursMinutes: (hours: number, minutes: number): string => `${hours} h ${minutes} min`,
  clock: (date: Date, tags?: LanguageTags): string => formatClock(date, 'es', tags),
  dayMonth: (date: Date, tags?: LanguageTags): string => formatDayMonth(date, 'es', tags),
  until: (time: string): string => `hasta ${time}`,
  untilTomorrow: (time: string): string => `hasta mañana ${time}`,
  untilDate: (date: string, time: string): string => `hasta el ${date} ${time}`,
  untilMidnight: null,
  notUnderstood: (fragments: readonly string[]): string =>
    `No he entendido: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
};
