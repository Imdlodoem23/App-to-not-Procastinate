/** Spanish strings for parser chips and the «No he entendido» line. */
export const PARSER_ES = {
  minutes: (minutes: number): string => `${minutes} min`,
  hours: (hours: number): string => `${hours} h`,
  hoursMinutes: (hours: number, minutes: number): string => `${hours} h ${minutes} min`,
  until: (time: string): string => `hasta ${time}`,
  untilTomorrow: (time: string): string => `hasta mañana ${time}`,
  untilDate: (date: string, time: string): string => `hasta el ${date} ${time}`,
  notUnderstood: (fragments: readonly string[]): string =>
    `No he entendido: ${fragments.map((fragment) => `"${fragment}"`).join(', ')}`,
} as const;
