/**
 * Spanish strings of the window shell: detail window titles and the one-time hint after the
 * first X (decision 3 in docs/DESKTOP.md §13).
 */
import type { Widen } from '../../../shared/i18n/locale';
import type { DetailName } from '../../../shared/ui-state';

export const WINDOWS_ES = {
  appName: 'Céntrate',
  detailTitles: {
    bloqueos: 'Bloqueos',
    emergencia: 'Emergencia',
    ajustes: 'Ajustes',
    estadisticas: 'Estadísticas',
    recompensas: 'Recompensas',
    logros: 'Logros',
  } satisfies Record<DetailName, string>,
  closeHint: {
    title: 'Céntrate',
    body: 'Céntrate sigue en la bandeja. Los bloqueos siguen activos.',
  },
} as const;

/** Shape every window-shell language file must match. */
export type WindowsMessages = Widen<typeof WINDOWS_ES>;
