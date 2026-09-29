/**
 * Local statistics database (docs/DESKTOP.md §6.5, ARCHITECTURE §8.8 `/v1/events`):
 * `userData/centrate.sqlite` through `node:sqlite` (`DatabaseSync`, no native module).
 *
 * The guardian's event log is copied page by page through a cursor `(epoch, lastSeq)`:
 * every page is inserted in **one** transaction together with the cursor (exactly once,
 * crash-safe); a `reset` page (new epoch: data deletion, unreadable log, or a first sync)
 * wipes the local copy first. Unknown and malformed events are stored raw and still move
 * the cursor. Statistics (Phase 1: the `daily_summary` view) are derived from `events`; the
 * minutes used per daily limit and local day (`limit_days`, schema v2) are kept from the
 * guardian's `limit_day_closed` events as they arrive (ARCHITECTURE §10.13).
 *
 * A database that cannot be opened or migrated is renamed to `.corrupt-<ts>` and recreated:
 * the guardian still holds the log, so a bad local copy never stops the app. Tests use
 * `:memory:`.
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EpochId, WireEvent } from '@centrate/shared/domain';
import { isKnownEvent } from '@centrate/shared/domain';
import type { EventsResponse } from '@centrate/shared/guardian-api';

export const EVENTS_DB_FILE = 'centrate.sqlite';
export const SCHEMA_VERSION = 2;

export interface SyncCursor {
  /** `null` before the first page: the guardian answers with a `reset` from its epoch start. */
  epoch: EpochId | null;
  lastSeq: number;
}

export interface ApplyResult {
  /** Rows actually inserted (a re-delivered event is ignored). */
  inserted: number;
  reset: boolean;
}

export interface EventsDb {
  cursor(): SyncCursor;
  /** Insert a page and move the cursor in one transaction (wipes first on `reset`). */
  applyPage(page: EventsResponse): ApplyResult;
  /** «Borrar todos mis datos»: every event and the cursor. */
  wipe(): void;
  eventCount(): number;
  /** Per local day: points, XP, completed blocks, attempts (for later statistics). */
  dailySummary(): DailySummaryRow[];
  /** Minutes used per daily limit and local day (`limit_day_closed`), oldest day first. */
  limitDays(range?: { from?: string; to?: string }): LimitDayRow[];
  close(): void;
  /** Where it lives (`:memory:` in tests and the harness). */
  readonly path: string;
}

export interface DailySummaryRow {
  day: string;
  points: number;
  xp: number;
  blocksCompleted: number;
  attempts: number;
  events: number;
}

/** One closed day of a daily limit («YouTube: 34 of 30 min on 2026-09-28, used up»). */
export interface LimitDayRow {
  limitId: string;
  name: string;
  day: string;
  dailyMinutes: number;
  usedSeconds: number;
  /** The limit applied that day (enabled and the weekday among its days). */
  applied: boolean;
  reached: boolean;
}

const LIMIT_DAY_COLUMNS =
  'epoch, seq, limit_id, name, day, daily_minutes, used_seconds, applied, reached';

