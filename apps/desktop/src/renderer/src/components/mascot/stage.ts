/**
 * The mascot's phase (PROMPT §7 «Mascota o árbol», ARCHITECTURE §6.5), pure. Main computes it
 * from the synced event log (`snapshot.progress.mascot`: it knows when you gave up); until it
 * has read the log, today's minutes against the goal give the same growth, without the
 * wilting (only the log knows about a give-up).
 */
import type { PointsSummary } from '@centrate/shared/domain';
import { MASCOT_RULES, mascotStage, type MascotStage } from '@centrate/shared/points';
import type { UiSnapshot } from '../../../../shared/ui-state';

/** The phase to draw, or `null` without any guardian data. */
export function mascotStageOf(snapshot: Pick<UiSnapshot, 'progress' | 'state'>): MascotStage | null {
  if (snapshot.progress) return snapshot.progress.mascot;
  const points = snapshot.state?.points;
  if (!points) return null;
  return mascotStage({
    todayFocusMinutes: Math.max(0, points.today.focusMinutes),
    goalMinutes: points.today.goalMinutes,
    focusMinutesSinceGiveUp: null,
  });
}

/**
 * Focused minutes still needed today for the next phase (`sprout` → `plant` at half the goal,
 * `plant` → `tree` at the goal); `null` for a tree, a wilted mascot (its way back is
 * `MASCOT_RULES.recoveryFocusMinutes` of new focus) or when nothing is left (main's phase and
 * the poll disagree for a moment).
 */
export function minutesToGrow(
  stage: MascotStage,
  today: Pick<PointsSummary['today'], 'focusMinutes' | 'goalMinutes'>,
): number | null {
  const goal = Math.max(1, today.goalMinutes);
  const focus = Math.max(0, today.focusMinutes);
  let target: number;
  if (stage === 'sprout') target = Math.ceil((goal * MASCOT_RULES.plantAtGoalPercent) / 100);
  else if (stage === 'plant') target = goal;
  else return null;
  const left = Math.ceil(target - focus);
  return left > 0 ? left : null;
}
