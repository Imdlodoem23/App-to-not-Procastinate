/**
 * Spanish strings of the Logros window (PROMPT §7 «Logros», §10 «Ventanas de detalle ›
 * Logros»). The names and the «cómo conseguirlo» of each achievement are shared with main
 * (`achievementText`, `@centrate/shared/i18n`); these are the window's own. Numbers, durations
 * and dates arrive formatted. `en.ts` has the same shape (`LogrosMessages`).
 */
import type { Widen } from '../../../../../shared/i18n/locale';

export const LOGROS_ES = {
  /** «Logros: 3 de 8». */
  title: (achieved: string, total: string): string => `Logros: ${achieved} de ${total}`,
  /** Before the first answer, without a count from main yet. */
  titleLoading: 'Logros',
  loading: 'Leyendo tus logros…',
  /** Datum: the one reached last. */
  last: (title: string): string => `Último: ${title}`,
  /** Datum: reached since Logros was last opened. */
  fresh: (title: string): string => `Nuevo: ${title}`,
  freshMany: (count: string): string => `${count} logros nuevos`,
  rowLabel: 'Tus logros',
  /** The grid's help when no achievement is hovered or focused. */
  rowHelp: 'Pasa el ratón por un logro para ver cómo se consigue',
  /** The same with none reached yet. */
  rowHelpNone: 'Aún no tienes ninguno: pasa el ratón por uno para ver cómo se consigue',
  help: {
    /** «Conseguido el 24 de septiembre». */
    achievedOn: (date: string): string => `Conseguido el ${date}`,
    achieved: 'Conseguido',
    /** Reached since Logros was last opened. */
    freshOn: (date: string): string => `Nuevo: conseguido el ${date}`,
    fresh: 'Nuevo: acabas de conseguirlo',
    /** «Cumple tu objetivo diario 30 días seguidos · 12 de 30». */
    pending: (how: string, progress: string): string => `${how} · ${progress}`,
    /** «12 de 30». */
    progress: (current: string, threshold: string): string => `${current} de ${threshold}`,
    /** Study minutes: «2 h 30 min de 10 h». */
    minutes: (current: string, threshold: string): string => `${current} de ${threshold}`,
  },
  errors: {
    load: 'No he podido leer tus logros',
    retry: 'Reintentar',
    retryHelp: 'Vuelve a leer el registro de este ordenador',
  },
  keys: {
    retry: 'r',
  },
};

export type LogrosMessages = Widen<typeof LOGROS_ES>;
