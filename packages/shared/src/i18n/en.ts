import { dailyLabel, daysLabel, durationLabel } from '../parser/format';
import type { AchievementMetric } from '../points';
import { usedOfLabel, type SharedMessages } from './es';
import { formatInteger } from './format';

/** English shared strings (same shape as `es.ts`). Conventions: en-US spelling, sentence case. */
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
          return threshold === 1 ? 'Complete a block' : `Complete ${n} blocks`;
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
  dailyLimits: {
    title: 'Daily limit',
    sectionTitle: 'Daily limits',
    perDay: (dailyMinutes: number): string => dailyLabel(dailyMinutes, 'en'),
    days: (days: readonly number[]): string => daysLabel(days, 'en'),
    usedToday: (usedMinutes: number, dailyMinutes: number): string =>
      `${usedOfLabel(usedMinutes, dailyMinutes, 'en', 'of')} today`,
    blockedUntilTomorrow: 'Blocked until tomorrow',
    warning: (name: string, minutesLeft: number): string =>
      `You have ${durationLabel(minutesLeft, 'en')} of ${name} left today`,
    reached: (name: string, dailyMinutes: number): string =>
      `You've used up your ${durationLabel(dailyMinutes, 'en')} of ${name} for today`,
    blockedPage: (name: string, dailyMinutes: number): string =>
      `You've used your ${durationLabel(dailyMinutes, 'en')} of ${name} for today. Come back tomorrow.`,
    blockCard: (name: string, time: string): string =>
      `Daily limit for ${name}: blocked until ${time}`,
  },
};
