/**
 * English strings of section 4 «Progreso» (same shape as `es.ts`, `ProgresoMessages`).
 */
import type { ProgresoMessages } from './es';

export const PROGRESO_EN: ProgresoMessages = {
  /**
   * Section 1 takes r d i, the footer m s q, and section 2 the first free letter of its labels
   * (0 5 a b e h n o p t y across the fixtures).
   */
  mnemonics: { stats: 'c', rewards: 'w', achievements: 'v' },
  achievementsCount: (achieved: string, total: string): string =>
    `${achieved} of ${total} earned: see how to get the rest`,
  achievementsFresh: (title: string): string => `New achievement: ${title}`,
  achievementsFreshMany: (count: string): string => `${count} new achievements`,
  rewardsLocked: {
    hardcore: 'Closed while the Hardcore block lasts',
    exam: 'Closed while the exam lasts',
    punishment: 'Closed while the punishment lasts',
    study: 'Closed during Study Mode',
    emergency: 'Closed while an emergency unlock is pending',
  },
};
