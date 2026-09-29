import { describe, expect, it } from 'vitest';
import type { AnnounceInput } from '../../src/pages/shared/phase';
import { createEndAnnouncer, endPhase } from '../../src/pages/shared/phase';

const M = 60_000;
const NOW = Date.parse('2026-09-28T15:00:00Z');

describe('endPhase', () => {
  it('runs while the end is ahead or unknown', () => {
    expect(endPhase(NOW + 1, NOW, true)).toBe('running');
    expect(endPhase(NOW + 1, NOW, false)).toBe('running');
    expect(endPhase(null, NOW, false)).toBe('running');
  });

  it('a past end still enforced is «checking», never ended; otherwise ended', () => {
    expect(endPhase(NOW, NOW, true)).toBe('checking');
    expect(endPhase(NOW - 30_000, NOW, true)).toBe('checking');
    expect(endPhase(NOW - 30_000, NOW, false)).toBe('ended');
  });
});

describe('createEndAnnouncer', () => {
  const counting = (remainingMs: number, key = 'a'): AnnounceInput => ({
    kind: 'counting',
    key,
    remainingMs,
  });
  const run = (inputs: AnnounceInput[]): Array<string | null> => {
    const announcer = createEndAnnouncer();
    return inputs.map((input) => announcer.next(input));
  };

  it('speaks the 15, 5 and 1 min marks of a running block', () => {
    expect(run([counting(16 * M), counting(15 * M), counting(6 * M), counting(5 * M)])).toEqual([
      null,
      'Quedan 15 minutos',
      null,
      'Quedan 5 minutos',
    ]);
  });

  it('is silent when the time crosses 0 while the block is held, and speaks when it goes', () => {
    expect(
      run([
        counting(30_000),
        { kind: 'checking', key: 'a' },
        { kind: 'checking', key: 'a' },
        { kind: 'ended' },
        { kind: 'ended' },
      ]),
    ).toEqual([null, null, null, 'Bloqueo terminado', null]);
  });

  it('a held block seen only while checking still gets its end', () => {
    expect(run([{ kind: 'checking', key: 'a' }, { kind: 'ended' }])).toEqual([
      null,
      'Bloqueo terminado',
    ]);
  });

  it('never announces an end it did not see coming (page opened after it, or unknown)', () => {
    expect(run([{ kind: 'ended' }])).toEqual([null]);
    expect(run([{ kind: 'none' }, { kind: 'ended' }])).toEqual([null, null]);
    expect(run([counting(10 * M), { kind: 'none' }, { kind: 'ended' }])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('another block starts over silently (no mark from the previous one)', () => {
    expect(run([counting(16 * M, 'a'), counting(4 * M, 'b'), counting(59_000, 'b')])).toEqual([
      null,
      null,
      'Queda 1 minuto',
    ]);
  });

  it('an extended block counts again without a stale mark', () => {
    expect(
      run([counting(30_000), { kind: 'checking', key: 'a' }, counting(20 * M), counting(15 * M)]),
    ).toEqual([null, null, null, 'Quedan 15 minutos']);
  });
});
