/**
 * Spanish strings of the window shell: detail window titles and the one-time hint after the
 * first X (decision 3 in docs/DESKTOP.md §13).
 */
import type { DetailName } from '../../../shared/ui-state';

export const WINDOWS_ES = {
  appName: 'Céntrate',
  detailTitles: {
    bloqueos: 'Bloqueos',
    emergencia: 'Emergencia',
    ajustes: 'Ajustes',
  } satisfies Record<DetailName, string>,
  closeHint: {
    title: 'Céntrate',
    body: 'Céntrate sigue en la bandeja. Los bloqueos siguen activos.',
  },
} as const;
