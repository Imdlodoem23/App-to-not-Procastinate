/**
 * «Horarios» of the Bloqueos window (PROMPT §9, §10): one row per schedule, «L–V 16:00–19:00 ·
 * Redes sociales», with a switch. Turning one off is a weakening edit: the guardian refuses it
 * while an occurrence runs and in the 10 min before the next one starts, so the switch says so
 * instead of failing. Turning one on is always allowed. Pure.
 */
import type { IsoWeekday, Schedule } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import { modeLabel, targetsLabel } from '../../../../shared/format';
import { BLOQUEOS } from './i18n';

const S = BLOQUEOS.schedules;

/** «L–V», «S, D», «L, X, V», «Todos los días» (runs of 3 or more days become a range). */
export function daysLabel(days: readonly IsoWeekday[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return S.everyDay;
  const letter = (d: number): string => S.days[d - 1] ?? String(d);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j += 1;
    const first = sorted[i] as number;
    const last = sorted[j] as number;
    if (j - i >= 2) parts.push(S.range(letter(first), letter(last)));
    else for (let k = i; k <= j; k += 1) parts.push(letter(sorted[k] as number));
    i = j + 1;
  }
  return parts.join(S.daySeparator);
}

export interface ScheduleRowView {
  id: Schedule['id'];
  /** «L–V 18:00–20:00 · Redes sociales». */
  title: string;
  /** «Tardes de estudio · Normal», or why the switch cannot move. */
  description: string;
  enabled: boolean;
  /** The switch cannot be moved now (`description` says why). */
  locked: boolean;
  saving: boolean;
}

/** Why turning an enabled schedule off is refused now, or `null`. */
export function scheduleLock(schedule: Schedule, nowMs: number): string | null {
  if (!schedule.enabled) return null;
  if (schedule.activeBlockId !== null) return S.running;
  const next = schedule.nextOccurrence ? Date.parse(schedule.nextOccurrence.startsAt) : null;
  if (
    next !== null &&
    next > nowMs &&
    next - nowMs <= GUARDIAN_LIMITS.scheduleFreezeMinutes * 60_000
  ) {
    return S.frozen;
  }
  return null;
}

export function scheduleRow(
  schedule: Schedule,
  nowMs: number,
  pending: boolean | undefined,
): ScheduleRowView {
  const lock = scheduleLock(schedule, nowMs);
  const saving = pending !== undefined;
  return {
    id: schedule.id,
    title: S.row(
      daysLabel(schedule.days),
      schedule.start,
      schedule.end,
      targetsLabel(schedule.targets, schedule.whitelistOnly, 2),
    ),
    description: saving ? S.saving : (lock ?? S.desc(schedule.name, modeLabel(schedule.mode))),
    enabled: pending ?? schedule.enabled,
    locked: lock !== null && !saving,
    saving,
  };
}
