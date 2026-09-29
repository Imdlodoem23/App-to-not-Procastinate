import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EpochId, WireEvent } from '@centrate/shared/domain';
import type { EventsResponse } from '@centrate/shared/guardian-api';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, eventStatus, openEventsDb } from '../../../src/main/db/events-db';

const EPOCH = 'ep_testepoch0000000001' as EpochId;
const OTHER = 'ep_testepoch0000000002' as EpochId;

function event(
  seq: number,
  type: string,
  data: unknown,
  extra: Partial<WireEvent> = {},
): WireEvent {
  return {
    v: 1,
    epoch: EPOCH,
    seq,
    at: '2026-09-28T15:00:00.000Z',
    wallOffsetMs: 0,
    day: '2026-09-28',
    points: 0,
    xp: 0,
    txEnd: true,
    req: null,
    type,
    data,
    ...extra,
  } as WireEvent;
}

function page(events: WireEvent[], patch: Partial<EventsResponse> = {}): EventsResponse {
  const last = events[events.length - 1];
  return {
    epoch: EPOCH,
    reset: false,
    events,
    lastSeq: last ? last.seq : 0,
    hasMore: false,
    ...patch,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('events database', () => {
  it('stores a page and moves the cursor together', () => {
    const db = openEventsDb(':memory:');
    expect(db.cursor()).toEqual({ epoch: null, lastSeq: 0 });
    const r = db.applyPage(
      page([
        event(1, 'day_closed', { day: '2026-09-27', goalMinutes: 60 }),
        event(2, 'attempt', {}, { points: -10 }),
      ]),
    );
    expect(r.inserted).toBe(2);
    expect(db.cursor()).toEqual({ epoch: EPOCH, lastSeq: 2 });
    // Re-delivery is ignored.
    expect(db.applyPage(page([event(2, 'attempt', {}, { points: -10 })])).inserted).toBe(0);
    expect(db.eventCount()).toBe(2);
    db.close();
  });

  it('is atomic: a failing insert leaves events and cursor untouched', () => {
    const db = openEventsDb(':memory:');
    db.applyPage(page([event(1, 'day_closed', {})]));
    const bad = event(3, 'attempt', {}, { points: 1.5 as number, day: null as unknown as string });
    expect(() => db.applyPage(page([event(2, 'day_closed', {}), bad]))).toThrow();
    expect(db.cursor()).toEqual({ epoch: EPOCH, lastSeq: 1 });
    expect(db.eventCount()).toBe(1);
    db.close();
  });

  it('wipes on reset before inserting the new epoch', () => {
    const db = openEventsDb(':memory:');
    db.applyPage(page([event(1, 'day_closed', {}), event(2, 'day_closed', {})]));
    const fresh = { ...event(1, 'epoch_started', {}), epoch: OTHER } as WireEvent;
    db.applyPage({ epoch: OTHER, reset: true, events: [fresh], lastSeq: 1, hasMore: false });
    expect(db.eventCount()).toBe(1);
    expect(db.cursor()).toEqual({ epoch: OTHER, lastSeq: 1 });
    db.wipe();
    expect(db.cursor()).toEqual({ epoch: null, lastSeq: 0 });
    expect(db.eventCount()).toBe(0);
    db.close();
  });

  it('keeps unknown and malformed events raw', () => {
    expect(eventStatus(event(1, 'future_thing', { x: 1 }))).toBe('unknown');
    const malformed = {
      ...event(2, 'attempt', 'oops'),
      malformed: { path: 'data', issue: 'type', message: 'x' },
    };
    expect(eventStatus(malformed as WireEvent)).toBe('malformed');
    const db = openEventsDb(':memory:');
    db.applyPage(page([event(1, 'future_thing', { x: 1 }), malformed as WireEvent]));
    expect(db.eventCount()).toBe(2);
    expect(db.cursor().lastSeq).toBe(2);
    db.close();
  });

  it('summarises points, attempts and completed blocks per day', () => {
    const db = openEventsDb(':memory:');
    db.applyPage(
      page([
        event(1, 'block_completed', {}, { points: 80 }),
        event(2, 'attempt', {}, { points: -10 }),
        event(3, 'attempt', {}, { points: -20, day: '2026-09-29' }),
      ]),
    );
    expect(db.dailySummary()).toEqual([
      { day: '2026-09-28', points: 70, xp: 0, blocksCompleted: 1, attempts: 1, events: 2 },
      { day: '2026-09-29', points: -20, xp: 0, blocksCompleted: 0, attempts: 1, events: 1 },
    ]);
    db.close();
  });

  it('keeps the minutes used per daily limit and day (limit_day_closed)', () => {
    const db = openEventsDb(':memory:');
    const closed = (seq: number, day: string, used: number, reached: boolean): WireEvent =>
      event(seq, 'limit_day_closed', {
        limitId: 'lim_fixture0000000001',
        name: 'YouTube',
        day,
        dailyMinutes: 30,
        usedSeconds: used,
        applied: true,
        reached,
      });
    db.applyPage(page([closed(1, '2026-09-26', 1200, false), closed(2, '2026-09-27', 1800, true)]));
    expect(db.limitDays()).toEqual([
      {
        limitId: 'lim_fixture0000000001',
        name: 'YouTube',
        day: '2026-09-26',
        dailyMinutes: 30,
        usedSeconds: 1200,
        applied: true,
        reached: false,
      },
      expect.objectContaining({ day: '2026-09-27', usedSeconds: 1800, reached: true }),
    ]);
    expect(db.limitDays({ from: '2026-09-27' })).toHaveLength(1);
    // A re-delivered event changes nothing; a new epoch (data deletion) wipes them.
    db.applyPage(page([closed(2, '2026-09-27', 1800, true)]));
    expect(db.limitDays()).toHaveLength(2);
    db.applyPage(page([], { epoch: OTHER, reset: true }));
    expect(db.limitDays()).toEqual([]);
    db.applyPage(page([closed(3, '2026-09-28', 60, false)], { epoch: OTHER }));
    db.wipe();
    expect(db.limitDays()).toEqual([]);
    db.close();
  });

  it('migrates a v1 file, filling limit_days from the events it already has', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centrate-db-'));
    dirs.push(dir);
    const path = join(dir, 'centrate.sqlite');
    const first = openEventsDb(path);
    first.applyPage(
      page([
        event(1, 'limit_day_closed', {
          limitId: 'lim_fixture0000000002',
          name: 'Redes sociales',
          day: '2026-09-27',
          dailyMinutes: 60,
          usedSeconds: 3600,
          applied: true,
          reached: true,
        }),
      ]),
    );
    first.close();
    // Back to v1: the table gone, as a file written by an older app.
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE limit_days; PRAGMA user_version = 1;');
    raw.close();
    const db = openEventsDb(path);
    expect(db.limitDays()).toEqual([
      {
        limitId: 'lim_fixture0000000002',
        name: 'Redes sociales',
        day: '2026-09-27',
        dailyMinutes: 60,
        usedSeconds: 3600,
        applied: true,
        reached: true,
      },
    ]);
    const version = new DatabaseSync(path);
    expect(version.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    version.close();
    db.close();
  });

  it('sets a corrupt file aside and starts over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centrate-db-'));
    dirs.push(dir);
    const path = join(dir, 'centrate.sqlite');
    writeFileSync(path, 'this is not a database at all, not even close'.repeat(100));
    let recreated = false;
    const db = openEventsDb(path, { now: () => 42, onRecreated: () => (recreated = true) });
    expect(recreated).toBe(true);
    expect(existsSync(`${path}.corrupt-42`)).toBe(true);
    db.applyPage(page([event(1, 'day_closed', {})]));
    db.close();
    const again = openEventsDb(path);
    expect(again.cursor()).toEqual({ epoch: EPOCH, lastSeq: 1 });
    again.close();
    expect(readdirSync(dir).some((f) => f.startsWith('centrate.sqlite'))).toBe(true);
  });
});
