/**
 * English strings of the Logros window (same shape as `es.ts`, `LogrosMessages`).
 */
import type { LogrosMessages } from './es';

export const LOGROS_EN: LogrosMessages = {
  title: (achieved: string, total: string): string => `Achievements: ${achieved} of ${total}`,
  titleLoading: 'Achievements',
  loading: 'Reading your achievements…',
  last: (title: string): string => `Latest: ${title}`,
  fresh: (title: string): string => `New: ${title}`,
  freshMany: (count: string): string => `${count} new achievements`,
  rowLabel: 'Your achievements',
  rowHelp: 'Point at an achievement to see how to get it',
  rowHelpNone: 'None yet: point at one to see how to get it',
  help: {
    achievedOn: (date: string): string => `Earned on ${date}`,
    achieved: 'Earned',
    freshOn: (date: string): string => `New: earned on ${date}`,
    fresh: 'New: you just earned it',
    pending: (how: string, progress: string): string => `${how} · ${progress}`,
    progress: (current: string, threshold: string): string => `${current} of ${threshold}`,
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
