/** Spanish copy of the reminders (PROMPT §9 «Recordatorios»): native notifications. */
import type { Widen } from '../../../shared/i18n/locale';

export const REMINDERS_ES = {
  schedule: {
    title: 'Es tu hora de estudiar',
    /** «Tardes de estudio empieza a las 16:00». */
    soon: (name: string, clock: string): string => `${name} empieza a las ${clock}`,
    /** Lead 0: shown at the start. */
    now: (name: string): string => `${name} empieza ahora`,
  },
  eyeBreak: {
    title: 'Descanso para la vista',
    body: 'Mira algo a 6 metros durante 20 segundos',
  },
} as const;

export type RemindersMessages = Widen<typeof REMINDERS_ES>;
