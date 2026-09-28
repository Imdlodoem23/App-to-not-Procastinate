import { durationLabel } from '../parser/format';
import type { AchievementMetric } from '../points';
import type { SharedMessages } from './es';
import { formatInteger } from './format';

/** English shared strings (same shape as `es.ts`). */
export const SHARED_EN: SharedMessages = {
  achievements: {
    titles: {
      'first-session': 'First session',
      'first-block': 'First block',
      'streak-7': '7-day streak',
      'study-10h': '10 h of Study Mode',
      'clean-week': 'A week without attempts',
      'sessions-25': '25 sessions',
      'streak-30': '30-day streak',
      'study-50h': '50 h of Study Mode',
    },
    help: (metric: AchievementMetric, threshold: number): string => {
      const n = formatInteger(threshold, 'en');
      switch (metric) {
        case 'completedStudySessions':
          return threshold === 1
            ? 'Finish a Study Mode session'
            : `Finish ${n} Study Mode sessions`;
        case 'completedBlocks':
          return threshold === 1
            ? 'Complete a block to the end'
            : `Complete ${n} blocks to the end`;
        case 'bestStreakDays':
          return threshold === 1
            ? 'Meet your daily goal for a day'
            : `Meet your daily goal ${n} days in a row`;
        case 'focusMinutesTotal':
          return `Spend ${durationLabel(threshold, 'en')} focused in Study Mode`;
        case 'bestCleanDayRun':
          return threshold === 1
            ? 'Spend a day with activity and no attempts'
            : `Spend ${n} days in a row with activity and no attempts`;
      }
    },
  },
};