const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE IF NOT EXISTS events (
    epoch TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    wall_offset_ms INTEGER NOT NULL,
    day TEXT NOT NULL,
    points INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('known','unknown','malformed')),
    raw TEXT NOT NULL,
    PRIMARY KEY (epoch, seq)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS events_day ON events(day);
  CREATE TABLE IF NOT EXISTS sync_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    epoch TEXT,
    last_seq INTEGER NOT NULL
  ) STRICT;
  CREATE VIEW IF NOT EXISTS daily_summary AS
    SELECT day,
           SUM(points) AS points,
           SUM(xp) AS xp,
           SUM(CASE WHEN type = 'block_completed' THEN 1 ELSE 0 END) AS blocks_completed,
           SUM(CASE WHEN type = 'attempt' THEN 1 ELSE 0 END) AS attempts,
           COUNT(*) AS events
      FROM events
     GROUP BY day;
  `,
  // v2: daily limits (one row per limit and local day; a later event for the same pair wins).
  `
  CREATE TABLE IF NOT EXISTS limit_days (
    epoch TEXT NOT NULL,
    seq INTEGER NOT NULL,
    limit_id TEXT NOT NULL,
    name TEXT NOT NULL,
    day TEXT NOT NULL,
    daily_minutes INTEGER NOT NULL,
    used_seconds INTEGER NOT NULL,
    applied INTEGER NOT NULL,
    reached INTEGER NOT NULL,
    PRIMARY KEY (limit_id, day)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS limit_days_day ON limit_days(day);
  INSERT OR REPLACE INTO limit_days (${LIMIT_DAY_COLUMNS})
    SELECT epoch, seq,
           json_extract(raw, '$.data.limitId'),
           json_extract(raw, '$.data.name'),
           json_extract(raw, '$.data.day'),
           json_extract(raw, '$.data.dailyMinutes'),
           json_extract(raw, '$.data.usedSeconds'),
           CASE WHEN json_extract(raw, '$.data.applied') THEN 1 ELSE 0 END,
           CASE WHEN json_extract(raw, '$.data.reached') THEN 1 ELSE 0 END
      FROM events
     WHERE type = 'limit_day_closed' AND status = 'known'
     ORDER BY epoch, seq;
  `,
];

/** The `limit_days` row of a `limit_day_closed` event, or `null` for anything else. */
export function limitDayOf(event: WireEvent): (LimitDayRow & { epoch: string; seq: number }) | null {
  if (!isKnownEvent(event) || event.type !== 'limit_day_closed') return null;
  const d = event.data;
  return {
    epoch: event.epoch,
    seq: event.seq,
    limitId: d.limitId,
    name: d.name,
    day: d.day,
    dailyMinutes: Math.trunc(d.dailyMinutes),
    usedSeconds: Math.trunc(d.usedSeconds),
    applied: d.applied,
    reached: d.reached,
  };
}

export function eventStatus(event: WireEvent): 'known' | 'unknown' | 'malformed' {
  if ('malformed' in event) return 'malformed';
  return isKnownEvent(event) ? 'known' : 'unknown';
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  if (version > MIGRATIONS.length) {
    throw new Error(`events db schema ${version} is newer than this app (${MIGRATIONS.length})`);
  }
  for (let v = version; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v] ?? '');
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function openRaw(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    db.prepare('SELECT COUNT(*) AS n FROM events').get();
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // already unusable
    }
    throw error;
  }
}

/** Open (or recreate) the database. `onRecreated` reports a corrupt file that was set aside. */
export function openEventsDb(
  path: string,
  options: { now?: () => number; onRecreated?: (error: unknown) => void } = {},
): EventsDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let db: DatabaseSync;
  try {
    db = openRaw(path);
  } catch (error) {
    if (path === ':memory:') throw error;
    const stamp = (options.now ?? Date.now)();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) {
        try {
          renameSync(file, `${path}.corrupt-${stamp}${suffix}`);
        } catch {
          // best effort: the open below reports if it still fails
        }
      }
    }
    options.onRecreated?.(error);
    db = openRaw(path);
  }
  return wrap(db, path);
}

function wrap(db: DatabaseSync, path: string): EventsDb {
  const selectCursor = db.prepare('SELECT epoch, last_seq FROM sync_cursor WHERE id = 1');
  const upsertCursor = db.prepare(
    'INSERT INTO sync_cursor (id, epoch, last_seq) VALUES (1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq',
  );
  const insertEvent = db.prepare(
    // Only a re-delivered (epoch, seq) is skipped; any other constraint fails the page.
    'INSERT INTO events (epoch, seq, type, at, wall_offset_ms, day, points, xp, status, raw) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(epoch, seq) DO NOTHING',
  );
  const deleteEvents = db.prepare('DELETE FROM events');
  const deleteCursor = db.prepare('DELETE FROM sync_cursor');
  const countEvents = db.prepare('SELECT COUNT(*) AS n FROM events');
  const selectDaily = db.prepare(
    'SELECT day, points, xp, blocks_completed, attempts, events FROM daily_summary ORDER BY day',
  );
  const upsertLimitDay = db.prepare(
    `INSERT OR REPLACE INTO limit_days (${LIMIT_DAY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteLimitDays = db.prepare('DELETE FROM limit_days');
  const selectLimitDays = db.prepare(
    'SELECT limit_id, name, day, daily_minutes, used_seconds, applied, reached FROM limit_days ' +
      'WHERE day >= ? AND day <= ? ORDER BY day, limit_id',
  );

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    path,
    cursor(): SyncCursor {
      const row = selectCursor.get() as { epoch: string | null; last_seq: number } | undefined;
      if (!row) return { epoch: null, lastSeq: 0 };
      return { epoch: (row.epoch as EpochId | null) ?? null, lastSeq: Number(row.last_seq) };
    },
    applyPage(page: EventsResponse): ApplyResult {
      return transaction(() => {
        if (page.reset) {
          deleteEvents.run();
          deleteLimitDays.run();
        }
        let inserted = 0;
        for (const event of page.events) {
          const r = insertEvent.run(
            event.epoch,
            event.seq,
            event.type,
            event.at,
            Math.trunc(event.wallOffsetMs),
            event.day,
            Math.trunc(event.points),
            Math.trunc(event.xp),
            eventStatus(event),
            JSON.stringify(event),
          );
          inserted += Number(r.changes);
          const row = Number(r.changes) > 0 ? limitDayOf(event) : null;
          if (row) {
            upsertLimitDay.run(
              row.epoch,
              row.seq,
              row.limitId,
              row.name,
              row.day,
              row.dailyMinutes,
              row.usedSeconds,
              row.applied ? 1 : 0,
              row.reached ? 1 : 0,
            );
          }
        }
        upsertCursor.run(page.epoch, page.lastSeq);
        return { inserted, reset: page.reset };
      });
    },
    wipe(): void {
      transaction(() => {
        deleteEvents.run();
        deleteLimitDays.run();
        deleteCursor.run();
      });
    },
    eventCount(): number {
      const row = countEvents.get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    },
    dailySummary(): DailySummaryRow[] {
      return (selectDaily.all() as Array<Record<string, unknown>>).map((r) => ({
        day: String(r['day']),
        points: Number(r['points'] ?? 0),
        xp: Number(r['xp'] ?? 0),
        blocksCompleted: Number(r['blocks_completed'] ?? 0),
        attempts: Number(r['attempts'] ?? 0),
        events: Number(r['events'] ?? 0),
      }));
    },
    limitDays(range = {}): LimitDayRow[] {
      const rows = selectLimitDays.all(range.from ?? '', range.to ?? '9999-12-31') as Array<
        Record<string, unknown>
      >;
      return rows.map((r) => ({
        limitId: String(r['limit_id']),
        name: String(r['name']),
        day: String(r['day']),
        dailyMinutes: Number(r['daily_minutes'] ?? 0),
        usedSeconds: Number(r['used_seconds'] ?? 0),
        applied: Number(r['applied'] ?? 0) === 1,
        reached: Number(r['reached'] ?? 0) === 1,
      }));
    },
    close(): void {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Last-resort stand-in when `node:sqlite` cannot open even an in-memory database: keeps the
 * cursor only, so the event sync (notifications) keeps working without statistics.
 */
export function createNullEventsDb(): EventsDb {
  let cursor: SyncCursor = { epoch: null, lastSeq: 0 };
  let count = 0;
  return {
    path: ':null:',
    cursor: () => ({ ...cursor }),
    applyPage(page) {
      if (page.reset) count = 0;
      count += page.events.length;
      cursor = { epoch: page.epoch, lastSeq: page.lastSeq };
      return { inserted: page.events.length, reset: page.reset };
    },
    wipe() {
      cursor = { epoch: null, lastSeq: 0 };
      count = 0;
    },
    eventCount: () => count,
    dailySummary: () => [],
    limitDays: () => [],
    close: () => undefined,
  };
}
