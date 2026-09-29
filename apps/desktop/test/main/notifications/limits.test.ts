import type { WireEvent } from '@centrate/shared/domain';
import { describe, expect, it } from 'vitest';
import {
  composeNotification,
  isStale,
  limitAlertsFromEvents,
  nextFiveMinuteDue,
  noticesFromEvents,
} from '../../../src/main/notifications/policy';
import { withLocale } from '../../../src/shared/i18n/locale';
import {
  HARNESS_NOW,
  limitBlock,
  makeGuardianState,
  makeLimits,
} from '../../../src/shared/fixtures';

let seq = 500;
function ev(type: string, data: unknown, atMs = HARNESS_NOW): WireEvent {
  seq += 1;
  return {
    v: 1,
    epoch: 'ep_fixture0000000001',
    seq,
    at: new Date(atMs).toISOString(),
    wallOffsetMs: 0,
    day: '2026-09-28',
    points: 0,
    xp: 0,
    txEnd: true,
    req: null,
    type,
    data,
  } as WireEvent;
}

const LIM = 'lim_fixture0000000001';

function warning(atMs = HARNESS_NOW): WireEvent {
  return ev(
    'limit_warning',
    {
      limitId: LIM,
      name: 'YouTube',
      day: '2026-09-28',
      dailyMinutes: 30,
      usedSeconds: 1500,
      remainingSeconds: 300,
    },
    atMs,
  );
}

function reached(atMs = HARNESS_NOW): WireEvent {
  return ev(
    'limit_reached',
    {
      limitId: LIM,
      name: 'YouTube',
      day: '2026-09-28',
      dailyMinutes: 30,
      usedSeconds: 1800,
      blockId: 'blk_fixture0000000031',
    },
    atMs,
  );
}

describe('daily-limit notifications', () => {
  it('say «Te quedan 5 min de YouTube hoy» and «Has gastado tus 30 min de YouTube de hoy»', () => {
    const w = composeNotification(noticesFromEvents([warning()], HARNESS_NOW));
    expect(w).toMatchObject({
      title: 'Te quedan 5 min de YouTube hoy',
      body: 'Límite diario',
      kinds: ['limit_warning'],
    });
    const r = composeNotification(noticesFromEvents([reached()], HARNESS_NOW));
    expect(r).toMatchObject({
      title: 'Has gastado tus 30 min de YouTube de hoy',
      body: 'Bloqueado hasta las 00:00',
      kinds: ['limit_reached'],
    });
  });

  it('speak English too', () => {
    withLocale('en', () => {
      const r = composeNotification(noticesFromEvents([reached()], HARNESS_NOW));
      expect(r?.title).toBe("You've used up your 30 min of YouTube for today");
      expect(r?.body).toBe('Blocked until 12:00 AM');
    });
  });

  it('group with other notices by priority, and are never stale', () => {
    const r = composeNotification(noticesFromEvents([warning(), reached()], HARNESS_NOW));
    expect(r?.kinds).toEqual(['limit_reached', 'limit_warning']);
    expect(r?.body).toContain('También: un límite diario a punto de agotarse');
    for (const n of noticesFromEvents([warning(), reached()], HARNESS_NOW)) {
      expect(isStale(n, null, HARNESS_NOW + 60_000)).toBe(false);
    }
  });

  it('never announce a limit block as «Bloqueo iniciado» nor «Quedan 5 min»', () => {
    const block = limitBlock(HARNESS_NOW);
    const created = ev('block_created', { block, source: 'limit' });
    expect(noticesFromEvents([created], HARNESS_NOW)).toEqual([]);
    const state = makeGuardianState(HARNESS_NOW, {
      blocks: [block],
      limits: makeLimits(HARNESS_NOW),
    });
    expect(nextFiveMinuteDue(state, new Set(), HARNESS_NOW)).toBeNull();
  });

  it('give the OSD its alerts, fresh events only', () => {
    expect(limitAlertsFromEvents([warning(), reached()], HARNESS_NOW)).toEqual([
      { kind: 'warning', text: 'Te quedan 5 min de YouTube hoy' },
      { kind: 'reached', text: 'Has gastado tus 30 min de YouTube de hoy' },
    ]);
    expect(limitAlertsFromEvents([reached(HARNESS_NOW - 10 * 60_000)], HARNESS_NOW)).toEqual([]);
  });
});
