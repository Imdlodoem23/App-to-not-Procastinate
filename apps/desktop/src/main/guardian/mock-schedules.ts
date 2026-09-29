/**
 * Schedule times and guards for the `MockGuardian` (ARCHITECTURE §5.3, §8.8 «Guards for PUT and
 * DELETE», §10.3), so the dev mock and the harness's fake guardian refuse what the real one
 * refuses:
 *
 * - occurrences: `days` (ISO weekdays of the **start**), `start`/`end` (`end <= start` is
 *   overnight) in the schedule's IANA time zone; a time in a DST gap moves past the gap, an
 *   overlap takes the earliest;
 * - `nextOccurrence`: the earliest start after now within 8 days (`null` when disabled);
 * - weakening edits (refused within 10 min of the next start, like a delete): disabling, fewer
 *   targets or days, another time zone, a window that does not contain the old one, a milder
 *   mode, whitelist → list, more `allow` entries. Renaming and the reason are neutral.
 *
 * Pure.
 */
import type {
  WhitelistAllow,
  BlockMode,
  IsoWeekday,
  Schedule,
  TargetSpec,
} from '@centrate/shared/domain';
import type { ScheduleInput } from '@centrate/shared/guardian-api';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** `nextOccurrence` looks this far ahead. */
const LOOKAHEAD_DAYS = 8;

/** The part of a schedule its times depend on. */
export type ScheduleTimes = Pick<Schedule, 'enabled' | 'days' | 'start' | 'end' | 'timezone'>;

