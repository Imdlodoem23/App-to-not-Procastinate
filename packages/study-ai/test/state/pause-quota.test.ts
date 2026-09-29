/** Local pause quota: 2 pauses of 5 min per hour (the guardian also enforces it). */
import { describe, expect, it } from 'vitest';
import { PauseQuota } from '../../src/state/pause-quota';
import type { StudyPhase } from '../../src/types';

const MIN = 60_000;

/** Steps `ms` of `phase` at 1 s; returns the effective phases seen. */
function walk(q: PauseQuota, phase: StudyPhase, ms: number): StudyPhase[] {
  const out: StudyPhase[] = [];
  for (let t = 0; t < ms; t += 1_000) out.push(q.step(phase, 1_000));
  return out;
}

describe('PauseQuota', () => {
  it('lets two 5-minute pauses through, then treats a third one in the hour as work', () => {
    const q = new PauseQuota();
    expect(new Set(walk(q, 'paused', 5 * MIN))).toEqual(new Set(['paused']));
    walk(q, 'work', 10 * MIN);
    expect(new Set(walk(q, 'paused', 5 * MIN))).toEqual(new Set(['paused']));
    expect(q.status()).toEqual({ used: 2, remaining: 0, overQuota: false });
    walk(q, 'work', 10 * MIN);
    expect(new Set(walk(q, 'paused', MIN))).toEqual(new Set(['work']));
    expect(q.status().overQuota).toBe(true);
  });

  it('frees a slot one hour of awake time after a pause started', () => {
    const q = new PauseQuota();
    walk(q, 'paused', MIN);
    walk(q, 'work', MIN);
    walk(q, 'paused', MIN);
    walk(q, 'work', 60 * MIN - 3 * MIN - 2_000);
    expect(q.step('paused', 1_000)).toBe('work'); // 59:58 after the first start
    walk(q, 'work', 10_000);
    expect(q.step('paused', 1_000)).toBe('paused');
  });

  it('treats a pause that runs past 5 min (plus polling slack) as work', () => {
    const q = new PauseQuota();
    const phases = walk(q, 'paused', 5 * MIN + 20_000);
    expect(phases.slice(0, (5 * MIN) / 1_000 + 10).every((p) => p === 'paused')).toBe(true);
    expect(phases.at(-1)).toBe('work');
  });

  it('merges a pause that flickers off and on (polling glitch)', () => {
    const q = new PauseQuota();
    walk(q, 'paused', 2 * MIN);
    walk(q, 'work', 2_000);
    walk(q, 'paused', 2 * MIN);
    expect(q.status().used).toBe(1);
    walk(q, 'work', MIN);
    walk(q, 'paused', MIN);
    expect(q.status().used).toBe(2);
  });

  it('passes other phases through and ignores bad steps', () => {
    const q = new PauseQuota();
    expect(q.step('break', 1_000)).toBe('break');
    expect(q.step('ended', Number.NaN)).toBe('ended');
    expect(q.step('work', -5)).toBe('work');
  });
});
