/**
 * «Duración» of the Bloqueos form (PROMPT §4): 5 min to 24 h, or «Hasta las HH:MM». The two
 * fields stay in sync: typing a duration makes the end follow the clock; typing a time fixes
 * the end («hasta las 18:30») and the duration follows. Words are read with the shared parser
 * («45 min», «2 h», «1h30», «hora y media»), so the form understands what the main field does.
 * Pure: no DOM, Node or Electron imports.
 */
import type { IsoUtc } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import { durationLabel, parseIntent } from '@centrate/shared/parser';
import { formatClock } from '../../../../shared/format';
import {
  draftEndsAtMs,
  draftMinutes,
  type BlockDraft,
  type DraftEnd,
} from '../../../../shared/ui-state';
import { BLOQUEOS } from './i18n';

const D = BLOQUEOS.duration;
const MIN = 60_000;

/** Preset tiles: 30 min | 1 h | 2 h | 3 h. */
export const DURATION_PRESETS = [30, 60, 120, 180] as const;

export type EndParse = { ok: true; end: DraftEnd } | { ok: false; error: string };

function rangeError(minutes: number): string | null {
  if (minutes < GUARDIAN_LIMITS.blockMinMinutes) return D.tooShort;
  if (minutes > GUARDIAN_LIMITS.blockMaxMinutes) return D.tooLong;
  return null;
}

/** «45 min», «2 h», «1h30», «hora y media», or a bare number of minutes («90»). */
export function parseDurationText(text: string, nowMs: number): EndParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: D.invalidMinutes };
  let minutes: number | null = null;
  if (/^\d{1,4}$/.test(trimmed)) minutes = Number(trimmed);
  else {
    const parse = parseIntent(trimmed, { now: new Date(nowMs) });
    const hasDuration = parse.chips.some((c) => c.kind === 'duration');
    if (hasDuration && parse.durationMinutes !== undefined) minutes = parse.durationMinutes;
  }
  if (minutes === null) return { ok: false, error: D.invalidMinutes };
  const problem = rangeError(minutes);
  return problem ? { ok: false, error: problem } : { ok: true, end: { kind: 'duration', minutes } };
}

/** Next local occurrence of hh:mm strictly after `nowMs` (today, else tomorrow). */
export function nextClockTime(hours: number, minutes: number, nowMs: number): number {
  const date = new Date(nowMs);
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= nowMs) date.setDate(date.getDate() + 1);
  return date.getTime();
}

/** «18:30», «18.30», «1830», «18», or the parser's «mañana a las 8». */
export function parseUntilText(text: string, nowMs: number): EndParse {
  const trimmed = text.trim();
  const clock = /^(\d{1,2})(?:[:.h]?(\d{2}))?$/.exec(trimmed);
  let endsAtMs: number | null = null;
  if (clock) {
    const h = Number(clock[1]);
    const m = clock[2] === undefined ? 0 : Number(clock[2]);
    if (h <= 23 && m <= 59) endsAtMs = nextClockTime(h, m, nowMs);
  } else if (trimmed !== '') {
    for (const phrase of [`hasta las ${trimmed}`, `hasta ${trimmed}`]) {
      const parse = parseIntent(phrase, { now: new Date(nowMs) });
      if (parse.chips.some((c) => c.kind === 'until') && parse.endsAt) {
        endsAtMs = Date.parse(parse.endsAt);
        break;
      }
    }
  }
  if (endsAtMs === null) return { ok: false, error: D.invalidUntil };
  const minutes = Math.ceil((endsAtMs - nowMs) / MIN);
  const problem = rangeError(minutes);
  if (problem) return { ok: false, error: problem };
  const endsAt: IsoUtc = new Date(endsAtMs).toISOString();
  return { ok: true, end: { kind: 'until', endsAt } };
}

export interface DurationFields {
  /** «1 h 30 min». */
  minutesText: string;
  /** «18:30». */
  untilText: string;
  minutes: number;
  endsAtMs: number;
}

/** What both fields show for a draft now. */
export function durationFields(draft: BlockDraft, nowMs: number): DurationFields {
  const minutes = Math.max(0, draftMinutes(draft, nowMs));
  const endsAtMs = draftEndsAtMs(draft, nowMs);
  return {
    minutesText: durationLabel(minutes),
    untilText: formatClock(endsAtMs),
    minutes,
    endsAtMs,
  };
}

/** The selected preset tile, if the draft is exactly one of them. */
export function selectedPreset(draft: BlockDraft): number | null {
  if (draft.end.kind !== 'duration') return null;
  const minutes = draft.end.minutes;
  return (DURATION_PRESETS as readonly number[]).includes(minutes) ? minutes : null;
}
