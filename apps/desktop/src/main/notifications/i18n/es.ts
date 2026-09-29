/**
 * Spanish copy of the native notifications (PROMPT §5 «App de escritorio», §10
 * «Notificaciones»; docs/DESKTOP.md §6.4). Points and clock times arrive formatted
 * («+80 puntos», «−10 puntos», «17:42»). `en.ts` has the same shape (`NotifyMessages`).
 */
import type { Widen } from '../../../shared/i18n/locale';

export const NOTIFY_ES = {
  started: {
    title: (count: number): string =>
      count === 1 ? 'Bloqueo iniciado' : `${count} bloqueos iniciados`,
    /** «YouTube hasta las 17:42». */
    body: (label: string, clock: string): string => `${label} hasta las ${clock}`,
    also: (count: number): string =>
      count === 1 ? 'un bloqueo iniciado' : `${count} bloqueos iniciados`,
  },
  finished: {
    title: (count: number): string =>
      count === 1 ? 'Bloqueo terminado' : `${count} bloqueos terminados`,
    /** «Hecho. +80 puntos» (just «Hecho.» when it earned nothing). */
    body: (points: string | null): string => (points ? `Hecho. ${points}` : 'Hecho.'),
    also: (count: number, points: string | null): string => {
      const head = count === 1 ? 'un bloqueo terminado' : `${count} bloqueos terminados`;
      return points ? `${head} (${points})` : head;
    },
  },
  fiveMinutes: {
    title: 'Quedan 5 min',
    /** «YouTube, Instagram · hasta las 17:42». */
    body: (label: string, clock: string): string => `${label} · hasta las ${clock}`,
    also: 'quedan 5 min',
  },
  attempt: {
    /** «Intento bloqueado: −10 puntos», «3 intentos bloqueados: −70 puntos». */
    title: (count: number, points: string): string =>
      count === 1 ? `Intento bloqueado: ${points}` : `${count} intentos bloqueados: ${points}`,
    also: (count: number, points: string): string =>
      count === 1 ? `1 intento (${points})` : `${count} intentos (${points})`,
  },
  /**
   * Daily limits («YouTube máximo 30 minutos al día»). The titles come from the shared words
   * («Te quedan 5 min de YouTube hoy», «Has gastado tus 30 min de YouTube de hoy»).
   */
  limits: {
    /** Under «Has gastado…»: «Bloqueado hasta las 00:00». */
    reachedBody: (clock: string): string => `Bloqueado hasta las ${clock}`,
    reachedTitleMany: (count: number): string => `${count} límites diarios agotados`,
    reachedAlso: (count: number): string =>
      count === 1 ? 'un límite diario agotado' : `${count} límites diarios agotados`,
    warningTitleMany: (count: number): string => `${count} límites diarios a punto de agotarse`,
    warningAlso: (count: number): string =>
      count === 1 ? 'un límite diario a punto de agotarse' : `${count} límites a punto de agotarse`,
  },
  /** «También: 2 intentos (−30 puntos)». */
  also: (parts: readonly string[]): string => `También: ${parts.join(', ')}`,
  closeHint: {
    title: 'Céntrate sigue en la bandeja',
    body: 'Los bloqueos siguen activos.',
  },
} as const;

/** Shape every notification language file must match. */
export type NotifyMessages = Widen<typeof NOTIFY_ES>;
