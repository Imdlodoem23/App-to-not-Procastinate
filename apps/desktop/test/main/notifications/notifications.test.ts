import type { WireEvent } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import {
  composeNotification,
  isStale,
  nextFiveMinuteDue,
  noticesFromEvents,
  type Notice,
} from '../../../src/main/notifications/policy';
import { NotificationScheduler } from '../../../src/main/notifications/scheduler';
import { createRecordingNotifier } from '../../../src/main/notifications/types';
import { HARNESS_NOW, harnessFixture, makeBlock } from '../../../src/shared/fixtures';
import { prng } from '../guardian/helpers';

const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 100;
function ev(
  type: string,
  data: unknown,
  options: { points?: number; atMs?: number } = {},
): WireEvent {
  seq += 1;
  return {
    v: 1,
    epoch: 'ep_fixture0000000001',
    seq,
    at: iso(options.atMs ?? HARNESS_NOW),
    wallOffsetMs: 0,
    day: '2026-09-28',
    points: options.points ?? 0,
    xp: 0,
    txEnd: true,
    req: null,
    type,
    data,
  } as WireEvent;
}

const youtube = makeBlock(
  { n: 50, services: ['youtube'], mode: 'normal', leftMs: 42 * MIN, elapsedMs: 0 },
  HARNESS_NOW,
);

function created(atMs = HARNESS_NOW): WireEvent {
  return ev('block_created', { block: youtube, source: 'user' }, { atMs });
}
function completed(points = 80, atMs = HARNESS_NOW): WireEvent {
  return ev(
    'block_completed',
    {
      blockId: youtube.id,
      kind: 'manual',
      mode: 'normal',
      creditedMinutes: 60,
      attemptsCounted: 0,
      downtimeMs: 0,
      clockTrust: 'verified',
    },
    { points, atMs },
  );
}
function attempt(points = -10, atMs = HARNESS_NOW): WireEvent {
  return ev(
    'attempt',
    {
      attemptId: 'att_fixture0000000001',
      layer: 'extension',
      targetKey: 'svc:youtube',
      targetType: 'service',
      serviceId: 'youtube',
      blockIds: [youtube.id],
      browser: 'chrome',
      incognito: false,
      escalationIndex: 0,
      penalized: true,
    },
    { points, atMs },
  );
}

describe('notification policy', () => {
  it('turns events into notices, skipping old ones and non-user sources', () => {
    const notices = noticesFromEvents(
      [
        created(),
        completed(),
        attempt(),
        attempt(0),
        ev('block_created', { block: youtube, source: 'punishment' }),
        completed(80, HARNESS_NOW - 3 * MIN),
      ],
      HARNESS_NOW,
    );
    expect(notices.map((n) => n.kind)).toEqual(['block_started', 'block_finished', 'attempt']);
    expect(notices[0]?.label).toBe('YouTube');
  });

  it('writes the Spanish copy', () => {
    const one = (events: WireEvent[]) =>
      composeNotification(noticesFromEvents(events, HARNESS_NOW));
    expect(one([created()])).toEqual({
      title: 'Bloqueo iniciado',
      body: 'YouTube hasta las 17:42',
      kinds: ['block_started'],
    });
    expect(one([completed()])).toMatchObject({
      title: 'Bloqueo terminado',
      body: 'Hecho. +80 puntos',
    });
    expect(one([attempt()])).toMatchObject({
      title: 'Intento bloqueado: −10 puntos',
      body: 'YouTube',
    });
    expect(one([attempt(-10), attempt(-20), attempt(-40)])).toMatchObject({
      title: '3 intentos bloqueados: −70 puntos',
    });
    expect(one([completed(), attempt(-10), attempt(-20)])).toEqual({
      title: 'Bloqueo terminado',
      body: 'Hecho. +80 puntos\nTambién: 2 intentos (−30 puntos)',
      kinds: ['block_finished', 'attempt'],
    });
    expect(one([created(), completed()])?.title).toBe('Bloqueo terminado');
  });

  it('plans «Quedan 5 min» once per block end, for blocks of 10 min or more', () => {
    const state = harnessFixture('one-block').snapshot.state as GuardianStateResponse;
    const block = state.blocks[0];
    if (!block) throw new Error('no block');
    const due = nextFiveMinuteDue(state, new Set(), HARNESS_NOW);
    expect(due?.dueAt).toBe(Date.parse(block.endsAt) - 5 * MIN);
    expect(composeNotification(due ? [due.notice] : [])).toMatchObject({
      title: 'Quedan 5 min',
      body: 'YouTube, Instagram · hasta las 17:42',
    });
    expect(nextFiveMinuteDue(state, new Set([due?.key ?? '']), HARNESS_NOW)).toBeNull();
    const short = makeBlock(
      { n: 60, services: ['tiktok'], mode: 'normal', leftMs: 8 * MIN, elapsedMs: MIN },
      HARNESS_NOW,
    );
    expect(nextFiveMinuteDue({ ...state, blocks: [short] }, new Set(), HARNESS_NOW)).toBeNull();
  });

  it('drops stale notices', () => {
    const state = harnessFixture('one-block').snapshot.state as GuardianStateResponse;
    const due = nextFiveMinuteDue(state, new Set(), HARNESS_NOW);
    if (!due) throw new Error('no due');
    expect(isStale(due.notice, state, due.dueAt)).toBe(false);
    expect(isStale(due.notice, { ...state, blocks: [] }, due.dueAt)).toBe(true);
    const extended = state.blocks.map((b) => ({
      ...b,
      endsAt: iso(Date.parse(b.endsAt) + 15 * MIN),
    }));
    expect(isStale(due.notice, { ...state, blocks: extended }, due.dueAt)).toBe(true);
    const [started] = noticesFromEvents([created()], HARNESS_NOW) as [Notice];
    // A state that does not reflect the event yet cannot judge it.
    const before = { ...state, blocks: [], lastEventSeq: (started.seq ?? 0) - 1 };
    expect(isStale(started, before, HARNESS_NOW)).toBe(false);
    expect(
      isStale(started, { ...state, blocks: [], lastEventSeq: started.seq ?? 0 }, HARNESS_NOW),
    ).toBe(true);
  });
});

