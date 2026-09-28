/**
 * Statistics from the local copy of the guardian's event log (PROMPT §9 «Estadísticas», §7
 * «Logros», docs/DESKTOP.md §15). Pure: the events come in already parsed (`db/stats.ts` reads
 * them), times are display time (`at + wallOffsetMs`) in the process's local time zone, and
 * nothing here touches the disk.
 *
 * Minutes are attributed to the hours they were lived: a `focus_minutes` chunk and the credited
 * minutes of a completed block are spread **backwards** from the event's time over whole local
 * hours, so a block that ran 16:30–18:00 counts 30 min at 16 h and 60 min at 17 h. Points and
 * attempts count where their event happened. Every total is the sum of its buckets.
 *
 * What a row of the event log shows is chosen here: a type, a time, points and at most a target
 * (service, category, domain, app, schedule name or browser), minutes and a mode. Reasons,
 * Study Mode tasks and every other free text of the raw event stay in main.
 */
import type { BlockMode, GuardianEvent, LocalDay, WireEvent } from '@centrate/shared/domain';
import { isKnownEvent } from '@centrate/shared/domain';
import {
  ACHIEVEMENTS,
  POINT_RULES,
  addDays,
  applyLedgerInput,
  dayNumber,
  initialLedgerState,
  ledgerInputFromEvent,
  type AchievementId,
  type LedgerState,
} from '@centrate/shared/points';
import type { AchievementStatus } from '../../shared/platform';
import {
  STATS_LIMITS,
  daysBetween,
  heatmapLevel,
  statsPeriod,
  type EventLogEntry,
  type EventLogFilter,
  type HeatmapCell,
  type HourStat,
  type StatsBucket,
  type StatsHeatmap,
  type StatsOverview,
  type StatsQuery,
  type StatsRange,
  type StatsTotals,
  type TopTarget,
} from '../../shared/stats';

const MIN = 60_000;

/** One row of the local `events` table with its raw JSON parsed (`null` if unreadable). */
export interface StoredEvent {
  epoch: string;
  seq: number;
  type: string;
  at: string;
  wallOffsetMs: number;
  /** The envelope's local day (guardian time zone). */
  day: string;
  points: number;
  xp: number;
  event: WireEvent | null;
}

/** The known event, if the row holds one. */
export function knownEvent(row: StoredEvent): GuardianEvent | null {
  return row.event && isKnownEvent(row.event) ? row.event : null;
}

// ---------------------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Display time of an event (what the user's wall clock showed). */
export function displayMs(row: Pick<StoredEvent, 'at' | 'wallOffsetMs'>): number {
  return Date.parse(row.at) + row.wallOffsetMs;
}

