/**
 * Reminders (PROMPT §9 «Recordatorios»). Pure planning:
 *
 * - «Es tu hora de estudiar»: `leadMinutes` before the next schedule starts (the guardian's
 *   `state.nextSchedule`, so the app never re-implements schedule times). Shown once per
 *   occurrence; an app started inside the lead window shows it at once; nothing after the start
 *   (the «Bloqueo iniciado» notification says it then).
 * - 20-20-20: while blocks run without a break, every 20 minutes from the first one's start
 *   «mira algo a 6 metros durante 20 segundos», until the last one ends.
 */
import type { GuardianStateResponse, NextScheduleInfo } from '@centrate/shared/guardian-api';
import { EYE_BREAK_RULE, type ReminderPrefs } from '../../shared/prefs';

const MIN = 60_000;

export type ReminderKind = 'schedule' | 'eye-break';

export interface PlannedReminder {
  /** Identifies one occurrence (shown at most once). */
  key: string;
  kind: ReminderKind;
  /** When to show it (≥ now). */
  at: number;
  /** Schedule reminders: its name and start. */
  schedule: { name: string; startsAt: number; lead: boolean } | null;
}

/** «Es tu hora de estudiar» for `next`, unless off, already shown or already started. */
export function scheduleReminder(
  next: NextScheduleInfo | null,
  prefs: ReminderPrefs,
  nowMs: number,
  shown: ReadonlySet<string>,
): PlannedReminder | null {
  if (!prefs.schedules || !next) return null;
  const startsAt = Date.parse(next.startsAt);
  if (!Number.isFinite(startsAt) || nowMs >= startsAt) return null;
  const key = `schedule:${next.scheduleId}@${next.startsAt}`;
  if (shown.has(key)) return null;
  const at = startsAt - prefs.leadMinutes * MIN;
  return {
    key,
    kind: 'schedule',
    at: Math.max(at, nowMs),
    schedule: { name: next.name, startsAt, lead: prefs.leadMinutes > 0 },
  };
}

/**
 * The next 20-20-20 break: the running blocks' earliest start + k × 20 min, while it is before
 * the latest end. `null` without blocks or with the rule off.
 */
export function eyeBreakReminder(
  state: GuardianStateResponse | null,
  prefs: ReminderPrefs,
  nowMs: number,
  shown: ReadonlySet<string>,
): PlannedReminder | null {
  if (!prefs.eyeBreaks || !state || state.blocks.length === 0) return null;
  const starts = state.blocks.map((b) => Date.parse(b.startsAt)).filter(Number.isFinite);
  const ends = state.blocks.map((b) => Date.parse(b.endsAt)).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return null;
  const since = Math.min(...starts);
  const until = Math.max(...ends);
  const every = EYE_BREAK_RULE.everyMinutes * MIN;
  // The first boundary strictly after now (the scheduler shows the one it planned when due).
  let k = Math.max(1, Math.floor((nowMs - since) / every) + 1);
  if (shown.has(`eye:${since}:${k}`)) k += 1;
  const at = since + k * every;
  if (at >= until) return null;
  return { key: `eye:${since}:${k}`, kind: 'eye-break', at, schedule: null };
}

/** The earliest reminder due (ties: the schedule one). */
export function nextReminder(
  state: GuardianStateResponse | null,
  prefs: ReminderPrefs,
  nowMs: number,
  shown: ReadonlySet<string>,
): PlannedReminder | null {
  const candidates = [
    scheduleReminder(state?.nextSchedule ?? null, prefs, nowMs, shown),
    eyeBreakReminder(state, prefs, nowMs, shown),
  ].filter((r): r is PlannedReminder => r !== null);
  candidates.sort((a, b) => a.at - b.at || (a.kind === 'schedule' ? -1 : 1));
  return candidates[0] ?? null;
}