function scheduler(options: { focused?: boolean; state?: GuardianStateResponse | null } = {}) {
  const clock = createManualClock(HARNESS_NOW);
  const notifier = createRecordingNotifier();
  const view = { focused: options.focused ?? false };
  const state = {
    current: options.state ?? (harnessFixture('idle').snapshot.state as GuardianStateResponse),
  };
  const s = new NotificationScheduler({
    clock,
    notifier,
    mainFocused: () => view.focused,
    getState: () => state.current,
  });
  return { clock, notifier, view, state, s };
}

describe('notification scheduler', () => {
  it('shows at most one notification per minute and groups the rest', () => {
    const t = scheduler();
    t.s.ingestEvents([completed()], true);
    expect(t.notifier.shown).toHaveLength(1);
    t.clock.advance(10_000);
    t.s.ingestEvents([attempt(-10, t.clock.now())], true);
    t.clock.advance(10_000);
    t.s.ingestEvents([attempt(-20, t.clock.now())], true);
    expect(t.notifier.shown).toHaveLength(1);
    t.clock.advance(39_999);
    expect(t.notifier.shown).toHaveLength(1);
    t.clock.advance(1);
    expect(t.notifier.shown).toHaveLength(2);
    expect(t.notifier.shown[1]).toMatchObject({ title: '2 intentos bloqueados: −30 puntos' });
    expect(t.s.shown().map((n) => n.at)).toEqual([HARNESS_NOW, HARNESS_NOW + 60_000]);
  });

  it('property: never more than one per 60 s', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = prng(seed);
      const t = scheduler();
      for (let i = 0; i < 200; i += 1) {
        t.clock.advance(Math.floor(rand() * 40_000));
        const now = t.clock.now();
        const pick = rand();
        t.s.ingestEvents(
          [pick < 0.4 ? attempt(-10, now) : pick < 0.7 ? completed(30, now) : created(now)],
          true,
        );
      }
      t.clock.advance(120_000);
      const at = t.s.shown().map((n) => n.at);
      for (let i = 1; i < at.length; i += 1) {
        expect((at[i] ?? 0) - (at[i - 1] ?? 0), `seed ${seed}`).toBeGreaterThanOrEqual(60_000);
      }
      expect(at.length).toBeGreaterThan(5);
    }
  });

  it('shows nothing while the main window is focused, nor for backlog pages', () => {
    const t = scheduler({ focused: true });
    t.s.ingestEvents([completed()], true);
    expect(t.notifier.shown).toHaveLength(0);
    t.view.focused = false;
    t.s.ingestEvents([completed()], false);
    expect(t.notifier.shown).toHaveLength(0);
    t.s.ingestEvents([completed()], true);
    expect(t.notifier.shown).toHaveLength(1);
  });

  it('fires «Quedan 5 min» from its own timer and not after an extension', () => {
    const state = harnessFixture('one-block').snapshot.state as GuardianStateResponse;
    const t = scheduler({ state });
    t.s.onState(state);
    const block = state.blocks[0];
    if (!block) throw new Error('no block');
    const dueAt = Date.parse(block.endsAt) - 5 * MIN;
    t.clock.advance(dueAt - HARNESS_NOW - 1);
    expect(t.notifier.shown).toHaveLength(0);
    t.clock.advance(1);
    expect(t.notifier.shown).toEqual([
      {
        title: 'Quedan 5 min',
        body: 'YouTube, Instagram · hasta las 17:42',
        kinds: ['five_minutes'],
      },
    ]);
    // Not again for the same end; an extension plans a new one.
    t.s.onState(state);
    t.clock.advance(4 * MIN);
    expect(t.notifier.shown).toHaveLength(1);
    const extended = {
      ...state,
      blocks: [{ ...block, endsAt: iso(Date.parse(block.endsAt) + 30 * MIN) }],
    };
    t.state.current = extended;
    t.s.onState(extended);
    t.clock.advance(30 * MIN);
    expect(t.notifier.shown).toHaveLength(2);
  });

  it('the close hint is immediate', () => {
    const t = scheduler();
    t.s.showCloseHint();
    expect(t.notifier.shown[0]).toMatchObject({
      title: 'Céntrate sigue en la bandeja',
      body: 'Los bloqueos siguen activos.',
    });
  });
});
