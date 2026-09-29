/**
 * Statistics from the local event log (docs/DESKTOP.md §15): minutes spread over the hours they
 * were lived, the overview, heatmap and event log, achievements with the moment they were
 * reached, CSV escaping, and the read-only connection next to the core's writer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EpochId, WireEvent } from '@centrate/shared/domain';
import type { EventsResponse } from '@centrate/shared/guardian-api';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS_DB_FILE, openEventsDb } from '../../../src/main/db/events-db';
import {
  LocalStats,
  MOCK_EVENTS_DB_FILE,
  StatsReader,
  cursorSeq,
  eventsDbFileName,
} from '../../../src/main/db/stats';
import {
  computeAchievements,
  computeHeatmap,
  computeOverview,
  dayRows,
  goalMetDays,
  logEntry,
  logIsEmpty,
  logLookups,
  spreadMinutes,
  topTargetOf,
  type StoredEvent,
} from '../../../src/main/db/stats-compute';
import { CSV_BOM, csvFileName, daysCsv, eventsCsv } from '../../../src/main/db/stats-csv';
import {
  fileSeenStore,
  freshAchievements,
  memorySeenStore,
  parseSeen,
} from '../../../src/main/db/stats-seen';
import { makeBlock } from '../../../src/shared/fixtures';
import { csvField, csvLine } from '../../../src/shared/stats';

const EPOCH = 'ep_statsepoch000000001' as EpochId;
const MIN = 60_000;

let seq = 0;
function ev(atMs: number, type: string, data: unknown, points = 0, xp = 0): WireEvent {
  seq += 1;
  return {
    v: 1,
    epoch: EPOCH,
    seq,
    at: new Date(atMs).toISOString(),
    wallOffsetMs: 0,
    day: localDay(atMs),
    points,
    xp,
    txEnd: true,
    req: null,
    type,
    data,
  } as WireEvent;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stored(events: readonly WireEvent[]): StoredEvent[] {
  return events.map((e) => ({
    epoch: e.epoch,
    seq: e.seq,
    type: e.type,
    at: e.at,
    wallOffsetMs: e.wallOffsetMs,
    day: e.day,
    points: e.points,
    xp: e.xp,
    event: e,
  }));
}

/** A day of use: a strict YouTube block 16:30–18:00 (completed), an attempt, focus minutes. */
function sampleLog(): WireEvent[] {
  seq = 0;
  const block = makeBlock(
    {
      n: 1,
      services: ['youtube'],
      mode: 'strict',
      leftMs: 60 * MIN,
      elapsedMs: 30 * MIN,
      reason: 'secreto',
    },
    Date.parse('2026-09-28T15:00:00.000Z'),
  );
  return [
    ev(Date.parse('2026-09-27T21:59:00.000Z'), 'epoch_started', {
      reason: 'install',
      previousEpoch: null,
      carryOverBalance: 0,
      escalation: { lastCountedAt: null, index: 0 },
      kept: {
        blocks: [],
        punishments: [],
        allowances: [],
        schedules: [],
        settings: {},
        pendingSettings: [],
        materializedOccurrences: [],
      },
    }),
    ev(Date.parse('2026-09-28T14:30:00.000Z'), 'block_created', { block, source: 'user' }),
    ev(
      Date.parse('2026-09-28T15:10:00.000Z'),
      'attempt',
      {
        attemptId: 'att_x',
        layer: 'window',
        targetKey: 'svc:youtube',
        targetType: 'service',
        serviceId: 'youtube',
        blockIds: [block.id],
        browser: 'chrome',
        incognito: false,
        escalationIndex: 0,
        penalized: true,
      },
      -10,
    ),
    ev(
      Date.parse('2026-09-28T15:20:00.000Z'),
      'attempt',
      {
        attemptId: 'att_y',
        layer: 'extension',
        targetKey: 'dom:reddit.com',
        targetType: 'domain',
        serviceId: null,
        blockIds: [block.id],
        browser: 'chrome',
        incognito: false,
        escalationIndex: 1,
        penalized: true,
      },
      -20,
    ),
    ev(
      Date.parse('2026-09-28T16:00:00.000Z'),
      'block_completed',
      {
        blockId: block.id,
        kind: 'manual',
        mode: 'strict',
        creditedMinutes: 90,
        attemptsCounted: 2,
        downtimeMs: 0,
        clockTrust: 'verified',
      },
      90,
    ),
    ev(
      Date.parse('2026-09-28T16:30:00.000Z'),
      'focus_minutes',
      { sessionId: 'stu_x', minutes: 25 },
      50,
      25,
    ),
  ];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'centrate-stats-'));
  dirs.push(d);
  return d;
}

