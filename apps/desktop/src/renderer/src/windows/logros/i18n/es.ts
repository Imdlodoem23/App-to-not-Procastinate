/**
 * Spanish strings of the Logros window (PROMPT §7 «Logros», §10 «Ventanas de detalle ›
 * Logros»). The names and the «cómo conseguirlo» of each achievement are shared with main
 * (`achievementText`, `@centrate/shared/i18n`); these are the window's own. Numbers and dates
 * arrive formatted. `en.ts` has the same shape (`LogrosMessages`).
 */
import type { Widen } from '../../../../../shared/i18n/locale';

export const LOGROS_ES = {
  /** «Logros: 3 de 8». */
  title: (achieved: string, total: string): string => `Logros: ${achieved} de ${total}`,
  loading: 'Leyendo tus logros…',
  /** Datum: the one reached last. */
  last: (title: string): string => `Último: ${title}`,
  rowLabel: 'Tus logros',
  /** The row's help when no achievement is hovered or focused. */
  rowHelp: 'Elige un logro para ver cómo se consigue',
  status: {
    achieved: 'Conseguido',
    /** Reached since Logros was last opened. */
    fresh: 'Nuevo',
    /** Threshold 1, not reached yet. */
    pending: 'Pendiente',
    /** «12 de 30». */
    progress: (current: string, threshold: string): string => `${current} de ${threshold}`,
    /** Study minutes in whole hours: «2 de 10 h». */
    hours: (current: string, threshold: string): string => `${current} de ${threshold} h`,
  },
  help: {
    /** «Conseguido el 19 de septiembre». */
    achievedOn: (date: string): string => `Conseguido el ${date}`,
    achieved: 'Conseguido',
    /** «Cumple tu objetivo diario 30 días seguidos · 12 de 30». */
    pending: (how: string, progress: string): string => `${how} · ${progress}`,
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