/** Local day of an instant (process time zone). */
export function localDayOf(ms: number): LocalDay {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local hour (0–23) of an instant. */
export function localHourOf(ms: number): number {
  return new Date(ms).getHours();
}

/** Start of the local hour containing `ms`. */
function hourStart(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** A local date-time for files and exports: «2026-09-28 17:42:05». */
export function localDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${localDayOf(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** The ISO string of a display instant (what `EventLogEntry.at` carries). */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** One piece of a spread: `minutes` lived in the local hour starting at `hourStartMs`. */
export interface MinuteChunk {
  hourStartMs: number;
  day: LocalDay;
  hour: number;
  minutes: number;
}

/**
 * `minutes` that ended at `endMs`, split over the local hours they were lived in (whole minutes,
 * newest hour first). The end is rounded to the minute.
 */
export function spreadMinutes(endMs: number, minutes: number): MinuteChunk[] {
  const out: MinuteChunk[] = [];
  let remaining = Math.max(0, Math.floor(minutes));
  let cursor = Math.round(endMs / MIN) * MIN;
  // A day holds at most 25 hours (DST): the guard only protects against bad input.
  for (let guard = 0; remaining > 0 && guard < 24 * 60; guard += 1) {
    const start = hourStart(cursor - 1);
    const available = Math.max(1, Math.round((cursor - start) / MIN));
    const take = Math.min(remaining, available);
    out.push({ hourStartMs: start, day: localDayOf(start), hour: localHourOf(start), minutes: take });
    remaining -= take;
    cursor = start;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Minutes lived (focus and blocks)
// ---------------------------------------------------------------------------------------

interface LivedChunk extends MinuteChunk {
  kind: 'focus' | 'block';
}

/** Every focus and block minute of `rows`, spread over the hours they were lived. */
export function livedMinutes(rows: readonly StoredEvent[]): LivedChunk[] {
  const out: LivedChunk[] = [];
  for (const row of rows) {
    const e = knownEvent(row);
    if (!e) continue;
    if (e.type === 'focus_minutes') {
      for (const c of spreadMinutes(displayMs(row), e.data.minutes)) out.push({ ...c, kind: 'focus' });
    } else if (
      e.type === 'block_completed' &&
      POINT_RULES.earningBlockKinds.includes(e.data.kind)
    ) {
      for (const c of spreadMinutes(displayMs(row), e.data.creditedMinutes)) {
        out.push({ ...c, kind: 'block' });
      }
    }
  }
  return out;
}

/** Focus and block minutes per local day. */
export function minutesByDay(rows: readonly StoredEvent[]): Map<LocalDay, { focus: number; block: number }> {
  const out = new Map<LocalDay, { focus: number; block: number }>();
  for (const c of livedMinutes(rows)) {
    const day = out.get(c.day) ?? { focus: 0, block: 0 };
    day[c.kind] += c.minutes;
    out.set(c.day, day);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Ledger replay (goal days)
// ---------------------------------------------------------------------------------------

/**
 * Closed days whose daily goal was met, from a replay of the whole log (the ledger decides:
 * focus minutes against the goal in force, voided by an emergency).
 */
export function goalMetDays(rows: readonly StoredEvent[]): Set<LocalDay> {
  const met = new Set<LocalDay>();
  let state: LedgerState = initialLedgerState();
  for (const row of rows) {
    const e = knownEvent(row);
    const input = e ? ledgerInputFromEvent(e) : null;
    if (!input) continue;
    const step = applyLedgerInput(state, input);
    state = step.state;
    if (input.type === 'day_closed' && step.outcome.met === true) met.add(input.closedDay);
  }
  return met;
}

// ---------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------

/** Event types that mean the user did something worth a statistic. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'block_created',
  'block_completed',
  'focus_minutes',
  'attempt',
  'study_started',
]);

/** No activity at all in the log yet: the empty state. */
export function logIsEmpty(rows: readonly StoredEvent[]): boolean {
  return !rows.some((r) => ACTIVITY_TYPES.has(r.type));
}

function emptyTotals(): StatsTotals {
  return {
    focusMinutes: 0,
    blockMinutes: 0,
    completedBlocks: 0,
    completedStudySessions: 0,
    attempts: 0,
    pointsEarned: 0,
    pointsLost: 0,
    goalDaysMet: 0,
  };
}

function emptyBucket(key: string): StatsBucket {
  return { key, focusMinutes: 0, blockMinutes: 0, attempts: 0, points: 0 };
}

/** `svc:youtube` → a service, `dom:` a domain, `app:` an app, `proc:` a process. */
export function topTargetOf(targetKey: string): Pick<TopTarget, 'kind' | 'id'> | null {
  const m = /^(svc|dom|app|proc):(.+)$/.exec(targetKey);
  if (!m?.[1] || !m[2]) return null;
  const kind = { svc: 'service', dom: 'domain', app: 'app', proc: 'process' }[m[1]] as
    | TopTarget['kind']
    | undefined;
  return kind ? { kind, id: m[2] } : null;
}

export interface OverviewInput {
  query: StatsQuery;
  /** Today (local), for `anchor: null`. */
  today: LocalDay;
  /** Rows around the period (at least 2 days of margin each side, in `seq` order). */
  rows: readonly StoredEvent[];
  /** Closed days that met the goal (`goalMetDays` of the whole log). */
  metDays: ReadonlySet<LocalDay>;
  /** Whether the whole log has no activity yet. */
  empty: boolean;
}

export function computeOverview(input: OverviewInput): StatsOverview {
  const range: StatsRange = input.query.range;
  const anchor = input.query.anchor ?? input.today;
  const { from, to } = statsPeriod(range, anchor);
  const inPeriod = (day: LocalDay): boolean => day >= from && day <= to;

  const keys =
    range === 'day'
      ? Array.from({ length: 24 }, (_, h) => `${anchor}T${pad(h)}`)
      : daysBetween(from, to);
  const buckets = new Map<string, StatsBucket>(keys.map((k) => [k, emptyBucket(k)]));
  const bucketKey = (day: LocalDay, hour: number): string =>
    range === 'day' ? `${day}T${pad(hour)}` : day;
  const totals = emptyTotals();
  const hours: HourStat[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    focusMinutes: 0,
    blockMinutes: 0,
  }));

  for (const c of livedMinutes(input.rows)) {
    if (!inPeriod(c.day)) continue;
    const bucket = buckets.get(bucketKey(c.day, c.hour));
    const hour = hours[c.hour];
    if (c.kind === 'focus') {
      totals.focusMinutes += c.minutes;
      if (bucket) bucket.focusMinutes += c.minutes;
      if (hour) hour.focusMinutes += c.minutes;
    } else {
      totals.blockMinutes += c.minutes;
      if (bucket) bucket.blockMinutes += c.minutes;
      if (hour) hour.blockMinutes += c.minutes;
    }
  }

  const targets = new Map<string, TopTarget>();
  for (const row of input.rows) {
    const ms = displayMs(row);
    const day = localDayOf(ms);
    if (!inPeriod(day)) continue;
    const bucket = buckets.get(bucketKey(day, localHourOf(ms)));
    if (bucket) bucket.points += row.points;
    if (row.points > 0) totals.pointsEarned += row.points;
    else totals.pointsLost -= row.points;
    const e = knownEvent(row);
    if (!e) continue;
    if (e.type === 'attempt') {
      totals.attempts += 1;
      if (bucket) bucket.attempts += 1;
      const target = topTargetOf(e.data.targetKey);
      if (target) {
        const key = `${target.kind}:${target.id}`;
        const t = targets.get(key) ?? { ...target, attempts: 0, pointsLost: 0 };
        t.attempts += 1;
        t.pointsLost += Math.max(0, -row.points);
        targets.set(key, t);
      }
    } else if (e.type === 'block_completed' && POINT_RULES.earningBlockKinds.includes(e.data.kind)) {
      totals.completedBlocks += 1;
    } else if (e.type === 'study_ended' && e.data.outcome === 'completed') {
      totals.completedStudySessions += 1;
    }
  }
  for (const day of input.metDays) if (inPeriod(day)) totals.goalDaysMet += 1;

  const topTargets = [...targets.values()]
    .sort((a, b) => b.attempts - a.attempts || b.pointsLost - a.pointsLost || a.id.localeCompare(b.id))
    .slice(0, STATS_LIMITS.topTargets);

  return {
    range,
    from,
    to,
    buckets: keys.map((k) => buckets.get(k) ?? emptyBucket(k)),
    totals,
    topTargets,
    hours,
    empty: input.empty,
  };
}

/** The envelope days to read for a period (2 days of margin: time zones and spreads). */
export function overviewDayRange(query: StatsQuery, today: LocalDay): { from: LocalDay; to: LocalDay } {
  const { from, to } = statsPeriod(query.range, query.anchor ?? today);
  return { from: addDays(from, -2), to: addDays(to, 2) };
}

// ---------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------

/** The days a heatmap covers: `weeks` weeks ending with the week of `end`. */
export function heatmapPeriod(end: LocalDay, weeks: number): { from: LocalDay; to: LocalDay } {
  const to = statsPeriod('week', end).to;
  return { from: addDays(to, -(weeks * 7 - 1)), to };
}

export function computeHeatmap(input: {
  end: LocalDay;
  weeks: number;
  today: LocalDay;
  goalMinutes: number;
  rows: readonly StoredEvent[];
}): StatsHeatmap {
  const { from, to } = heatmapPeriod(input.end, input.weeks);
  const last = to < input.today ? to : input.today;
  const byDay = minutesByDay(input.rows);
  const cells: HeatmapCell[] =
    dayNumber(last) < dayNumber(from)
      ? []
      : daysBetween(from, last).map((day) => {
          const m = byDay.get(day) ?? { focus: 0, block: 0 };
          return {
            day,
            focusMinutes: m.focus,
            blockMinutes: m.block,
            level: heatmapLevel(m.focus + m.block, input.goalMinutes),
          };
        });
  return { from, to, goalMinutes: input.goalMinutes, cells };
}

// ---------------------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------------------

/** What the log shows about a block: its main target and mode. */
export interface BlockInfo {
  target: string | null;
  mode: BlockMode;
  minutes: number;
}

/** Lookups the log needs beyond one page: blocks by id, schedule names by id. */
export interface LogLookups {
  blocks: Map<string, BlockInfo>;
  schedules: Map<string, string>;
}

/** Builds the lookups from `block_created` and `schedule_*` rows (in `seq` order). */
export function logLookups(rows: readonly StoredEvent[]): LogLookups {
  const schedules = new Map<string, string>();
  const blocks = new Map<string, BlockInfo>();
  for (const row of rows) {
    const e = knownEvent(row);
    if (!e) continue;
    if (e.type === 'schedule_created' || e.type === 'schedule_updated') {
      schedules.set(e.data.schedule.id, e.data.schedule.name);
    } else if (e.type === 'block_created') {
      const b = e.data.block;
      const t = b.targets;
      const scheduleName = b.scheduleId ? (schedules.get(b.scheduleId) ?? null) : null;
      const target =
        scheduleName ??
        t.serviceIds[0] ??
        t.categoryIds[0] ??
        t.customDomains[0] ??
        t.appIds[0] ??
        t.customProcesses[0] ??
        null;
      blocks.set(b.id, {
        target,
        mode: b.mode,
        minutes: Math.max(0, Math.round((Date.parse(b.endsAt) - Date.parse(b.startsAt)) / MIN)),
      });
    }
  }
  return { blocks, schedules };
}

/** Whether a row belongs to a log filter (the same rules as the SQL in `db/stats.ts`). */
export function matchesLogFilter(row: Pick<StoredEvent, 'type' | 'points'>, filter: EventLogFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'blocks':
      return row.type.startsWith('block_');
    case 'attempts':
      return row.type === 'attempt';
    case 'points':
      return row.points !== 0;
    case 'study':
      return /^(?:study_|focus_|strike|punishment_)/.test(row.type);
  }
}

/** One log row: never a reason, a task or any other free text of the event. */
export function logEntry(row: StoredEvent, lookups: LogLookups): EventLogEntry {
  const base: EventLogEntry = {
    id: `${row.epoch}:${row.seq}`,
    at: isoOf(displayMs(row)),
    type: row.type,
    points: row.points,
    target: null,
    minutes: null,
    mode: null,
  };
  const e = knownEvent(row);
  if (!e) return base;
  const block = (id: string): BlockInfo | null => lookups.blocks.get(id) ?? null;
  switch (e.type) {
    case 'block_created': {
      const info = block(e.data.block.id);
      return {
        ...base,
        target: info?.target ?? null,
        minutes: info?.minutes ?? null,
        mode: e.data.block.mode,
      };
    }
    case 'block_extended': {
      const info = block(e.data.blockId);
      return { ...base, target: info?.target ?? null, minutes: e.data.addMinutes, mode: info?.mode ?? null };
    }
    case 'block_completed': {
      const info = block(e.data.blockId);
      return {
        ...base,
        target: info?.target ?? null,
        minutes: e.data.creditedMinutes,
        mode: e.data.mode,
      };
    }
    case 'block_cancelled': {
      const info = block(e.data.blockId);
      return {
        ...base,
        target: info?.target ?? null,
        minutes: e.data.forfeitedMinutes,
        mode: info?.mode ?? null,
      };
    }
    case 'attempt': {
      const target = topTargetOf(e.data.targetKey);
      const first = e.data.blockIds[0];
      return {
        ...base,
        target: e.data.serviceId ?? target?.id ?? null,
        mode: first ? (block(first)?.mode ?? null) : null,
      };
    }
    case 'reward_redeemed':
      return { ...base, target: e.data.serviceId, minutes: e.data.offerMinutes };
    case 'reward_ended':
      return { ...base, target: e.data.serviceId };
    case 'focus_minutes':
      return { ...base, minutes: e.data.minutes };
    case 'study_started':
      return { ...base, minutes: e.data.session.plannedMinutes };
    case 'study_ended':
      return { ...base, minutes: e.data.focusedMinutes };
    case 'punishment_started':
      return { ...base, minutes: e.data.punishment.minutes };
    case 'schedule_created':
    case 'schedule_updated':
      return { ...base, target: e.data.schedule.name, mode: e.data.schedule.mode };
    case 'schedule_deleted':
      return { ...base, target: lookups.schedules.get(e.data.scheduleId) ?? null };
    case 'day_closed':
      return { ...base, minutes: e.data.goalMinutes };
    case 'extension_paired':
      return { ...base, target: e.data.browser };
    case 'process_closed':
      return { ...base, target: e.data.serviceId ?? e.data.appId ?? null };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------------------

/**
 * Every achievement with its progress and, when reached, the display time of the event that
 * crossed its threshold. One pass over the epoch's events (the same metrics as
 * `achievementMetricsFromEvents`, followed step by step).
 */
export function computeAchievements(rows: readonly StoredEvent[]): AchievementStatus[] {
  const metrics = {
    completedStudySessions: 0,
    completedBlocks: 0,
    focusMinutesTotal: 0,
    bestStreakDays: 0,
    bestCleanDayRun: 0,
  };
  const reachedAt = new Map<AchievementId, string>();
  const active = new Set<string>();
  const dirty = new Set<string>();
  let cleanRun = 0;
  let lastClosed: LocalDay | null = null;
  let ledger: LedgerState = initialLedgerState();

  for (const row of rows) {
    const e = knownEvent(row);
    if (!e) continue;
    const input = ledgerInputFromEvent(e);
    if (input) {
      ledger = applyLedgerInput(ledger, input).state;
      metrics.bestStreakDays = Math.max(metrics.bestStreakDays, ledger.bestStreak);
    }
    if (e.type === 'epoch_started') {
      // A new epoch starts the ledger over (data deletion keeps nothing of the old one).
      metrics.bestStreakDays = ledger.bestStreak;
    }
    switch (e.type) {
      case 'study_ended':
        if (e.data.outcome === 'completed') metrics.completedStudySessions += 1;
        break;
      case 'block_completed':
        if (POINT_RULES.earningBlockKinds.includes(e.data.kind)) {
          metrics.completedBlocks += 1;
          active.add(e.day);
        }
        break;
      case 'focus_minutes':
        metrics.focusMinutesTotal += Math.max(0, e.data.minutes);
        if (e.data.minutes > 0) active.add(e.day);
        break;
      case 'attempt':
        dirty.add(e.day);
        break;
      case 'day_closed': {
        const d = e.data.day;
        if (lastClosed !== null && dayNumber(d) <= dayNumber(lastClosed)) break;
        const consecutive = lastClosed !== null && dayNumber(d) === dayNumber(lastClosed) + 1;
        const clean = active.has(d) && !dirty.has(d);
        cleanRun = clean ? (consecutive ? cleanRun + 1 : 1) : 0;
        metrics.bestCleanDayRun = Math.max(metrics.bestCleanDayRun, cleanRun);
        lastClosed = d;
        break;
      }
      default:
        break;
    }
    for (const a of ACHIEVEMENTS) {
      if (!reachedAt.has(a.id) && metrics[a.metric] >= a.threshold) {
        reachedAt.set(a.id, isoOf(displayMs(row)));
      }
    }
  }

  return ACHIEVEMENTS.map((a) => {
    const current = Math.max(0, Math.trunc(metrics[a.metric]));
    const achieved = current >= a.threshold;
    return {
      id: a.id,
      achieved,
      current,
      threshold: a.threshold,
      achievedAt: achieved ? (reachedAt.get(a.id) ?? null) : null,
    };
  });
}

/** The events of the current epoch only (achievements and the mascot restart with it). */
export function currentEpochRows(rows: readonly StoredEvent[], epoch: string | null): StoredEvent[] {
  return epoch === null ? [...rows] : rows.filter((r) => r.epoch === epoch);
}

// ---------------------------------------------------------------------------------------
// Days (CSV «días»)
// ---------------------------------------------------------------------------------------

export interface DayRow {
  day: LocalDay;
  focusMinutes: number;
  blockMinutes: number;
  attempts: number;
  points: number;
  goalMet: boolean;
}

/** One row per local day with any activity or points, oldest first. */
export function dayRows(rows: readonly StoredEvent[], metDays: ReadonlySet<LocalDay>): DayRow[] {
  const byDay = new Map<LocalDay, DayRow>();
  const get = (day: LocalDay): DayRow => {
    let row = byDay.get(day);
    if (!row) {
      row = { day, focusMinutes: 0, blockMinutes: 0, attempts: 0, points: 0, goalMet: metDays.has(day) };
      byDay.set(day, row);
    }
    return row;
  };
  for (const c of livedMinutes(rows)) {
    const row = get(c.day);
    if (c.kind === 'focus') row.focusMinutes += c.minutes;
    else row.blockMinutes += c.minutes;
  }
  for (const r of rows) {
    const e = knownEvent(r);
    if (r.points === 0 && e?.type !== 'attempt') continue;
    const row = get(localDayOf(displayMs(r)));
    row.points += r.points;
    if (e?.type === 'attempt') row.attempts += 1;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