describe('minutes are spread over the hours they were lived', () => {
  it('splits backwards from the end at local hour edges', () => {
    // A block that ended at 18:00 Madrid after 90 min: 30 min at 16 h, 60 at 17 h.
    const chunks = spreadMinutes(Date.parse('2026-09-28T16:00:00.000Z'), 90);
    expect(chunks.map((c) => [c.day, c.hour, c.minutes])).toEqual([
      ['2026-09-28', 17, 60],
      ['2026-09-28', 16, 30],
    ]);
  });

  it('crosses midnight into the previous day', () => {
    const chunks = spreadMinutes(Date.parse('2026-09-28T22:20:00.000Z'), 40); // 00:20 Madrid
    expect(chunks.map((c) => [c.day, c.hour, c.minutes])).toEqual([
      ['2026-09-29', 0, 20],
      ['2026-09-28', 23, 20],
    ]);
  });

  it('never loses or invents a minute', () => {
    for (const minutes of [0, 1, 59, 60, 61, 1439]) {
      const total = spreadMinutes(Date.parse('2026-09-28T13:37:30.000Z'), minutes).reduce(
        (s, c) => s + c.minutes,
        0,
      );
      expect(total, String(minutes)).toBe(minutes);
    }
  });
});

describe('overview', () => {
  const rows = stored(sampleLog());

  it('day: hourly bars, totals, top targets and hours', () => {
    const o = computeOverview({
      query: { range: 'day', anchor: '2026-09-28' },
      today: '2026-09-28',
      rows,
      metDays: new Set(),
      empty: false,
    });
    expect(o.from).toBe('2026-09-28');
    expect(o.buckets).toHaveLength(24);
    const h = (hour: number) => o.buckets[hour];
    expect(h(16)).toMatchObject({ key: '2026-09-28T16', blockMinutes: 30, focusMinutes: 0 });
    expect(h(17)).toMatchObject({ blockMinutes: 60, attempts: 2, points: -30 });
    expect(h(18)).toMatchObject({ focusMinutes: 25, points: 90 + 50 });
    expect(o.totals).toMatchObject({
      blockMinutes: 90,
      focusMinutes: 25,
      completedBlocks: 1,
      attempts: 2,
      pointsEarned: 140,
      pointsLost: 30,
    });
    expect(o.topTargets).toEqual([
      { kind: 'domain', id: 'reddit.com', attempts: 1, pointsLost: 20 },
      { kind: 'service', id: 'youtube', attempts: 1, pointsLost: 10 },
    ]);
    expect(o.hours[17]).toEqual({ hour: 17, focusMinutes: 0, blockMinutes: 60 });
    const sum = o.buckets.reduce((s, b) => s + b.blockMinutes + b.focusMinutes, 0);
    expect(sum).toBe(o.totals.blockMinutes + o.totals.focusMinutes);
  });

  it('week: Monday first, one bar per day; empty periods stay zero', () => {
    const o = computeOverview({
      query: { range: 'week', anchor: null },
      today: '2026-09-30',
      rows,
      metDays: new Set(['2026-09-28']),
      empty: false,
    });
    expect(o.from).toBe('2026-09-28');
    expect(o.to).toBe('2026-10-04');
    expect(o.buckets.map((b) => b.key)[0]).toBe('2026-09-28');
    expect(o.buckets[0]).toMatchObject({ blockMinutes: 90, focusMinutes: 25, attempts: 2 });
    expect(o.buckets[1]).toMatchObject({ blockMinutes: 0, attempts: 0, points: 0 });
    expect(o.totals.goalDaysMet).toBe(1);
    const earlier = computeOverview({
      query: { range: 'week', anchor: '2026-09-14' },
      today: '2026-09-30',
      rows,
      metDays: new Set(),
      empty: false,
    });
    expect(earlier.totals.blockMinutes).toBe(0);
    expect(earlier.topTargets).toEqual([]);
  });

  it('the empty state is about activity, not the log itself', () => {
    expect(logIsEmpty(rows.slice(0, 1))).toBe(true);
    expect(logIsEmpty(rows)).toBe(false);
  });

  it('reads attempt target keys', () => {
    expect(topTargetOf('svc:youtube')).toEqual({ kind: 'service', id: 'youtube' });
    expect(topTargetOf('proc:game.exe')).toEqual({ kind: 'process', id: 'game.exe' });
    expect(topTargetOf('nonsense')).toBeNull();
  });
});

