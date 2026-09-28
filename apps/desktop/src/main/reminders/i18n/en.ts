/** English copy of the reminders (same shape as `es.ts`). */
import type { RemindersMessages } from './es';

export const REMINDERS_EN: RemindersMessages = {
  schedule: {
    title: 'Time to study',
    soon: (name: string, clock: string): string => `${name} starts at ${clock}`,
    now: (name: string): string => `${name} starts now`,
  },
  eyeBreak: {
    title: 'Eye break',
    body: 'Look at something 20 feet away for 20 seconds',
  },
};
