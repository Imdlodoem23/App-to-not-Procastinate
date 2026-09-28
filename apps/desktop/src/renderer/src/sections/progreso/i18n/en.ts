/**
 * English strings of section 4 «Progreso» (same shape as `es.ts`, `ProgresoMessages`).
 */
import type { ProgresoMessages } from './es';

export const PROGRESO_EN: ProgresoMessages = {
  /**
   * Section 2 takes «Homework» h, «Exam» e, «Read» a, «More…» o, the card's modes n t h e,
   * «Block» b, the extend row 5 0 h o, section 1 r d i and the footer m s q.
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
