import { describe, expect, it } from 'vitest';
import { HeartbeatAccumulator } from '../../src/runtime/heartbeat';
import type { AttentionSnapshot, AttentionTotals, SessionReport } from '../../src/types';

const SNAPSHOT: AttentionSnapshot = {
  at: 0,
  mode: 'camera',
  state: 'focused',
  score: 82,
  low: false,
  presence: 'visible',
  cause: null,
  drowsy: false,
  classifier: 'personal',
  graceLeftMs: 0,
  doubtInMs: null,
  strikeInMs: null,
  hints: [],
};

function report(
  runId: string,
  totals: Partial<AttentionTotals>,
  snapshot: Partial<AttentionSnapshot> = {},
  cameraOn = true,
): SessionReport {
  return {
    runId,
    at: 0,
    mode: 'camera',
    camera: 'ok',
    cameraOn,
    snapshot: { ...SNAPSHOT, ...snapshot },
    totals: { focusedMs: 0, warnings: 0, strikesRequested: 0, ticks: 0, workMs: 0, ...totals },
    loop: null,
  };
}

describe('HeartbeatAccumulator', () => {
  it('sends deltas of the cumulative totals', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { focusedMs: 1_000, warnings: 0, ticks: 3 }), 1_000);
    acc.report(report('a', { focusedMs: 14_000, warnings: 1, ticks: 45 }), 15_000);
    const first = acc.take(15_000);
    expect(first).toEqual({
      state: 'focused',
      focusScore: 82,
      focusedMsSinceLast: 14_000,
      warningsSinceLast: 1,
      cameraOn: true,
    });
    acc.report(report('a', { focusedMs: 20_000, warnings: 1, ticks: 90 }, { score: 40 }), 30_000);
    const second = acc.take(30_000);
    expect(second?.focusedMsSinceLast).toBe(6_000);
    expect(second?.warningsSinceLast).toBe(0);
    expect(second?.focusScore).toBe(40);
  });

  it('maps the snapshot through heartbeatState and passes cameraOn and a null score', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { ticks: 1 }, { state: 'break', score: null }, false), 0);
    const body = acc.take(0);
    expect(body?.state).toBe('break');
    expect(body?.focusScore).toBeNull();
    expect(body?.cameraOn).toBe(false);
  });

  it('clamps to the API limits and carries the rest over', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { focusedMs: 700_000, warnings: 130, ticks: 10 }), 0);
    const first = acc.take(0);
    expect(first?.focusedMsSinceLast).toBe(600_000);
    expect(first?.warningsSinceLast).toBe(100);
    const second = acc.take(1);
    expect(second?.focusedMsSinceLast).toBe(100_000);
    expect(second?.warningsSinceLast).toBe(30);
    expect(acc.take(2)?.focusedMsSinceLast).toBe(0);
  });

  it('a new runId starts a new baseline without re-sending old totals', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { focusedMs: 50_000, warnings: 2, ticks: 100 }), 0);
    expect(acc.take(0)?.focusedMsSinceLast).toBe(50_000);
    acc.report(report('a', { focusedMs: 55_000, warnings: 2, ticks: 110 }), 5_000);
    // The analysis window restarts: totals count from zero again.
    acc.report(report('b', { focusedMs: 3_000, warnings: 0, ticks: 5 }), 8_000);
    acc.report(report('b', { focusedMs: 9_000, warnings: 1, ticks: 20 }), 14_000);
    const body = acc.take(15_000);
    expect(body?.focusedMsSinceLast).toBe(5_000 + 9_000);
    expect(body?.warningsSinceLast).toBe(1);
    // A late report of the replaced run counts nothing.
    acc.report(report('a', { focusedMs: 90_000, warnings: 9, ticks: 200 }), 15_500);
    acc.report(report('b', { focusedMs: 10_000, warnings: 1, ticks: 25 }), 16_000);
    expect(acc.take(16_000)?.focusedMsSinceLast).toBe(1_000);
  });

  it('never counts a report twice when totals go backwards', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { focusedMs: 10_000, ticks: 10 }), 0);
    acc.report(report('a', { focusedMs: 8_000, ticks: 9 }), 1_000);
    acc.report(report('a', { focusedMs: 11_000, ticks: 11 }), 2_000);
    expect(acc.take(2_000)?.focusedMsSinceLast).toBe(11_000);
  });

  it('restore gives back an unsent body', () => {
    const acc = new HeartbeatAccumulator();
    acc.report(report('a', { focusedMs: 12_000, warnings: 1, ticks: 40 }), 0);
    const body = acc.take(0);
    expect(body).not.toBeNull();
    if (body) acc.restore(body);
    acc.report(report('a', { focusedMs: 20_000, warnings: 1, ticks: 80 }), 15_000);
    const next = acc.take(15_000);
    expect(next?.focusedMsSinceLast).toBe(20_000);
    expect(next?.warningsSinceLast).toBe(1);
  });

  it('is dead with no report, and when ticks stop advancing for > 60 s', () => {
    const acc = new HeartbeatAccumulator();
    expect(acc.alive(0)).toBe(false);
    expect(acc.take(0)).toBeNull();
    acc.report(report('a', { focusedMs: 1_000, ticks: 5 }), 0);
    expect(acc.alive(60_000)).toBe(true);
    // Reports keep arriving but the loop is frozen (ticks do not move).
    acc.report(report('a', { focusedMs: 1_000, ticks: 5 }), 30_000);
    acc.report(report('a', { focusedMs: 1_000, ticks: 5 }), 60_000);
    expect(acc.alive(60_001)).toBe(false);
    expect(acc.take(60_001)).toBeNull();
    // Progress revives it.
    acc.report(report('a', { focusedMs: 2_000, ticks: 6 }), 61_000);
    expect(acc.alive(61_000)).toBe(true);
    expect(acc.take(61_000)?.focusedMsSinceLast).toBe(2_000);
  });

  it('honours a custom dead-after time', () => {
    const acc = new HeartbeatAccumulator({ deadAfterMs: 5_000 });
    acc.report(report('a', { ticks: 1 }), 0);
    expect(acc.alive(5_000)).toBe(true);
    expect(acc.alive(5_001)).toBe(false);
  });
});