describe('heatmap', () => {
  it('one cell per day up to today, levels against the goal', () => {
    const h = computeHeatmap({
      end: '2026-09-28',
      weeks: 2,
      today: '2026-09-28',
      goalMinutes: 60,
      rows: stored(sampleLog()),
    });
    expect(h.from).toBe('2026-09-21');
    expect(h.to).toBe('2026-10-04');
    expect(h.cells).toHaveLength(8);
    expect(h.cells[h.cells.length - 1]).toEqual({
      day: '2026-09-28',
      focusMinutes: 25,
      blockMinutes: 90,
      level: 4,
    });
    expect(h.cells[0]?.level).toBe(0);
  });
});

describe('event log', () => {
  const rows = stored(sampleLog());
  const lookups = logLookups(rows);

  it('shows a target, minutes and mode but never the reason', () => {
    const created = logEntry(rows[1] as StoredEvent, lookups);
    expect(created).toMatchObject({
      type: 'block_created',
      target: 'youtube',
      minutes: 90,
      mode: 'strict',
    });
    expect(JSON.stringify(created)).not.toContain('secreto');
    expect(logEntry(rows[2] as StoredEvent, lookups)).toMatchObject({
      type: 'attempt',
      target: 'youtube',
      points: -10,
      mode: 'strict',
    });
    expect(logEntry(rows[3] as StoredEvent, lookups).target).toBe('reddit.com');
    expect(logEntry(rows[4] as StoredEvent, lookups)).toMatchObject({
      type: 'block_completed',
      target: 'youtube',
      minutes: 90,
    });
    expect(logEntry(rows[5] as StoredEvent, lookups)).toMatchObject({
      type: 'focus_minutes',
      target: null,
      minutes: 25,
    });
  });

  it('parses cursors', () => {
    expect(cursorSeq(null)).toBeNull();
    expect(cursorSeq('ep_abc:42')).toBe(42);
    expect(cursorSeq('17')).toBe(17);
    expect(cursorSeq('ep_abc')).toBeNull();
  });
});

describe('achievements', () => {
  it('records when each one was reached', () => {
    const list = computeAchievements(stored(sampleLog()));
    const first = list.find((a) => a.id === 'first-block');
    expect(first).toEqual({
      id: 'first-block',
      achieved: true,
      current: 1,
      threshold: 1,
      achievedAt: '2026-09-28T16:00:00.000Z',
    });
    expect(list.find((a) => a.id === 'study-10h')).toMatchObject({
      achieved: false,
      current: 25,
      achievedAt: null,
    });
    expect(list).toHaveLength(8);
  });

  it('fresh ones are the reached ones not seen in this epoch', () => {
    expect(
      freshAchievements(['first-block', 'streak-7'], { epoch: 'a', ids: ['first-block'] }, 'a'),
    ).toEqual(['streak-7']);
    expect(freshAchievements(['first-block'], { epoch: 'old', ids: ['first-block'] }, 'a')).toEqual(
      ['first-block'],
    );
    expect(parseSeen('{"epoch":"a","ids":["first-block","nope",3]}')).toEqual({
      epoch: 'a',
      ids: ['first-block'],
    });
    expect(parseSeen('not json')).toEqual({ epoch: null, ids: [] });
    const memory = memorySeenStore();
    memory.write({ epoch: 'x', ids: ['streak-7'] });
    expect(memory.read()).toEqual({ epoch: 'x', ids: ['streak-7'] });
    const file = fileSeenStore(temp());
    expect(file.read()).toEqual({ epoch: null, ids: [] });
    file.write({ epoch: 'e', ids: ['first-block'] });
    expect(file.read()).toEqual({ epoch: 'e', ids: ['first-block'] });
  });
});

