/**
 * Statistics from the local event database (docs/DESKTOP.md §6.5, §15): a **read-only** second
 * connection to `userData/centrate.sqlite`, the file the core's event sync writes (WAL mode, so
 * reading never blocks a sync). Answers `stats:overview`, `stats:heatmap`, `stats:events`,
 * `achievements:list` and the CSV export from the `events` table (raw JSON parsed here, figures
 * computed by the pure `stats-compute.ts`). The schema stays the events module's: nothing here
 * writes or migrates.
 *
 * The whole log (achievements, goal days, the log's lookups, the CSV) is cached and grows
 * incrementally: a new event reads only the rows after the last one cached (primary key
 * `(epoch, seq)`), and derived sets extend with them. A new epoch (data deletion) or a count
 * that does not add up rebuilds it.
 *
 * Harness runs never open it (fixtures answer from `fixture.local`); the dev mock guardian
 * syncs into its own file (`MOCK_EVENTS_DB_FILE`) so its statistics are real too.
 */
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { LocalDay, WireEvent } from '@centrate/shared/domain';
import {
  STATS_LIMITS,
  type EventLogFilter,
  type EventLogPage,
  type HeatmapQuery,
  type StatsHeatmap,
  type StatsOverview,
  type StatsQuery,
} from '../../shared/stats';
import type { AchievementStatus } from '../../shared/platform';
import {
  computeAchievements,
  computeHeatmap,
  computeOverview,
  currentEpochRows,
  dayRows,
  extendLogLookups,
  goalDaysReplay,
  heatmapPeriod,
  logEntry,
  logIsEmpty,
  overviewDayRange,
  type GoalDaysReplay,
  type LogLookups,
  type StoredEvent,
} from './stats-compute';
import { csvFileName, daysCsv, eventsCsv, type CsvHeaders } from './stats-csv';
import { addDays } from '@centrate/shared/points';
import type { CsvExportKind } from '../../shared/stats';
import { EVENTS_DB_FILE } from './events-db';

/** The dev mock guardian's event copy (`CENTRATE_MOCK_GUARDIAN=1`), apart from the real one. */
export const MOCK_EVENTS_DB_FILE = 'centrate-mock.sqlite';

/** The events file of a run: the mock guardian's own, or the real guardian's copy. */
export function eventsDbFileName(mock: boolean): string {
  return mock ? MOCK_EVENTS_DB_FILE : EVENTS_DB_FILE;
}

/** The `seq` of an event-log cursor (`${epoch}:${seq}` or a bare seq). */
export function cursorSeq(before: string | null): number | null {
  if (before === null) return null;
  const m = /(?:^|:)(\d{1,15})$/.exec(before);
  return m?.[1] ? Number(m[1]) : null;
}

const FILTER_SQL: Readonly<Record<EventLogFilter, string>> = Object.freeze({
  all: '1 = 1',
  blocks: "type LIKE 'block\\_%' ESCAPE '\\'",
  attempts: "type = 'attempt'",
  points: 'points <> 0',
  study:
    "(type LIKE 'study\\_%' ESCAPE '\\' OR type LIKE 'focus\\_%' ESCAPE '\\' " +
    "OR type LIKE 'strike%' OR type LIKE 'punishment\\_%' ESCAPE '\\')",
});

const COLUMNS = 'epoch, seq, type, at, wall_offset_ms, day, points, xp, raw';

function toStored(r: Record<string, unknown>): StoredEvent {
  let event: WireEvent | null = null;
  try {
    const parsed = JSON.parse(String(r['raw'])) as unknown;
    if (typeof parsed === 'object' && parsed !== null) event = parsed as WireEvent;
  } catch {
    event = null;
  }
  return {
    epoch: String(r['epoch']),
    seq: Number(r['seq']),
    type: String(r['type']),
    at: String(r['at']),
    wallOffsetMs: Number(r['wall_offset_ms'] ?? 0),
    day: String(r['day']),
    points: Number(r['points'] ?? 0),
    xp: Number(r['xp'] ?? 0),
    event,
  };
}

