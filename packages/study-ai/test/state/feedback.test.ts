/** «¡Estaba estudiando!» episode selection and application (DESIGN.md §7.10). */
import { describe, expect, it } from 'vitest';
import { STUDY_AI_CONSTANTS } from '../../src/config';
import { evenlySpaced } from '../../src/state/feedback';
import type { FeedbackEpisode, TickInput } from '../../src/types';
import { frameAt } from '../score/frames';
import { scriptedEngine, type ObservationSpec } from './harness';

const TICK = 250;

/** Study until 30 s, then low with frames; every 4th frame has a phone in hand. */
function lowWithFrames(i: TickInput): ObservationSpec {
  const frame = frameAt(i.now);
  if (i.now < 30_000) return { study: 1, frame };
  return { study: 0, frame, evidence: { phone: i.now % 1_000 === 0, lookingDown: true } };
}

function toDoubt() {
  const s = scriptedEngine(lowWithFrames);
  s.rec.run(0, 30_000, TICK);
  let t = 30_000;
  while (s.rec.firstStateAt('doubt') === null) t = s.rec.run(t, t + TICK, TICK);
  return { ...s, doubtAt: s.rec.firstStateAt('doubt') as number, t };
}

describe('evenlySpaced', () => {
  it('keeps first and last and at most `max`', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const picked = evenlySpaced(items, 30);
    expect(picked).toHaveLength(30);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(99);
    expect(evenlySpaced([1, 2], 30)).toEqual([1, 2]);
    expect(evenlySpaced([1, 2, 3], 1)).toEqual([3]);
    expect(evenlySpaced([1, 2, 3], 0)).toEqual([]);
  });
});

describe('feedbackEpisode', () => {
  it('selects ≤ 30 usable frames from max(entry − doubtAfter, now − 60 s) to the click', () => {
    const { engine, doubtAt, rec, t } = toDoubt();
    rec.run(t, doubtAt + 5_000, TICK);
    const result = engine.feedbackEpisode(doubtAt + 5_000 - TICK);
    expect(result.ok).toBe(true);
    const ep = result as FeedbackEpisode;
    expect(ep.trigger).toBe('doubt');
    expect(ep.frames.length).toBe(STUDY_AI_CONSTANTS.feedbackMaxFrames);
    const times = ep.frames.map((f) => f.frame.t);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(doubtAt - 15_000);
    expect(Math.max(...times)).toBeLessThanOrEqual(doubtAt + 5_000);
    // Never a frame with a phone in hand.
    expect(times.every((x) => x % 1_000 !== 0)).toBe(true);
    expect(ep.frames.every((f) => f.lookingDown || f.frame.t < 30_000)).toBe(true);
  });

  it('never selects absent or covered frames, or frames outside work', () => {
    const s = scriptedEngine((i) => {
      const frame = frameAt(i.now);
      if (i.now < 20_000) return { study: 1, frame };
      if (i.now < 30_000) return { presence: 'absent', frame };
      return { presence: 'covered', frame };
    });
    s.rec.run(0, 40_000, TICK);
    const result = s.engine.feedbackEpisode(40_000 - TICK);
    expect(result.ok).toBe(true);
    const ep = result as FeedbackEpisode;
    expect(ep.trigger).toBe('away');
    expect(ep.frames.every((f) => f.frame.t < 20_000)).toBe(true);
  });

  it('rejects: no episode, too old, already used, no usable frames, no camera', () => {
    const fresh = scriptedEngine(() => ({ frame: frameAt(0) }));
    fresh.rec.run(0, 5_000, TICK);
    expect(fresh.engine.feedbackEpisode(5_000)).toEqual({ ok: false, reason: 'no_episode' });

    const { engine, doubtAt, rec, t } = toDoubt();
    rec.run(t, doubtAt + 5_000, TICK);
    expect(engine.feedbackEpisode(doubtAt + 91_000)).toEqual({ ok: false, reason: 'no_episode' });
    const ep = engine.feedbackEpisode(doubtAt + 5_000) as FeedbackEpisode;
    engine.applyFeedback(doubtAt + 5_000, ep.episodeId);
    expect(engine.feedbackEpisode(doubtAt + 5_000)).toEqual({ ok: false, reason: 'already_used' });

    const noFrames = scriptedEngine((i) => ({ study: i.now < 30_000 ? 1 : 0 }));
    noFrames.rec.run(0, 60_000, TICK);
    expect(noFrames.engine.feedbackEpisode(60_000)).toEqual({
      ok: false,
      reason: 'no_usable_frames',
    });

    const noCamera = scriptedEngine((i) => ({ study: i.now < 30_000 ? 1 : 0 }), {}, 'no-camera');
    noCamera.rec.run(0, 60_000, TICK);
    expect(noCamera.engine.feedbackEpisode(60_000)).toEqual({ ok: false, reason: 'no_camera' });
  });

  it('allows 5 applications per session', () => {
    const { engine, observer, rec } = scriptedEngine(lowWithFrames);
    observer.rescoreWith = () => 0; // the retrained model still disagrees
    let t = rec.run(0, 30_000, TICK);
    let applied = 0;
    while (t < 2_000_000) {
      t = rec.run(t, t + 1_000, TICK);
      const r = engine.feedbackEpisode(t - TICK);
      if (r.ok) {
        engine.applyFeedback(t - TICK, r.episodeId);
        applied += 1;
      } else if (r.reason === 'limit_reached') break;
    }
    expect(applied).toBe(STUDY_AI_CONSTANTS.feedbackPerSession);
    expect(engine.feedbackEpisode(t)).toEqual({ ok: false, reason: 'limit_reached' });
  });
});