describe('CSV', () => {
  it('escapes fields and defuses formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+34 600')).toBe("'+34 600");
    expect(csvField('@cmd')).toBe("'@cmd");
    expect(csvField(-10)).toBe('-10');
    expect(csvField(null)).toBe('');
    expect(csvLine(['a', 1, null])).toBe('a,1,\r\n');
  });

  it('exports the log and the days with a BOM, CRLF and headers', () => {
    const rows = stored(sampleLog());
    const out = eventsCsv(rows, logLookups(rows), [
      'fecha',
      'tipo',
      'puntos',
      'objetivo',
      'minutos',
      'modo',
    ]);
    expect(out.rows).toBe(6);
    expect(out.text.startsWith(`${CSV_BOM}fecha,tipo,puntos,objetivo,minutos,modo\r\n`)).toBe(true);
    expect(out.text).toContain('2026-09-28 17:10:00,attempt,-10,youtube,,strict\r\n');
    expect(out.text).not.toContain('secreto');
    const days = daysCsv(dayRows(rows, new Set(['2026-09-28'])), ['d', 'f', 'b', 'a', 'p', 'g']);
    expect(days.text).toContain('2026-09-28,25,90,2,110,1\r\n');
    expect(csvFileName('events', '2026-09-28', { events: 'eventos', days: 'dias' })).toBe(
      'centrate-eventos-2026-09-28.csv',
    );
    expect(csvFileName('days', '2026-09-28', { events: '../x', days: 'dí as' })).toBe(
      'centrate-das-2026-09-28.csv',
    );
  });
});

describe('goal days from the ledger', () => {
  it('a closed day with enough focus is met', () => {
    seq = 100;
    const rows = stored([
      ev(
        Date.parse('2026-09-27T10:00:00.000Z'),
        'focus_minutes',
        { sessionId: 's', minutes: 60 },
        120,
        60,
      ),
      ev(Date.parse('2026-09-27T22:01:00.000Z'), 'day_closed', {
        day: '2026-09-27',
        goalMinutes: 60,
      }),
    ]);
    expect([...goalMetDays(rows)]).toEqual(['2026-09-27']);
  });
});