/** Read-only queries over the `events` table. */
export class StatsReader {
  private readonly selectCursor: StatementSync;
  private readonly selectCount: StatementSync;
  private readonly selectRange: StatementSync;
  private readonly selectAll: StatementSync;
  private readonly selectAfter: StatementSync;
  private readonly selectLookups: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    this.selectCursor = db.prepare('SELECT epoch, last_seq FROM sync_cursor WHERE id = 1');
    this.selectCount = db.prepare('SELECT COUNT(*) AS n FROM events');
    this.selectRange = db.prepare(
      `SELECT ${COLUMNS} FROM events WHERE day >= ? AND day <= ? ORDER BY epoch, seq`,
    );
    this.selectAll = db.prepare(`SELECT ${COLUMNS} FROM events ORDER BY seq`);
    this.selectAfter = db.prepare(
      `SELECT ${COLUMNS} FROM events WHERE epoch = ? AND seq > ? ORDER BY seq`,
    );
    this.selectLookups = db.prepare(
      `SELECT ${COLUMNS} FROM events WHERE type IN ('block_created', 'schedule_created', 'schedule_updated') ORDER BY seq`,
    );
  }

  /** Opens `path` read-only; throws when it is missing or unreadable. */
  static open(path: string): StatsReader {
    if (path !== ':memory:' && !existsSync(path)) throw new Error('events database missing');
    const db = new DatabaseSync(path, { readOnly: true, timeout: 2_000 });
    try {
      db.prepare('SELECT COUNT(*) AS n FROM events').get();
    } catch (error) {
      db.close();
      throw error;
    }
    return new StatsReader(db);
  }

  cursor(): { epoch: string | null; lastSeq: number } {
    const row = this.selectCursor.get() as { epoch: string | null; last_seq: number } | undefined;
    return row
      ? { epoch: row.epoch ?? null, lastSeq: Number(row.last_seq) }
      : { epoch: null, lastSeq: 0 };
  }

  count(): number {
    const row = this.selectCount.get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Rows whose envelope day is within [from, to]. */
  byDay(from: LocalDay, to: LocalDay): StoredEvent[] {
    return (this.selectRange.all(from, to) as Array<Record<string, unknown>>).map(toStored);
  }

  all(): StoredEvent[] {
    return (this.selectAll.all() as Array<Record<string, unknown>>).map(toStored);
  }

  /** Rows of `epoch` after `seq`, oldest first. */
  after(epoch: string, seq: number): StoredEvent[] {
    return (this.selectAfter.all(epoch, seq) as Array<Record<string, unknown>>).map(toStored);
  }

  lookupRows(): StoredEvent[] {
    return (this.selectLookups.all() as Array<Record<string, unknown>>).map(toStored);
  }

  /** One page of the log, newest first, older than `beforeSeq`. */
  page(filter: EventLogFilter, beforeSeq: number | null, limit: number): StoredEvent[] {
    const where = FILTER_SQL[filter];
    const sql =
      beforeSeq === null
        ? `SELECT ${COLUMNS} FROM events WHERE ${where} ORDER BY seq DESC LIMIT ?`
        : `SELECT ${COLUMNS} FROM events WHERE ${where} AND seq < ? ORDER BY seq DESC LIMIT ?`;
    const statement = this.db.prepare(sql);
    const rows = beforeSeq === null ? statement.all(limit) : statement.all(beforeSeq, limit);
    return (rows as Array<Record<string, unknown>>).map(toStored);
  }

  countMatching(filter: EventLogFilter): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${FILTER_SQL[filter]}`)
      .get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

export interface LocalStatsOptions {
  /** Opens the reader (retried on the next call when it fails: the core may create the file later). */
  open(): StatsReader;
  /** Today in the user's time zone. */
  today(): LocalDay;
  /** The daily goal in force (heatmap levels). */
  goalMinutes(): number;
  csvHeaders(): CsvHeaders;
  csvNames(): Readonly<Record<CsvExportKind, string>>;
}

/** The whole log and what is derived from all of it. */
interface WholeLog {
  /** The cursor epoch the rows were read for. */
  epoch: string | null;
  /** Highest `seq` held. */
  lastSeq: number;
  all: StoredEvent[];
  replay: GoalDaysReplay;
  metDays: Set<LocalDay>;
  empty: boolean;
  lookups: LogLookups;
  /** Bumped whenever rows are added (memoised answers below key on it). */
  version: number;
}

/** What `stats:*` and `achievements:list` answer in a real (or dev mock) run. */
export class LocalStats {
  private reader: StatsReader | null = null;
  private cacheKey = '';
  private cache: WholeLog | null = null;
  private versions = 0;
  /** Answers derived from the current epoch's rows, for `cache.version`. */
  private epochMemo: {
    version: number;
    rows: StoredEvent[];
    achievements: AchievementStatus[] | null;
    events: WireEvent[] | null;
  } | null = null;
  /** Rows read since construction (tests: incremental reads stay small). */
  rowsRead = 0;

  constructor(private readonly options: LocalStatsOptions) {}

  private db(): StatsReader {
    if (!this.reader) this.reader = this.options.open();
    return this.reader;
  }

  /**
   * The whole log and what is derived from all of it. Unchanged cursor and count: the cache.
   * Same epoch and more rows: only the new rows are read and folded in. Anything else (a new
   * epoch, fewer rows, rows that do not add up): rebuilt from scratch.
   */
  private whole(): WholeLog {
    const db = this.db();
    const cursor = db.cursor();
    const count = db.count();
    const key = `${cursor.epoch ?? ''}:${cursor.lastSeq}:${count}`;
    if (this.cache && key === this.cacheKey) return this.cache;
    const cache = this.cache;
    if (
      cache &&
      cursor.epoch !== null &&
      cache.epoch === cursor.epoch &&
      count > cache.all.length
    ) {
      const added = db.after(cursor.epoch, cache.lastSeq);
      this.rowsRead += added.length;
      if (cache.all.length + added.length === count) {
        for (const row of added) cache.all.push(row);
        cache.replay.add(added);
        cache.empty = cache.empty && logIsEmpty(added);
        extendLogLookups(cache.lookups, added);
        cache.lastSeq = added.reduce((max, r) => Math.max(max, r.seq), cache.lastSeq);
        this.versions += 1;
        cache.version = this.versions;
        this.cacheKey = key;
        return cache;
      }
    }
    const all = db.all();
    this.rowsRead += all.length;
    const replay = goalDaysReplay();
    replay.add(all);
    const lookups: LogLookups = { blocks: new Map(), schedules: new Map() };
    extendLogLookups(lookups, all);
    this.versions += 1;
    this.cache = {
      epoch: cursor.epoch,
      lastSeq: all.reduce((max, r) => Math.max(max, r.seq), 0),
      all,
      replay,
      metDays: replay.met,
      empty: logIsEmpty(all),
      lookups,
      version: this.versions,
    };
    this.cacheKey = key;
    return this.cache;
  }

  /** The current epoch's rows, memoised with the answers derived from them. */
  private epochRows(): NonNullable<LocalStats['epochMemo']> {
    const whole = this.whole();
    if (this.epochMemo?.version !== whole.version) {
      this.epochMemo = {
        version: whole.version,
        rows: currentEpochRows(whole.all, whole.epoch),
        achievements: null,
        events: null,
      };
    }
    return this.epochMemo;
  }

  /** How far the local copy is synced (`epoch: null` before the first page). */
  cursor(): { epoch: string | null; lastSeq: number } {
    return this.db().cursor();
  }

  overview(query: StatsQuery): StatsOverview {
    const today = this.options.today();
    const whole = this.whole();
    const range = overviewDayRange(query, today);
    return computeOverview({
      query,
      today,
      rows: this.db().byDay(range.from, range.to),
      metDays: whole.metDays,
      empty: whole.empty,
    });
  }

  heatmap(query: HeatmapQuery): StatsHeatmap {
    const today = this.options.today();
    const weeks = Math.min(Math.max(1, query.weeks), STATS_LIMITS.heatmapMaxWeeks);
    const period = heatmapPeriod(query.end ?? today, weeks);
    return computeHeatmap({
      end: query.end ?? today,
      weeks,
      today,
      goalMinutes: this.options.goalMinutes(),
      rows: this.db().byDay(addDays(period.from, -2), addDays(period.to, 2)),
    });
  }

  events(filter: EventLogFilter, before: string | null, limit: number): EventLogPage {
    const db = this.db();
    const size = Math.min(Math.max(1, limit), STATS_LIMITS.eventPageMax);
    const rows = db.page(filter, cursorSeq(before), size + 1);
    const page = rows.slice(0, size);
    const lookups = this.whole().lookups;
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => logEntry(r, lookups)),
      nextBefore: rows.length > size && last ? `${last.epoch}:${last.seq}` : null,
      total: db.countMatching(filter),
    };
  }

  achievements(): AchievementStatus[] {
    const memo = this.epochRows();
    memo.achievements ??= computeAchievements(memo.rows);
    return structuredClone(memo.achievements);
  }

  /** Events of the current epoch (the mascot's «since the last give-up»). */
  epochEvents(): WireEvent[] {
    const memo = this.epochRows();
    memo.events ??= memo.rows.map((r) => r.event).filter((e): e is WireEvent => e !== null);
    return [...memo.events];
  }

  csv(kind: CsvExportKind): { text: string; rows: number; fileName: string } {
    const whole = this.whole();
    const headers = this.options.csvHeaders();
    const out =
      kind === 'events'
        ? eventsCsv(whole.all, whole.lookups, headers.events)
        : daysCsv(dayRows(whole.all, whole.metDays), headers.days);
    return { ...out, fileName: csvFileName(kind, this.options.today(), this.options.csvNames()) };
  }

  close(): void {
    this.reader?.close();
    this.reader = null;
    this.cache = null;
    this.epochMemo = null;
    this.cacheKey = '';
  }
}
