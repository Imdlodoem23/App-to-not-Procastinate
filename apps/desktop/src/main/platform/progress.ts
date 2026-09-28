/**
 * `snapshot.progress` (PROMPT §7 «Mascota», «Logros»): the mascot's phase from today's focus and
 * the log since the last give-up, and the achievements reached (those not seen in Logros yet are
 * `fresh`). Pure.
 */
import type { WireEvent } from '@centrate/shared/domain';
import { ACHIEVEMENTS, focusMinutesSinceGiveUp, mascotStage } from '@centrate/shared/points';
import type { AchievementStatus, ProgressState } from '../../shared/platform';
import { freshAchievements, type SeenAchievements } from '../db/stats-seen';

export interface ProgressInput {
  achievements: readonly AchievementStatus[];
  /** The current epoch's events, oldest first. */
  events: readonly WireEvent[];
  today: { focusMinutes: number; goalMinutes: number };
  seen: SeenAchievements;
  epoch: string | null;
}

export function progressState(input: ProgressInput): ProgressState {
  const reached = input.achievements.filter((a) => a.achieved).map((a) => a.id);
  return {
    mascot: mascotStage({
      todayFocusMinutes: input.today.focusMinutes,
      goalMinutes: input.today.goalMinutes,
      focusMinutesSinceGiveUp: focusMinutesSinceGiveUp(input.events),
    }),
    achieved: reached.length,
    total: ACHIEVEMENTS.length,
    fresh: freshAchievements(reached, input.seen, input.epoch),
  };
}
