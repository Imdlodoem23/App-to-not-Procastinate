/**
 * «Horarios» of the Bloqueos window (PROMPT §9, §10): one row per schedule, «L–V 16:00–19:00 ·
 * Redes sociales», with «Editar» and a switch. Turning one off is a weakening edit: the guardian
 * refuses it while an occurrence runs and in the 10 min before the next one starts, so the switch
 * says so instead of failing. Turning one on is always allowed. A running schedule cannot be
 * edited either («sin tocar uno que ya esté en curso»). Pure.
 *
 * Also the clock and day labels the editor (`schedule-editor.ts`) shares with the rows.
 */
import type { IsoWeekday, Schedule } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS, type ScheduleInput } from '@centrate/shared/guardian-api';
import { formatClock, modeLabel, targetsLabel } from '../../../../shared/format';
import { activeLocale } from '../../../../shared/i18n/locale';
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

// ---------------------------------------------------------------------------------------
// Clock times
// ---------------------------------------------------------------------------------------

const CLOCK_RE = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?$/i;
const COMPACT_RE = /^(\d{2})(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * What the user typed in «Desde» / «Hasta» as the guardian's `HH:MM`: «16:00», «16», «1600»,
 * «16.30», «16h30» and the English «4 PM», «4:30 pm». `null` when it is not a time.
 */
export function parseClockText(text: string): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  const compact = COMPACT_RE.exec(trimmed);
  let hours: number;
  let minutes: number;
  let meridiem: string | undefined;
  if (compact) {
    hours = Number(compact[1]);
    minutes = Number(compact[2]);
  } else {
    const match = CLOCK_RE.exec(trimmed);
    if (!match) return null;
    hours = Number(match[1]);
    minutes = match[2] === undefined ? 0 : Number(match[2]);
    meridiem = match[3]?.toLowerCase().replace(/[\s.]/g, '');
  }
  if (meridiem !== undefined) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

/**
 * A guardian `HH:MM` on the active locale's clock («16:00», «4:00 PM»). Only the wall-clock time
 * is read (any fixed day works); what is not a time comes back as it is.
 */
export function clockLabel(time: string): string {
  const parsed = parseClockText(time);
  if (parsed === null) return time;
  if (activeLocale() !== 'en') return parsed;
  const date = new Date(2026, 0, 5, Number(parsed.slice(0, 2)), Number(parsed.slice(3, 5)));
  return formatClock(date.getTime());
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

/** Examen blocks everything but the whitelist: it takes no targets. */
export function isWhitelistSchedule(input: Pick<ScheduleInput, 'mode' | 'whitelistOnly'>): boolean {
  return input.mode === 'exam' || input.whitelistOnly;
}

/** «L–V 16:00–19:00 · Redes sociales» (the row, and the editor's title while it is edited). */
export function scheduleSummary(
  input: Pick<ScheduleInput, 'days' | 'start' | 'end' | 'targets' | 'mode' | 'whitelistOnly'>,
): string {
  const days = input.days.length === 0 ? S.noDays : daysLabel(input.days);
  return S.row(
    days,
    clockLabel(input.start),
    clockLabel(input.end),
    targetsLabel(input.targets, isWhitelistSchedule(input), 2),
  );
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
  /** Why «Editar» is disabled (an occurrence is running), or `null`. */
  editLock: string | null;
  /** This row is open in the editor below the list. */
  editing: boolean;
  /** Alt + letter of «Editar». */
  editKey: string | undefined;
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
  options: { editing?: boolean; editKey?: string | undefined } = {},
): ScheduleRowView {
  const lock = scheduleLock(schedule, nowMs);
  const saving = pending !== undefined;
  const editing = options.editing === true;
  return {
    id: schedule.id,
    title: scheduleSummary(schedule),
    description: saving
      ? S.saving
      : editing
        ? S.editing
        : (lock ?? S.desc(schedule.name, modeLabel(schedule.mode))),
    enabled: pending ?? schedule.enabled,
    locked: lock !== null && !saving,
    saving,
    editLock: schedule.activeBlockId !== null ? S.running : null,
    editing,
    editKey: options.editKey,
  };
}
