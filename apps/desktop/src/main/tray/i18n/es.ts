/**
 * Spanish strings of the tray (icon tooltip, context menu) and the main window title
 * (PROMPT §10 «Bandeja y otras superficies»). Mode names, remaining-time phrases and points
 * come from `src/shared/i18n/es.ts` through `src/shared/format.ts`.
 */
import type { Widen } from '../../../shared/i18n/locale';
import type { LinkDownReason } from '../../../shared/ui-state';

export const TRAY_ES = {
  appName: 'Céntrate',
  /** «Céntrate · YouTube · quedan 43 min · 1.240 pts». */
  separator: ' · ',
  tooltip: {
    noBlocks: 'sin bloqueos',
    punishment: 'castigo',
    blocks: (count: number): string => `${count} bloqueos`,
    checkingClock: 'comprobando la hora',
    studying: 'estudiando',
  },
  /** Guardian link down, by reason (tooltip and title, lower case after «Céntrate ·»). */
  linkDown: {
    not_installed: 'guardián no instalado',
    unreachable: 'guardián detenido',
    timeout: 'guardián detenido',
    unauthorized: 'actualiza el guardián',
    incompatible: 'actualiza el guardián',
  } satisfies Record<LinkDownReason, string>,
  title: {
    /** «Céntrate · castigo 38 min». */
    punishment: (duration: string): string => `castigo ${duration}`,
    studying: 'estudiando',
    checkingClock: 'comprobando la hora',
  },
  menu: {
    /** First, disabled item. */
    status: {
      noBlocks: 'Sin bloqueos',
      connecting: 'Conectando con el guardián…',
      checkingClock: 'Comprobando la hora…',
      punishment: 'Castigo',
      blocks: (count: number): string => `${count} bloqueos`,
    },
    extend: 'Ampliar',
    /** «+15 min», «+1 h». */
    extendItem: (label: string): string => `+${label}`,
    quick: 'Bloqueo rápido',
    miniTimer: 'Mini temporizador',
    open: 'Abrir Céntrate',
    /** In place of «Salir» while a Nuclear punishment lasts. */
    emergency: 'Salida de emergencia…',
    quit: 'Salir (los bloqueos siguen activos)',
  },
} as const;

/** Shape every tray language file must match. */
export type TrayMessages = Widen<typeof TRAY_ES>;
