/**
 * «¡Estaba estudiando!» on a phone lying on the desk that PERCEPTION misread as «in hand»
 * (DESIGN.md §7.10): the episode offers its frames without the phone, applying it clears the
 * DUDA and the observer ignores that phone while it stays put. A phone in the hand is never
 * forgiven, and no strike is ever refunded.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/util/rng';
import type { FeedbackEpisode } from '../../src/types';
import { PERSONAS, synthesize, type Script, type SynthTick } from '../synth';
import { cameraEngine, oracleClassifier } from './harness';

const MIN = 60_000;

/** The desk phone read as moving on most runs (jitter, a new track): E_phone on and off. */
function misreadDeskPhone(ticks: SynthTick[], seed: number): SynthTick[] {
  const rng = mulberry32(seed);
  const flags = new Map<number, boolean>();
  return ticks.map((t) => {
    const phone = t.frame?.objects?.phone;
    if (!t.frame?.objects || !phone || t.activity !== 'phoneOnDesk') return t;
    const ranAt = t.frame.objects.ranAt;
    if (!flags.has(ranAt)) flags.set(ranAt, rng() < 0.7);
    const moving = flags.get(ranAt) as boolean;
    return {
      ...t,
      frame: {
        ...t.frame,
        objects: { ...t.frame.objects, phone: { ...phone, moving, stillMs: 0 } },
      },
    };
  });
}

function run(script: Script, seed: number, fps: number, vouch: boolean) {
  const persona = PERSONAS.baseline;
  const ticks = misreadDeskPhone(synthesize(script, { persona, seed, fps }), seed + 100);
  const { rec, engine, observer } = cameraEngine(oracleClassifier({ persona }));
  let episode: FeedbackEpisode | null = null;
  let clickedAt: number | null = null;
  for (const t of ticks) {
    const out = rec.tick({
      now: t.now,
      phase: t.phase,
      context: t.context,
      camera: t.camera,
      frame: t.frame,
    });
    if (vouch && clickedAt === null && out.snapshot.state === 'doubt') {
      clickedAt = t.now;
      const result = engine.feedbackEpisode(t.now);
      expect(result.ok, `seed ${seed}`).toBe(true);
      if (!result.ok) break;
      episode = result;
      const strikes = engine.totals().strikesRequested;
      rec.events.push(...engine.applyFeedback(t.now, result.episodeId));
      expect(engine.totals().strikesRequested).toBe(strikes);
      // One episode, one use (it counts against the per-session limit like any other).
      expect(engine.feedbackEpisode(t.now)).toEqual({ ok: false, reason: 'already_used' });
    }
  }
  return { rec, engine, observer, episode, clickedAt };
}

describe('«¡Estaba estudiando!» on a phone lying on the desk', { timeout: 120_000 }, () => {
  const script: Script = [
    ['typing', 30_000],
    ['phoneOnDesk', 5 * MIN],
    ['phoneInHand', 2 * MIN],
  ];
  const phoneInHandAt = 30_000 + 5 * MIN;

  it('without the button the misread desk phone strikes (the premise)', () => {
    const { rec } = run(script, 1, 3, false);
    expect(rec.strikes().filter((s) => s.at < phoneInHandAt).length).toBeGreaterThan(0);
  });

  it.each([2, 3, 4])(
    'the button clears the DUDA and that phone never strikes again (%i fps)',
    (fps) => {
      for (const seed of [1, 2, 3]) {
        const label = `${fps} fps seed ${seed}`;
        const { rec, observer, episode, clickedAt } = run(script, seed, fps, true);
        expect(clickedAt, label).not.toBeNull();
        // Frames go to LEARNING without the desk phone (it would reject them otherwise).
        expect(episode?.frames.length, label).toBeGreaterThan(0);
        expect(
          episode?.frames.every((f) => f.frame.objects?.phone == null),
          label,
        ).toBe(true);
        expect(
          rec.of('doubt_cleared').map((e) => e.by),
          label,
        ).toContain('feedback');
        const before = rec.strikes().filter((s) => s.at < phoneInHandAt);
        expect(before, label).toEqual([]);
        expect(
          rec.warnings('doubt').filter((at) => at < phoneInHandAt),
          label,
        ).toHaveLength(1);
        // Picking the phone up: it counts again, with the usual timing and cause.
        const after = rec.strikes().filter((s) => s.at >= phoneInHandAt);
        expect(after[0]?.cause, label).toBe('phone');
        expect((after[0]?.at as number) - phoneInHandAt, label).toBeLessThanOrEqual(65_000);
        expect(observer.deskPhoneSpots.length, label).toBeLessThanOrEqual(1);
      }
    },
  );

  it('a phone really in the hand is never forgiven by the button', () => {
    for (const seed of [1, 2, 3]) {
      const label = `seed ${seed}`;
      const persona = PERSONAS.baseline;
      const ticks = synthesize(
        [
          ['screen', MIN],
          ['phoneInHand', 2 * MIN],
        ],
        { persona, seed },
      );
      const { rec, engine, observer } = cameraEngine(oracleClassifier({ persona }));
      let tried = false;
      for (const t of ticks) {
        const out = rec.tick({
          now: t.now,
          phase: t.phase,
          context: t.context,
          camera: t.camera,
          frame: t.frame,
        });
        if (!tried && out.snapshot.state === 'doubt') {
          tried = true;
          const result = engine.feedbackEpisode(t.now);
          if (result.ok) {
            rec.events.push(...engine.applyFeedback(t.now, result.episodeId));
            expect(observer.deskPhoneSpots, label).toEqual([]); // it moved: no spot
          } else {
            expect(result.reason, label).toBe('no_usable_frames');
          }
        }
      }
      expect(tried, label).toBe(true);
      expect(
        rec.of('doubt_cleared').filter((e) => e.by === 'feedback'),
        label,
      ).toEqual([]);
      expect(rec.strikes()[0]?.cause, label).toBe('phone');
    }
  });
});