describe('the read-only connection', () => {
  function page(events: WireEvent[], reset = false): EventsResponse {
    const last = events[events.length - 1];
    return { epoch: EPOCH, reset, events, lastSeq: last ? last.seq : 0, hasMore: false };
  }

  it('reads what the core wrote, page by page, and follows a reset', () => {
    const dir = temp();
    const path = join(dir, EVENTS_DB_FILE);
    const writer = openEventsDb(path);
    const events = sampleLog();
    writer.applyPage(page(events, true));
    const stats = new LocalStats({
      open: () => StatsReader.open(path),
      today: () => '2026-09-28',
      goalMinutes: () => 60,
      csvHeaders: () => ({
        events: ['a', 'b', 'c', 'd', 'e', 'f'],
        days: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
      csvNames: () => ({ events: 'eventos', days: 'dias' }),
    });
    expect(stats.cursor()).toEqual({ epoch: EPOCH, lastSeq: events.length });
    const overview = stats.overview({ range: 'day', anchor: null });
    expect(overview.totals.blockMinutes).toBe(90);
    expect(overview.empty).toBe(false);

    const first = stats.events('all', null, 4);
    expect(first.entries.map((e) => e.type)).toEqual([
      'focus_minutes',
      'block_completed',
      'attempt',
      'attempt',
    ]);
    expect(first.total).toBe(6);
    expect(first.nextBefore).toBe(`${EPOCH}:3`);
    const second = stats.events('all', first.nextBefore, 4);
    expect(second.entries.map((e) => e.type)).toEqual(['block_created', 'epoch_started']);
    expect(second.nextBefore).toBeNull();
    expect(stats.events('attempts', null, 10).total).toBe(2);
    expect(stats.events('blocks', null, 10).entries).toHaveLength(2);
    expect(stats.events('points', null, 10).total).toBe(4);

    expect(stats.achievements().find((a) => a.id === 'first-block')?.achieved).toBe(true);
    expect(stats.heatmap({ end: null, weeks: 1 }).cells.at(-1)?.level).toBe(4);
    expect(stats.csv('events').fileName).toBe('centrate-eventos-2026-09-28.csv');

    // «Borrar todos mis datos»: the writer wipes, the reader sees it.
    writer.wipe();
    expect(stats.overview({ range: 'day', anchor: null }).empty).toBe(true);
    expect(stats.events('all', null, 10)).toEqual({ entries: [], nextBefore: null, total: 0 });
    stats.close();
    writer.close();
  });

  it('grows its cache with the new rows only, and rebuilds for a new epoch', () => {
    const dir = temp();
    const path = join(dir, EVENTS_DB_FILE);
    const writer = openEventsDb(path);
    const events = sampleLog();
    const options = {
      open: () => StatsReader.open(path),
      today: () => '2026-09-28',
      goalMinutes: () => 60,
      csvHeaders: () => ({
        events: ['a', 'b', 'c', 'd', 'e', 'f'],
        days: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
      csvNames: () => ({ events: 'eventos', days: 'dias' }),
    };
    writer.applyPage(page(events.slice(0, 2), true));
    const stats = new LocalStats(options);
    expect(stats.achievements().find((a) => a.id === 'first-block')?.achieved).toBe(false);
    expect(stats.rowsRead).toBe(2);
    // Asked again without a change: nothing is read.
    expect(stats.epochEvents()).toHaveLength(2);
    expect(stats.rowsRead).toBe(2);

    // Each new page reads only its own rows; the answers match a fresh full read.
    writer.applyPage(page(events.slice(2, 4)));
    stats.achievements();
    expect(stats.rowsRead).toBe(4);
    writer.applyPage(page(events.slice(4)));
    const incremental = {
      achievements: stats.achievements(),
      events: stats.epochEvents().map((e) => e.seq),
      log: stats.events('all', null, 10),
      csv: stats.csv('days').text,
      overview: stats.overview({ range: 'day', anchor: null }),
    };
    expect(stats.rowsRead).toBe(events.length);
    const fresh = new LocalStats(options);
    expect(incremental).toEqual({
      achievements: fresh.achievements(),
      events: fresh.epochEvents().map((e) => e.seq),
      log: fresh.events('all', null, 10),
      csv: fresh.csv('days').text,
      overview: fresh.overview({ range: 'day', anchor: null }),
    });
    expect(incremental.achievements.find((a) => a.id === 'first-block')?.achieved).toBe(true);
    // The memoised list is a copy: a caller cannot change the cache.
    incremental.achievements.length = 0;
    expect(stats.achievements().length).toBeGreaterThan(0);

    // A new epoch (data deletion) starts over from what the table holds now.
    writer.wipe();
    expect(stats.epochEvents()).toEqual([]);
    expect(stats.achievements().every((a) => !a.achieved)).toBe(true);
    stats.close();
    fresh.close();
    writer.close();
  });

  it('refuses a missing file (the core creates it)', () => {
    expect(() => StatsReader.open(join(temp(), 'missing.sqlite'))).toThrow();
    expect(eventsDbFileName(true)).toBe(MOCK_EVENTS_DB_FILE);
    expect(eventsDbFileName(false)).toBe(EVENTS_DB_FILE);
  });
});
