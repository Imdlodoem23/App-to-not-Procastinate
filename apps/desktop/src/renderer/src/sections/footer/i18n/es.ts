/**
 * Spanish strings the footer added in Phase 5 (PROMPT §10 «Pie», §12 actualizaciones): the
 * update link's states and the one-line outcome of pressing it. The Phase 1 footer copy (status,
 * version, buttons, their help and mnemonics) stays in `src/renderer/src/i18n` (`footer`).
 * `en.ts` has the same shape (`FooterMessages`).
 */
import type { Widen } from '../../../../../shared/i18n/locale';

export const FOOTER_ES = {
  /** While the new version downloads: «Descargando v0.2.0 · 45 %». */
  downloading: (version: string, percent: string): string =>
    `Descargando v${version} · ${percent} %`,
  /** The same before the first progress report. */
  downloadingStart: (version: string): string => `Descargando v${version}…`,
  /** Outcome of «Actualizar a vX» on the footer's help line. */
  result: {
    restarting: 'Reiniciando para actualizar. Los bloqueos siguen activos',
    downloadPage: 'He abierto la página de descarga de la versión nueva',
    failed: 'No se ha podido descargar la actualización',
    unsupported: 'Esta instalación no se actualiza sola: descárgala de la web',
  },
};

export type FooterMessages = Widen<typeof FOOTER_ES>;
