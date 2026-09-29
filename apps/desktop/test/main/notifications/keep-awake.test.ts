import type { WireEvent } from '@centrate/shared/domain';
import { describe, expect, it } from 'vitest';
import {
  composeNotification,
  isStale,
  noticesFromEvents,
} from '../../../src/main/notifications/policy';
import { HARNESS_NOW } from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';

let seq = 900;
function off(reason: 'user' | 'expired', atMs = HARNESS_NOW): WireEvent {
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
    type: 'keep_awake_off',
    data: {
      keepAwake: { on: false, durationMinutes: 60, display: true, since: null, until: null },
      reason,
    },
  } as WireEvent;
}

describe('keep-awake notification', () => {
  it('says «Ya no se mantiene despierto» when its end passed, not when turned off by hand', () => {
    const notices = noticesFromEvents([off('expired'), off('user')], HARNESS_NOW);
    expect(notices.map((n) => n.kind)).toEqual(['keep_awake_expired']);
    expect(composeNotification(notices)).toEqual({
      title: 'Ya no se mantiene despierto',
      body: 'El equipo vuelve a suspenderse cuando no lo uses.',
      kinds: ['keep_awake_expired'],
    });
    const [notice] = notices;
    if (notice) expect(isStale(notice, null, HARNESS_NOW + 60_000)).toBe(false);
    withLocale('en', () =>
      expect(composeNotification(notices)?.title).toBe('No longer kept awake'),
    );
  });

  it('comes last in a group and is dropped when old', () => {
    const attempt = { ...off('expired') } as WireEvent;
    const n = noticesFromEvents([off('expired', HARNESS_NOW - 5 * 60_000)], HARNESS_NOW);
    expect(n).toEqual([]);
    const mixed = composeNotification([
      ...noticesFromEvents([attempt], HARNESS_NOW),
      {
        kind: 'block_finished',
        atMs: HARNESS_NOW,
        epoch: null,
        seq: null,
        blockId: null,
        endsAtMs: null,
        label: null,
        points: 80,
      },
    ]);
    expect(mixed?.title).toBe('Bloqueo terminado');
    expect(mixed?.body).toContain('También: ya no se mantiene despierto');
  });
});