describe('applyFeedback', () => {
  it('clears DUDA when the re-scored window is ≥ θ + 8', () => {
    const { engine, observer, doubtAt, rec, t } = toDoubt();
    rec.run(t, doubtAt + 5_000, TICK);
    const ep = engine.feedbackEpisode(doubtAt + 5_000 - TICK) as FeedbackEpisode;
    observer.rescoreWith = () => 1;
    const events = engine.applyFeedback(doubtAt + 5_000 - TICK, ep.episodeId);
    expect(events.map((e) => e.type)).toEqual(['state', 'doubt_cleared']);
    expect(events[1]).toMatchObject({ type: 'doubt_cleared', by: 'feedback' });
    expect(engine.snapshot().state).toBe('focused');
    expect(engine.snapshot().low).toBe(false);
  });

  it('changes nothing when the retrained model still disagrees', () => {
    const { engine, observer, doubtAt, rec, t } = toDoubt();
    rec.run(t, doubtAt + 5_000, TICK);
    const ep = engine.feedbackEpisode(doubtAt + 5_000 - TICK) as FeedbackEpisode;
    observer.rescoreWith = (o) => o.study;
    expect(engine.applyFeedback(doubtAt + 5_000 - TICK, ep.episodeId)).toEqual([]);
    expect(engine.snapshot().state).toBe('doubt');
    expect(engine.applyFeedback(doubtAt + 5_000 - TICK, ep.episodeId)).toEqual([]); // used
    expect(engine.applyFeedback(doubtAt + 5_000 - TICK, 999)).toEqual([]);
  });

  it('never refunds a strike or shortens the grace', () => {
    const { engine, observer, rec, t } = toDoubt();
    let now = t;
    while (rec.strikes().length === 0) now = rec.run(now, now + TICK, TICK);
    const before = { totals: engine.totals(), grace: engine.snapshot().graceLeftMs };
    const ep = engine.feedbackEpisode(now - TICK) as FeedbackEpisode;
    expect(ep.trigger).toBe('strike');
    observer.rescoreWith = () => 1;
    const events = engine.applyFeedback(now - TICK, ep.episodeId);
    expect(events.some((e) => e.type === 'strike')).toBe(false);
    expect(engine.totals().strikesRequested).toBe(before.totals.strikesRequested);
    expect(engine.snapshot().graceLeftMs).toBe(before.grace);
  });
});
