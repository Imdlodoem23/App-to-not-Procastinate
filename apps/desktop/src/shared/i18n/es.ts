/**
 * Spanish strings shared by the main process (tray, window title, notifications) and the
 * renderers: mode names, target lists, remaining-time phrases, points and the default
 * templates. Strings used by a single owner live next to its code in its own `i18n/es.ts`
 * (docs/DESKTOP.md §3). `en.ts` has the same shape (`SharedMessages`); `index.ts` serves the active one.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import type { BlockMode } from '@centrate/shared/domain';
import type { Widen } from './locale';

export const SHARED_ES = {
  appName: 'Céntrate',
  modes: {
    normal: 'Normal',
    strict: 'Estricto',
    hardcore: 'Hardcore',
    exam: 'Examen',
  } satisfies Record<BlockMode, string>,
  /** Catalog category names (the same as the catalog's own Spanish `name`). */
  categories: {
    social: 'Redes sociales',
    video: 'Vídeo y streaming',
    games: 'Juegos',
    messaging: 'Mensajería',
    shopping: 'Compras',
    news: 'Noticias y deportes',
  } satisfies Record<CategoryId, string>,
  targets: {
    whitelistOnly: 'Todo salvo la lista blanca',
    none: 'Nada',
    separator: ', ',
    more: (count: number): string => `+${count}`,
  },
  remaining: {
    /** «quedan 42 min» / «queda 1 min». `label` comes from `durationLabel`. */
    words: (minutes: number, label: string): string =>
      minutes === 1 ? `queda ${label}` : `quedan ${label}`,
    /** Countdown `aria-label`: «Quedan 43 minutos», «Quedan 1 hora y 5 minutos». */
    aria: (hours: number, minutes: number): string => {
      const parts: string[] = [];
      if (hours > 0) parts.push(hours === 1 ? '1 hora' : `${hours} horas`);
      if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minuto' : `${minutes} minutos`);
      const one = (hours === 1 && minutes === 0) || (hours === 0 && minutes === 1);
      return `${one ? 'Queda' : 'Quedan'} ${parts.join(' y ')}`;
    },
    /** Spoken at 15, 5 and 1 min (`aria-live="polite"`). */
    announce: (minutes: number): string =>
      minutes === 1 ? 'Queda 1 minuto' : `Quedan ${minutes} minutos`,
    ended: 'Bloqueo terminado',
  },
  points: {
    /** «1.240 puntos», «1 punto», «−10 puntos». `amount` is already formatted. */
    long: (amount: string, value: number): string =>
      Math.abs(value) === 1 ? `${amount} punto` : `${amount} puntos`,
    /** «1.240 pts» (tray tooltip). */
    short: (amount: string): string => `${amount} pts`,
  },
  templates: {
    deberes: 'Deberes 1 h',
    examen: 'Examen 3 h',
    leer: 'Leer 30 min',
  },
} as const;

/** Shape every language file must match. */
export type SharedMessages = Widen<typeof SHARED_ES>;
