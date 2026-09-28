/**
 * English copy of the native notifications (same shape as `es.ts`). Points and clock times
 * arrive formatted («+80 points», «−10 points», «5:42 PM»).
 */
import type { NotifyMessages } from './es';

export const NOTIFY_EN: NotifyMessages = {
  started: {
    title: (count: number): string => (count === 1 ? 'Block started' : `${count} blocks started`),
    body: (label: string, clock: string): string => `${label} until ${clock}`,
    also: (count: number): string =>
      count === 1 ? 'one block started' : `${count} blocks started`,
  },
  finished: {
    title: (count: number): string => (count === 1 ? 'Block finished' : `${count} blocks finished`),
    body: (points: string | null): string => (points ? `Done. ${points}` : 'Done.'),
    also: (count: number, points: string | null): string => {
      const head = count === 1 ? 'one block finished' : `${count} blocks finished`;
      return points ? `${head} (${points})` : head;
    },
  },
  fiveMinutes: {
    title: '5 min left',
    body: (label: string, clock: string): string => `${label} · until ${clock}`,
    also: '5 min left',
  },
  attempt: {
    title: (count: number, points: string): string =>
      count === 1 ? `Attempt blocked: ${points}` : `${count} attempts blocked: ${points}`,
    also: (count: number, points: string): string =>
      count === 1 ? `1 attempt (${points})` : `${count} attempts (${points})`,
  },
  also: (parts: readonly string[]): string => `Also: ${parts.join(', ')}`,
  closeHint: {
    title: 'Céntrate is still in the tray',
    body: 'Your blocks stay active.',
  },
};