export interface Occurrence {
  /** `scheduleId@YYYY-MM-DD` (the local date of the start). */
  key: string;
  start: number;
  end: number;
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const partsFormat = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormat.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormat.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of `ms` in `timeZone`, as a UTC timestamp (for offsets). */
function wallAsUtc(ms: number, timeZone: string): number {
  const parts = formatFor(timeZone).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
}

export function localDateOf(ms: number, timeZone: string): LocalDate {
  const wall = new Date(wallAsUtc(ms, timeZone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

export function addLocalDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function isoWeekday(d: LocalDate): IsoWeekday {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return (w === 0 ? 7 : w) as IsoWeekday;
}

export function dateKey(d: LocalDate): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

function clockMinutes(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The instant the wall clock of `timeZone` shows `minutes` after midnight of `date`. A time in
 * a DST gap gives an instant after the gap (the wall time read with the offset before it); an
 * ambiguous one (overlap) the earliest.
 */
export function zonedInstant(date: LocalDate, minutes: number, timeZone: string): number {
  const wanted = Date.UTC(date.year, date.month - 1, date.day) + minutes * MIN;
  // Offsets around the wanted wall time (the earliest candidate wins in an overlap).
  const candidates = new Set<number>();
  for (const probe of [wanted - DAY / 2, wanted, wanted + DAY / 2]) {
    const offset = wallAsUtc(probe, timeZone) - probe;
    candidates.add(wanted - offset);
  }
  const exact = [...candidates]
    .filter((t) => wallAsUtc(t, timeZone) === wanted)
    .sort((a, b) => a - b);
  if (exact[0] !== undefined) return exact[0];
  // In a gap: the latest candidate lies after it.
  return Math.max(...candidates);
}

/** The first instant of the local day of `ms` in `timeZone`. */
export function startOfLocalDay(ms: number, timeZone: string): number {
  return zonedInstant(localDateOf(ms, timeZone), 0, timeZone);
}

/** The first instant whose local date (in `timeZone`) is the day after that of `ms`. */
export function nextLocalMidnight(ms: number, timeZone: string): number {
  return zonedInstant(addLocalDays(localDateOf(ms, timeZone), 1), 0, timeZone);
}

function validZone(timeZone: string): boolean {
  try {
    formatFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Window length in minutes; overnight when `end <= start`. */
function windowMinutes(start: number, end: number): number {
  return end > start ? end - start : end + 1440 - start;
}

/** The occurrence that starts on the local `date`, if the schedule runs that weekday. */
export function occurrenceOn(
  id: string,
  schedule: ScheduleTimes,
  date: LocalDate,
): Occurrence | null {
  const start = clockMinutes(schedule.start);
  const end = clockMinutes(schedule.end);
  if (start === null || end === null || start === end) return null;
  if (!validZone(schedule.timezone)) return null;
  if (!schedule.days.includes(isoWeekday(date))) return null;
  const startMs = zonedInstant(date, start, schedule.timezone);
  const endDate = end > start ? date : addLocalDays(date, 1);
  let endMs = zonedInstant(endDate, end, schedule.timezone);
  if (endMs <= startMs) endMs = startMs + windowMinutes(start, end) * MIN;
  return { key: `${id}@${dateKey(date)}`, start: startMs, end: endMs };
}

/** The occurrence running at `nowMs` (started yesterday or today, not ended), if any. */
export function currentOccurrence(
  id: string,
  schedule: ScheduleTimes,
  nowMs: number,
): Occurrence | null {
  if (!schedule.enabled || !validZone(schedule.timezone)) return null;
  const today = localDateOf(nowMs, schedule.timezone);
  for (const date of [addLocalDays(today, -1), today]) {
    const occ = occurrenceOn(id, schedule, date);
    if (occ && occ.start <= nowMs && nowMs < occ.end) return occ;
  }
  return null;
}

/** The earliest start after `nowMs` within 8 days; `null` when disabled or none. */
export function nextOccurrence(
  id: string,
  schedule: ScheduleTimes,
  nowMs: number,
): Occurrence | null {
  if (!schedule.enabled || !validZone(schedule.timezone)) return null;
  const today = localDateOf(nowMs, schedule.timezone);
  for (let i = 0; i <= LOOKAHEAD_DAYS; i += 1) {
    const occ = occurrenceOn(id, schedule, addLocalDays(today, i));
    if (occ && occ.start > nowMs && occ.start - nowMs <= LOOKAHEAD_DAYS * DAY) return occ;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Weakening edits
// ---------------------------------------------------------------------------------------

const MODE_RANK: Readonly<Record<BlockMode, number>> = {
  normal: 0,
  strict: 1,
  hardcore: 2,
  exam: 3,
};

const WEEK_MINUTES = 7 * 1440;

function weekMask(days: readonly IsoWeekday[], start: number, end: number): Uint8Array {
  const mask = new Uint8Array(WEEK_MINUTES);
  const length = windowMinutes(start, end);
  for (const day of days) {
    const base = (day - 1) * 1440 + start;
    for (let i = 0; i < length; i += 1) mask[(base + i) % WEEK_MINUTES] = 1;
  }
  return mask;
}

/** Every minute the old schedule covered is still covered (days and window together). */
function coversOld(before: ScheduleTimes, after: ScheduleTimes): boolean {
  const bs = clockMinutes(before.start);
  const be = clockMinutes(before.end);
  const as = clockMinutes(after.start);
  const ae = clockMinutes(after.end);
  if (bs === null || be === null || bs === be) return true;
  if (as === null || ae === null || as === ae) return false;
  const was = weekMask(before.days, bs, be);
  const now = weekMask(after.days, as, ae);
  for (let i = 0; i < WEEK_MINUTES; i += 1) if (was[i] === 1 && now[i] !== 1) return false;
  return true;
}

function removesAny(was: readonly string[], now: readonly string[]): boolean {
  return was.some((x) => !now.includes(x));
}

function dropsTargets(before: TargetSpec, after: TargetSpec): boolean {
  return (
    removesAny(before.categoryIds, after.categoryIds) ||
    removesAny(before.serviceIds, after.serviceIds) ||
    removesAny(before.appIds, after.appIds) ||
    removesAny(before.customDomains, after.customDomains) ||
    removesAny(before.customProcesses, after.customProcesses)
  );
}

function addsAllow(before: WhitelistAllow, after: WhitelistAllow): boolean {
  return (
    removesAny(after.customDomains, before.customDomains) ||
    removesAny(after.customProcesses, before.customProcesses)
  );
}

/** Whether saving `after` over `before` weakens the schedule (ARCHITECTURE §10.3). */
export function scheduleEditWeakens(before: Schedule, after: ScheduleInput): boolean {
  if (before.enabled && !after.enabled) return true;
  if (before.timezone !== after.timezone) return true;
  if (MODE_RANK[after.mode] < MODE_RANK[before.mode]) return true;
  if (!coversOld(before, after)) return true;
  if (before.whitelistOnly) return !after.whitelistOnly || addsAllow(before.allow, after.allow);
  // A whitelist blocks everything else: never weaker than a list of targets.
  return !after.whitelistOnly && dropsTargets(before.targets, after.targets);
}
