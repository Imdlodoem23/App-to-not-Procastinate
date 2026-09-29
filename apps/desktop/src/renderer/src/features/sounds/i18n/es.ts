/**
 * Spanish strings of the concentration sounds (PROMPT §9 «Sonidos de concentración (lluvia,
 * ruido blanco, lo-fi) que funcionan sin internet», §10 «"Sonido" pasa por Nada, Lluvia, Ruido
 * blanco y Lo-fi con cada clic»). `en.ts` has the same shape (`SoundsMessages`).
 */
import type { AmbientSound } from '../../../../../shared/prefs';
import type { Widen } from '../../../../../shared/i18n/locale';

export const SOUNDS_ES = {
  names: {
    none: 'Nada',
    rain: 'Lluvia',
    'white-noise': 'Ruido blanco',
    lofi: 'Lo-fi',
  } satisfies Record<AmbientSound, string>,
  /** The tile that cycles on each click: «Sonido: Lluvia». */
  tile: (name: string): string => `Sonido: ${name}`,
  /** Its help: what the next click plays. */
  tileHelp: (next: string): string => `Un clic pasa a ${next}; suena sin internet`,
  /** When the file could not be read: the tile keeps its choice and says so. */
  unavailable: 'No se ha podido cargar el sonido',
} as const;

export type SoundsMessages = Widen<typeof SOUNDS_ES>;
