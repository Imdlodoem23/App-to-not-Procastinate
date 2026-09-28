/** Timeline segments, marks and the summary buckets (DESIGN.md §7.9). */
import { describe, expect, it } from 'vitest';
import { TimelineBuilder, bucketizeTimeline } from '../../src/state/timeline';
import type { SessionTimeline, TimelineKind } from '../../src/types';

function build(pieces: readonly [TimelineKind, number][], step = 500): SessionTimeline {
  const b = new TimelineBuilder();
  let t = 0;
  for (const [kind, ms] of pieces) {
    for (let end = t + ms; t < end; t += step) b.add(kind, t, Math.min(t + step, end));
  }
  return b.build(t);
}

describe('TimelineBuilder', () => {
  it('merges neighbours of the same kind', () => {
    const tl = build([
      ['focused', 60_000],
      ['low', 20_000],
      ['doubt', 30_000],
      ['focused', 10_000],
    ]);
    expect(tl.segments).toEqual([
      { startMs: 0, endMs: 60_000, kind: 'focused' },
      { startMs: 60_000, endMs: 80_000, kind: 'low' },
      { startMs: 80_000, endMs: 110_000, kind: 'doubt' },
      { startMs: 110_000, endMs: 120_000, kind: 'focused' },
    ]);
    expect(tl.durationMs).toBe(120_000);
  });

  it('absorbs pieces under 5 s into the previous segment and re-merges', () => {
    const tl = build([
      ['focused', 30_000],
      ['low', 3_000],
      ['focused', 30_000],
      ['away', 4_500],
      ['doubt', 10_000],
    ]);
    expect(tl.segments).toEqual([
      { startMs: 0, endMs: 67_500, kind: 'focused' },
      { startMs: 67_500, endMs: 77_500, kind: 'doubt' },
    ]);
  });

  it('keeps holes for time that was not observed', () => {
    const b = new TimelineBuilder();
    b.add('focused', 0, 10_000);
    b.add('focused', 70_000, 80_000);
    const tl = b.build(80_000);
    expect(tl.segments).toEqual([
      { startMs: 0, endMs: 10_000, kind: 'focused' },
      { startMs: 70_000, endMs: 80_000, kind: 'focused' },
    ]);
  });

  it('records marks and returns copies', () => {
    const b = new TimelineBuilder();
    b.add('focused', 0, 1_000);
    b.mark('strike', 900, 'phone');
    const a = b.build(1_000);
    b.add('focused', 1_000, 2_000);
    expect(a.segments[0]?.endMs).toBe(1_000);
    expect(a.marks).toEqual([{ atMs: 900, kind: 'strike', cause: 'phone' }]);
  });
});

describe('bucketizeTimeline', () => {
  it('takes the worst kind per bucket', () => {
    const tl: SessionTimeline = {
      durationMs: 400,
      segments: [
        { startMs: 0, endMs: 100, kind: 'focused' },
        { startMs: 100, endMs: 110, kind: 'low' },
        { startMs: 110, endMs: 190, kind: 'drowsy' },
        { startMs: 190, endMs: 200, kind: 'away' },
        { startMs: 200, endMs: 300, kind: 'break' },
        { startMs: 300, endMs: 350, kind: 'paused' },
        { startMs: 350, endMs: 380, kind: 'doubt' },
      ],
      marks: [],
    };
    expect(bucketizeTimeline(tl, 4)).toEqual(['focused', 'away', 'break', 'doubt']);
    expect(bucketizeTimeline(tl, 8)).toEqual([
      'focused',
      'focused',
      'low',
      'away',
      'break',
      'break',
      'paused',
      'doubt',
    ]);
  });

  it('marks unobserved time as paused and handles degenerate input', () => {
    const tl: SessionTimeline = {
      durationMs: 100,
      segments: [{ startMs: 0, endMs: 50, kind: 'focused' }],
      marks: [],
    };
    expect(bucketizeTimeline(tl, 2)).toEqual(['focused', 'paused']);
    expect(bucketizeTimeline(tl, 0)).toEqual([]);
    expect(bucketizeTimeline({ ...tl, durationMs: 0 }, 5)).toEqual([]);
    expect(bucketizeTimeline(tl, Number.NaN)).toEqual([]);
  });
});
