/**
 * English strings of the Logros window (same shape as `es.ts`, `LogrosMessages`).
 */
import type { LogrosMessages } from './es';

export const LOGROS_EN: LogrosMessages = {
  title: (achieved: string, total: string): string => `Achievements: ${achieved} of ${total}`,
  loading: 'Reading your achievements…',
  last: (title: string): string => `Latest: ${title}`,
  rowLabel: 'Your achievements',
  rowHelp: 'Pick an achievement to see how to get it',
  status: {
    achieved: 'Earned',
    fresh: 'New',
    pending: 'Not yet',
    progress: (current: string, threshold: string): string => `${current} of ${threshold}`,
    hours: (current: string, threshold: string): string => `${current} of ${threshold} h`,
  },
  help: {
    achievedOn: (date: string): string => `Earned on ${date}`,
    achieved: 'Earned',
    pending: (how: string, progress: string): string => `${how} · ${progress}`,
    minutes: (current: string, threshold: string): string => `${current} of ${threshold}`,
  },
  errors: {
    load: 'I could not read your achievements',
    retry: 'Try again',
    retryHelp: 'Reads the log on this computer again',
  },
  keys: {
    retry: 't',
  },
};
