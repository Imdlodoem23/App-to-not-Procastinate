/** English strings of the concentration sounds (same shape as `es.ts`, `SoundsMessages`). */
import type { SoundsMessages } from './es';

export const SOUNDS_EN: SoundsMessages = {
  names: {
    none: 'None',
    rain: 'Rain',
    'white-noise': 'White noise',
    lofi: 'Lo-fi',
  },
  tile: (name: string): string => `Sound: ${name}`,
  tileHelp: (next: string): string => `One click switches to ${next}; works offline`,
  unavailable: 'The sound could not be loaded',
};
