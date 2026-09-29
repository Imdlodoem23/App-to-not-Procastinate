import { formatClock, formatDayMonth, type LanguageTags } from '../../i18n/format';

/** Clock times with a name: 12:00 and 00:00. */
export type NamedTime = 'noon' | 'midnight';

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
   * Noon or the midnight that ends the day, today or tomorrow, for languages that name them
   * («until noon», «until midnight tomorrow»). Null shows the clock like any other time
   * («hasta 12:00», «hasta 00:00», «hasta el 30/9 00:00»).
   */
  untilNamed: ((time: NamedTime, tomorrow: boolean) => string) | null;
  notUnderstood: (fragments: readonly string[]) => string;
  /** Daily allowance of a limit: «30 min al día», «1 h 30 min al día». */
  perDay: (duration: string) => string;
  /** Weekday names, Monday first (index 0 = ISO weekday 1). */
  weekdayNames: readonly [string, string, string, string, string, string, string];
  /** The seven days: «todos los días». */
  everyDay: string;
  /** Monday to Friday: «entre semana». */
  weekdays: string;
  /** Saturday and Sunday: «fines de semana». */
  weekends: string;
  /** Three or more days in a row: «de lunes a jueves». */
  dayRange: (from: string, to: string) => string;
  /** Other sets of days: «lunes», «lunes y miércoles», «lunes, miércoles y viernes». */
  dayList: (names: readonly string[]) => string;
}

/** «a, b y c» (Spanish, no serial comma). */
function joinEs(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} y ${names[names.length - 1] ?? ''}`;
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
  untilNamed: null,
  notUnderstood: (fragments: readonly string[]): string =>
    `No he entendido: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
  perDay: (duration: string): string => `${duration} al día`,
  weekdayNames: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
  everyDay: 'todos los días',
  weekdays: 'entre semana',
  weekends: 'fines de semana',
  dayRange: (from: string, to: string): string => `de ${from} a ${to}`,
  dayList: joinEs,
};
