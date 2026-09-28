/** Chip labels and the «No he entendido» line of the parser, per UI language. */
export interface ParserMessages {
  /** «45 min». */
  minutes: (minutes: number) => string;
  /** «2 h». */
  hours: (hours: number) => string;
  /** «1 h 30 min». */
  hoursMinutes: (hours: number, minutes: number) => string;
  /** Local clock time of an end: «20:30» in Spanish, «8:30 PM» in English. */
  clock: (date: Date) => string;
  /** Day and month of an end more than a day away: «30/9» in Spanish, «9/30» in English. */
  dayMonth: (date: Date) => string;
  until: (time: string) => string;
  untilTomorrow: (time: string) => string;
  untilDate: (date: string, time: string) => string;
  notUnderstood: (fragments: readonly string[]) => string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Spanish strings for parser chips and the «No he entendido» line. */
export const PARSER_ES: ParserMessages = {
  minutes: (minutes: number): string => `${minutes} min`,
  hours: (hours: number): string => `${hours} h`,
  hoursMinutes: (hours: number, minutes: number): string => `${hours} h ${minutes} min`,
  clock: (date: Date): string => `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  dayMonth: (date: Date): string => `${date.getDate()}/${date.getMonth() + 1}`,
  until: (time: string): string => `hasta ${time}`,
  untilTomorrow: (time: string): string => `hasta mañana ${time}`,
  untilDate: (date: string, time: string): string => `hasta el ${date} ${time}`,
  notUnderstood: (fragments: readonly string[]): string =>
    `No he entendido: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
};
