/**
 * Which achievements the Logros grid shows and counts (PROMPT §10 «Oculta lo que no aplica»).
 * Only Study Mode can earn the sessions and study-hours ones, so they show only while Study
 * Mode does (flag and guardian capability). Pure and tiny: the main window's Progreso door
 * imports it without the Logros window's code.
 */
import {
  ACHIEVEMENTS,
  type Achievement,
  type AchievementId,
  type AchievementMetric,
} from '@centrate/shared/points';
import type { ProgressState } from '../../../../shared/platform';

/** Metrics only Study Mode can move: their achievements hide while Study Mode does. */
const STUDY_METRICS: ReadonlySet<AchievementMetric> = new Set<AchievementMetric>([
  'completedStudySessions',
  'focusMinutesTotal',
]);

/** Whether only Study Mode can earn it («Primera sesión», «10 h de Study Mode»…). */
export function isStudyAchievement(achievement: Achievement): boolean {
  return STUDY_METRICS.has(achievement.metric);
}

/**
 * The achievements that can be earned now, in display order: every one with Study Mode shown
 * (`featureEnabled(features, 'study', capabilities)`), else the ones that do not need it.
 */
export function visibleAchievements(study: boolean): readonly Achievement[] {
  return study ? ACHIEVEMENTS : ACHIEVEMENTS.filter((a) => !isStudyAchievement(a));
}

/** Whether `id` is shown in the grid (and counted) with Study Mode shown or not. */
export function isVisibleAchievement(id: AchievementId, study: boolean): boolean {
  return visibleAchievements(study).some((a) => a.id === id);
}

/**
 * `snapshot.progress` counted over the shown achievements only. Main counts all of them; the
 * hidden Study Mode ones cannot be reached while hidden, so they leave the total, and the
 * reached count never goes over it. `fresh` keeps only the shown ones.
 */
export function progressCount(
  progress: ProgressState,
  study: boolean,
): { achieved: number; total: number; fresh: AchievementId[] } {
  const total = Math.min(progress.total, visibleAchievements(study).length);
  return {
    achieved: Math.max(0, Math.min(progress.achieved, total)),
    total,
    fresh: progress.fresh.filter((id) => isVisibleAchievement(id, study)),
  };
}
