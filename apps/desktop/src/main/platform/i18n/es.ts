/**
 * Spanish copy of the platform services: the OSD after tray and shortcut actions, and the CSV
 * export (save dialog, file names, column headers).
 */
import type { Widen } from '../../../shared/i18n/locale';

export const PLATFORM_ES = {
  osd: {
    /** «+15 min · hasta las 17:57». */
    extended: (added: string, clock: string): string => `+${added} · hasta las ${clock}`,
    noBlock: 'No hay ningún bloqueo que ampliar',
    extendRefused: 'Ese bloqueo no se puede ampliar',
    maxReached: 'Como mucho 24 h en total',
    miniTimerShown: 'Mini temporizador',
    miniTimerHidden: 'Mini temporizador oculto',
  },
  csv: {
    dialogTitle: 'Exportar CSV',
    filterName: 'CSV',
    /** File base names: «centrate-eventos-2026-09-28.csv». */
    names: { events: 'eventos', days: 'dias' },
    events: ['fecha', 'tipo', 'puntos', 'objetivo', 'minutos', 'modo'],
    days: ['dia', 'minutos_estudio', 'minutos_bloqueo', 'intentos', 'puntos', 'objetivo_cumplido'],
  },
} as const;

export type PlatformMessages = Widen<typeof PLATFORM_ES>;
