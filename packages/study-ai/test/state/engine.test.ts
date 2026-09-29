/**
 * AttentionEngine state machine with a scripted observer: exact timer boundaries for every
 * tunable value, absence, grace, phases, gaps, eyes, causes, totals and hints
 * (DESIGN.md §7.5–7.11).
 */
import { describe, expect, it } from 'vitest';
import { STUDY_AI_CONSTANTS, resolveStudyAiSettings } from '../../src/config';
import { AttentionEngine } from '../../src/state/engine';
import type { StudyPhase, TickInput } from '../../src/types';
import type { Recorder } from './harness';
import { ScriptedObserver, scriptedEngine, type ObservationSpec, type TickSpec } from './harness';

const C = STUDY_AI_CONSTANTS;
const TICK = 250;

/** Study 1 until `dropAt`, then 0 (visible). */
const dropAt =
  (at: number) =>
  (i: TickInput): ObservationSpec => ({ study: i.now < at ? 1 : 0 });

/** Runs ticks and returns the first time `pred` held for the snapshot. */
function firstLowAt(rec: Recorder, from: number, to: number): number | null {
  for (let t = from; t < to; t += TICK) {
    if (rec.tick({ now: t }).snapshot.low) return t;
  }
  return null;
}

describe('warm-up', () => {
  it('lasts 10 s, shows no score and never goes low', () => {
    const { rec } = scriptedEngine(() => ({ study: 0 }));
    let out = rec.tick({ now: 0 });
    expect(out.snapshot.state).toBe('warmup');
    expect(out.snapshot.score).toBeNull();
    for (let t = TICK; t < 10_000; t += TICK) {
      out = rec.tick({ now: t });
      expect(out.snapshot.low).toBe(false);
    }
    out = rec.tick({ now: 10_000 });
    expect(out.snapshot.state).toBe('focused');
    expect(out.snapshot.score).toBe(0);
    expect(out.snapshot.low).toBe(true); // the window is 2/3 full
    expect(rec.firstStateAt('focused')).toBe(10_000);
  });
});

describe('ENFOCADO → DUDA → STRIKE, exact boundaries', () => {
  const cases: [number, number][] = [
    [10_000, 15_000],
    [15_000, 30_000],
    [60_000, 120_000],
    [15_000, 15_000],
  ];
  it.each(cases)(
    'doubt after %i ms low, strike %i ms later',
    (doubtAfterMs, strikeAfterDoubtMs) => {
      const { rec } = scriptedEngine(dropAt(30_000), { doubtAfterMs, strikeAfterDoubtMs });
      rec.run(0, 30_000, TICK);
      const lowAt = firstLowAt(rec, 30_000, 60_000);
      expect(lowAt).not.toBeNull();
      const low = lowAt as number;
      rec.run(low + TICK, low + doubtAfterMs + strikeAfterDoubtMs + 5_000, TICK);
      expect(rec.firstStateAt('doubt')).toBe(low + doubtAfterMs);
      expect(rec.of('warning')).toEqual([
        { type: 'warning', at: low + doubtAfterMs, kind: 'doubt' },
      ]);
      expect(rec.strikes()).toEqual([
        { at: low + doubtAfterMs + strikeAfterDoubtMs, cause: 'doubt_timeout' },
      ]);
      expect(rec.of('strike')[0]?.seq).toBe(1);
    },
  );

  it('the score crosses θ about 7.5 s after the study value drops (15 s window)', () => {
    const { rec } = scriptedEngine(dropAt(30_000));
    rec.run(0, 30_000, TICK);
    const low = firstLowAt(rec, 30_000, 60_000) as number;
    expect(low - 30_000).toBeGreaterThanOrEqual(7_000);
    expect(low - 30_000).toBeLessThanOrEqual(8_000);
  });

  it('recovering clears the doubt (doubt_cleared) and restarts the low timer', () => {
    const { rec } = scriptedEngine((i) => ({ study: i.now >= 30_000 && i.now < 70_000 ? 0 : 1 }));
    rec.run(0, 90_000, TICK);
    expect(rec.warnings('doubt')).toHaveLength(1);
    expect(rec.of('doubt_cleared')).toHaveLength(1);
    expect(rec.of('doubt_cleared')[0]?.by).toBe('score');
    expect(rec.strikes()).toEqual([]);
    expect(rec.engine.snapshot().state).toBe('focused');
  });

  it('continuous distraction strikes at ≈ 52 s, then every ≈ 105 s (60 s grace)', () => {
    const { rec } = scriptedEngine(dropAt(30_000));
    rec.run(0, 30_000 + 400_000, TICK);
    const at = rec.strikes().map((s) => s.at - 30_000);
    expect(at.length).toBe(4);
    expect(at[0]).toBeGreaterThanOrEqual(50_000);
    expect(at[0]).toBeLessThanOrEqual(54_000);
    for (let i = 1; i < at.length; i += 1) {
      expect((at[i] as number) - (at[i - 1] as number)).toBe(C.strikeGraceMs + 15_000 + 30_000);
    }
    expect(rec.of('strike').map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('never enters DUDA during the grace', () => {
    const { rec } = scriptedEngine(dropAt(30_000));
    rec.run(0, 30_000 + 200_000, TICK);
    const [first] = rec.strikes();
    const doubts = rec.warnings('doubt');
    for (const w of doubts) {
      expect(w <= (first?.at ?? 0) || w >= (first?.at ?? 0) + C.strikeGraceMs).toBe(true);
    }
  });

  it('a non-counted strike (cooldown) extends the grace; a bogus value is capped', () => {
    const { rec, engine } = scriptedEngine(dropAt(30_000));
    rec.run(0, 30_000, TICK);
    let t = 30_000;
    while (rec.strikes().length === 0) {
      rec.tick({ now: t });
      t += TICK;
    }
    const s = (rec.strikes()[0] as { at: number }).at;
    engine.strikeResult(
      { seq: 1, counted: false, reason: 'cooldown', cooldownLeftMs: 70_000 },
      s + 1_000,
    );
    // Capped at 60 s from the ack (the snapshot is still at the strike tick).
    expect(engine.snapshot().graceLeftMs).toBe(61_000);
    rec.run(t, s + 200_000, TICK);
    const second = rec.strikes()[1]?.at as number;
    expect(second - s).toBe(1_000 + C.strikeGraceMs + 15_000 + 30_000);
  });

  it('a counted strike needs nothing; a not-in-work answer changes nothing', () => {
    const { engine } = scriptedEngine(() => ({}));
    engine.tick({
      now: 0,
      phase: 'work',
      context: { foreground: 'study', idleMs: 0 },
      camera: 'ok',
      frame: null,
    });
    engine.strikeResult(
      { seq: 1, counted: false, reason: 'not_in_work_phase', cooldownLeftMs: null },
      0,
    );
    expect(engine.snapshot().graceLeftMs).toBe(0);
  });
});

describe('absence path', () => {
  it.each([30_000, 60_000, 180_000])(
    'no face for %i ms → warning at half, strike at full',
    (noFaceStrikeMs) => {
      const { rec } = scriptedEngine((i) => ({ presence: i.now < 20_000 ? 'visible' : 'absent' }), {
        noFaceStrikeMs,
      });
      rec.run(0, 20_000 + noFaceStrikeMs + 2_000, TICK);
      expect(rec.firstStateAt('away')).toBe(20_000 + C.awayEnterMs);
      expect(rec.warnings('absent')).toEqual([20_000 + noFaceStrikeMs / 2]);
      expect(rec.strikes()).toEqual([{ at: 20_000 + noFaceStrikeMs, cause: 'no_face' }]);
    },
  );

  it('continuous absence strikes at 60, 180 and 300 s', () => {
    const { rec } = scriptedEngine((i) => ({ presence: i.now < 20_000 ? 'visible' : 'absent' }));
    rec.run(0, 20_000 + 310_000, TICK);
    expect(rec.strikes().map((s) => s.at - 20_000)).toEqual([60_000, 180_000, 300_000]);
    expect(rec.warnings('absent').map((t) => t - 20_000)).toEqual([30_000, 150_000, 270_000]);
    expect(rec.engine.totals().warnings).toBe(3);
  });

  it('a covered camera counts as absent even while typing', () => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.now < 20_000 ? 'visible' : 'covered',
      evidence: { inputActive: true },
    }));
    rec.run(0, 85_000, TICK);
    expect(rec.strikes()).toEqual([{ at: 80_000, cause: 'no_face' }]);
  });

  it('a lost camera counts as absent after 10 s (fails closed)', () => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.now < 20_000 ? 'visible' : 'camera_lost',
    }));
    rec.run(0, 100_000, TICK);
    expect(rec.firstStateAt('away')).toBe(20_000 + C.cameraLostMs + C.awayEnterMs);
    expect(rec.strikes()).toEqual([{ at: 20_000 + C.cameraLostMs + 60_000, cause: 'no_face' }]);
  });

  it('face flicker (one frame every 10 s) does not reset the absence', () => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.now >= 20_000 && i.now % 10_000 !== 0 ? 'absent' : 'visible',
    }));
    rec.run(0, 90_000, TICK);
    const [strike] = rec.strikes();
    expect(strike?.cause).toBe('no_face');
    expect((strike?.at as number) - 20_000).toBeGreaterThanOrEqual(60_000);
    expect((strike?.at as number) - 20_000).toBeLessThanOrEqual(64_000);
  });

  it('popping back for 5 s every 55 s does not help', () => {
    const { rec } = scriptedEngine((i) => {
      const k = (i.now - 20_000) % 60_000;
      return { presence: i.now >= 20_000 && k < 55_000 ? 'absent' : 'visible' };
    });
    rec.run(0, 150_000, TICK);
    expect(rec.strikes().length).toBeGreaterThanOrEqual(1);
    expect(rec.strikes()[0]?.cause).toBe('no_face');
  });

  it('10 s of continuous presence resets the accumulator, 9 s does not', () => {
    const script = (back: number) => (i: TickInput) => {
      const t = i.now;
      const absent = (t >= 20_000 && t < 70_000) || (t >= 70_000 + back && t < 120_000 + back);
      return { presence: absent ? ('absent' as const) : ('visible' as const) };
    };
    const reset = scriptedEngine(script(11_000));
    reset.rec.run(0, 150_000, TICK);
    expect(reset.rec.strikes()).toEqual([]);
    const kept = scriptedEngine(script(9_000));
    kept.rec.run(0, 150_000, TICK);
    expect(kept.rec.strikes().map((s) => s.cause)).toEqual(['no_face']);
  });

  it('landmarker dropouts under 2 s never add up to a strike (30 min, never 10 s unbroken)', () => {
    // A dim room the thumbnail reads as covered: the face is missed for 1.5 s of every 3 s,
    // so presence is never 10 s unbroken, as the old reset rule wanted.
    for (const kind of ['covered', 'absent'] as const) {
      const { rec } = scriptedEngine((i) => ({
        presence: i.now >= 20_000 && i.now % 3_000 >= 1_500 ? kind : 'visible',
      }));
      rec.run(0, 20_000 + 30 * 60_000, TICK);
      expect(rec.strikes(), kind).toEqual([]);
      expect(rec.warnings(), kind).toEqual([]);
      expect(rec.firstStateAt('away'), kind).toBeNull();
      const totals = rec.engine.totals();
      expect(totals.focusedMs / totals.workMs, kind).toBeGreaterThan(0.99); // dropouts credited
    }
  });

  it('a run of 2 s or more counts back from its first frame', () => {
    // 2.5 s gone, 5 s back (no reset), then gone for good: the first run's 2.25 s count.
    const { rec } = scriptedEngine((i) => {
      const t = i.now;
      const gone = (t >= 20_000 && t < 22_500) || t >= 27_500;
      return { presence: gone ? 'absent' : 'visible' };
    });
    rec.run(0, 100_000, TICK);
    expect(rec.strikes()).toEqual([{ at: 27_500 + 60_000 - 2_250, cause: 'no_face' }]);
  });

  it('dropouts do not break the presence that resets the accumulator', () => {
    // 50 s away, then 20 s back with a 1 s dropout every 3 s, then 50 s away: the return
    // (≥ 10 s of presence between dropouts) resets the accumulator, so no strike.
    const { rec } = scriptedEngine((i) => {
      const t = i.now;
      if (t >= 20_000 && t < 70_000) return { presence: 'absent' };
      if (t >= 70_000 && t < 90_000) return { presence: t % 3_000 < 1_000 ? 'absent' : 'visible' };
      if (t >= 90_000 && t < 140_000) return { presence: 'absent' };
      return { presence: 'visible' };
    });
    rec.run(0, 160_000, TICK);
    expect(rec.strikes()).toEqual([]);
  });

  it('absence has priority over a doubt in progress', () => {
    const { rec } = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      if (i.now < 60_000) return { study: 0 };
      return { presence: 'absent' };
    });
    rec.run(0, 125_000, TICK);
    expect(rec.warnings('doubt')).toHaveLength(1);
    expect(rec.strikes()).toEqual([{ at: 120_000, cause: 'no_face' }]);
    expect(rec.firstStateAt('away')).toBe(63_000);
  });

  it('returning from «No te veo» needs 2 s of presence and a 3 s warm-up', () => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.now >= 20_000 && i.now < 40_000 ? 'absent' : 'visible',
    }));
    rec.run(0, 50_000, TICK);
    const states = rec.of('state').map((e) => [e.at, e.to]);
    expect(states).toEqual([
      [10_000, 'focused'],
      [23_000, 'away'],
      [42_000, 'warmup'],
      [45_000, 'focused'],
    ]);
    expect(rec.strikes()).toEqual([]);
  });

  it('unknown presence (camera lost < 10 s) freezes the low timer', () => {
    const lost = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      if (i.now >= 40_000 && i.now < 45_000) return { presence: 'camera_lost' };
      return { study: 0 };
    });
    lost.rec.run(0, 90_000, TICK);
    const plain = scriptedEngine(dropAt(30_000));
    plain.rec.run(0, 90_000, TICK);
    const a = lost.rec.firstStateAt('doubt') as number;
    const b = plain.rec.firstStateAt('doubt') as number;
    expect(a - b).toBeGreaterThanOrEqual(5_000);
  });
});

describe('phases: breaks, pauses, the end', () => {
  it.each<[StudyPhase, number]>([
    ['break', 5 * 60_000],
    ['break', 30 * 60_000],
    ['paused', 5 * 60_000],
  ])('%s of %i ms while away emits no warning or strike', (phase, ms) => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.phase === 'work' ? 'visible' : 'absent',
      study: i.phase === 'work' ? 1 : null,
    }));
    rec.run(0, 60_000, TICK);
    rec.run(60_000, 60_000 + ms, 1_000, { phase, camera: 'off' });
    rec.run(60_000 + ms, 60_000 + ms + 60_000, TICK);
    expect(rec.strikes()).toEqual([]);
    expect(rec.warnings()).toEqual([]);
    const types = new Set(rec.events.map((e) => e.type));
    expect([...types].sort()).toEqual(['state']);
    expect(rec.of('state').map((e) => e.to)).toEqual(['focused', phase, 'warmup', 'focused']);
  });

  it('a break resets the timers: low before, fresh warm-up after', () => {
    const { rec, engine } = scriptedEngine((i) => ({ study: i.phase === 'work' ? 0 : null }));
    rec.run(0, 30_000, TICK); // low for 20 s → doubt at 25 s
    rec.run(30_000, 330_000, 1_000, { phase: 'break' });
    expect(engine.snapshot().state).toBe('break');
    expect(engine.snapshot().score).toBeNull();
    const out = rec.tick({ now: 330_000 });
    expect(out.snapshot.state).toBe('warmup');
    expect(out.snapshot.low).toBe(false);
  });

  it('ended stops everything', () => {
    const { rec, engine } = scriptedEngine(() => ({ presence: 'absent' }));
    rec.run(0, 20_000, TICK);
    rec.run(20_000, 200_000, 1_000, { phase: 'ended' });
    expect(engine.snapshot().state).toBe('ended');
    expect(rec.strikes()).toEqual([]);
    expect(engine.totals().workMs).toBeLessThanOrEqual(20_000);
  });

  it('a pause past 5 min (plus slack) is treated as work by the local quota', () => {
    const { rec, engine } = scriptedEngine((i) => ({
      presence: i.phase === 'work' ? 'absent' : 'absent',
    }));
    rec.run(0, 2_000, TICK);
    rec.run(2_000, 2_000 + 7 * 60_000, 1_000, { phase: 'paused' });
    expect(engine.pauseStatus().overQuota).toBe(true);
    expect(rec.of('state').map((e) => e.to)).toContain('warmup');
    expect(rec.strikes().map((s) => s.cause)).toEqual(['no_face']);
  });

  it('a third pause within the hour is treated as work', () => {
    const { rec, engine } = scriptedEngine(() => ({}));
    let t = rec.run(0, 1_000, TICK);
    for (let k = 0; k < 3; k += 1) {
      t = rec.run(t, t + 60_000, 1_000, { phase: 'paused' });
      t = rec.run(t, t + 60_000, TICK);
    }
    expect(engine.pauseStatus()).toEqual({ used: 2, remaining: 0, overQuota: false });
    expect(rec.of('state').filter((e) => e.to === 'paused')).toHaveLength(2);
  });
});

describe('gaps and resume', () => {
  it('a 10-minute gap gives no strike and restarts the warm-up', () => {
    const { rec, engine } = scriptedEngine((i) => ({
      presence: i.now < 10_000 ? 'visible' : 'absent',
    }));
    rec.run(0, 50_000, TICK); // 40 s absent
    rec.tick({ now: 650_000 });
    expect(engine.snapshot().state).toBe('warmup');
    rec.run(650_000 + TICK, 700_000, TICK); // 50 s more absent
    expect(rec.strikes()).toEqual([]);
    rec.run(700_000, 720_000, TICK);
    expect(rec.strikes().map((s) => s.at)).toEqual([710_000]);
  });

  it('a gap is never credited and gaps over 2 s are capped', () => {
    const { rec, engine } = scriptedEngine(() => ({}));
    rec.tick({ now: 0 });
    rec.tick({ now: 4_000 });
    expect(engine.totals().focusedMs).toBe(C.maxStepMs);
    rec.tick({ now: 20_000 });
    expect(engine.totals().focusedMs).toBe(C.maxStepMs);
    expect(engine.totals().workMs).toBe(C.maxStepMs);
  });

  it('resume() resets like a gap and reports the warm-up on the next tick', () => {
    const { rec, engine } = scriptedEngine((i) => ({
      presence: i.now < 10_000 ? 'visible' : 'absent',
    }));
    rec.run(0, 60_000, TICK);
    engine.resume(60_000);
    const out = rec.tick({ now: 60_000 + TICK });
    expect(out.events.some((e) => e.type === 'state' && e.to === 'warmup')).toBe(true);
    rec.run(60_000 + 2 * TICK, 100_000, TICK);
    expect(rec.strikes()).toEqual([]);
  });

  it('time going backwards is treated as a gap', () => {
    const { rec, engine } = scriptedEngine(() => ({ presence: 'absent' }));
    rec.run(0, 50_000, TICK);
    rec.tick({ now: 10_000 });
    expect(engine.snapshot().state).toBe('warmup');
  });
});

describe('observer switch and settings', () => {
  it('setObserver resets timers (not totals) and warms up again', () => {
    const { rec, engine } = scriptedEngine(() => ({ presence: 'absent' }));
    rec.run(0, 50_000, TICK);
    const before = engine.totals();
    const next = new ScriptedObserver(() => ({ presence: 'no_camera', study: 1 }), 'no-camera');
    engine.setObserver(next, 50_000);
    expect(next.resets).toBe(1);
    const out = rec.tick({ now: 50_000 + TICK });
    expect(out.events.map((e) => e.type)).toContain('state');
    expect(out.snapshot.mode).toBe('no-camera');
    expect(engine.totals().ticks).toBe(before.ticks + 1);
    rec.run(50_000 + 2 * TICK, 150_000, TICK);
    expect(rec.strikes()).toEqual([]);
  });

  it('setSettings clamps every value', () => {
    const { rec, engine } = scriptedEngine(dropAt(30_000));
    engine.setSettings({
      doubtAfterMs: 1,
      strikeAfterDoubtMs: 1e9,
      noFaceStrikeMs: -5,
      focusScoreThreshold: 200,
      focusWindowMs: 0,
      noCameraIdleMs: Number.NaN,
    });
    rec.run(0, 30_000, TICK);
    const low = firstLowAt(rec, 30_000, 60_000) as number;
    rec.run(low + TICK, low + 200_000, TICK);
    expect(rec.firstStateAt('doubt')).toBe(low + 10_000);
    expect((rec.strikes()[0]?.at as number) - (low + 10_000)).toBe(120_000);
  });

  it('mid-session, weaker settings wait for the next session (they cannot dodge a strike)', () => {
    const control = scriptedEngine(dropAt(30_000));
    control.rec.run(0, 200_000, TICK);
    const strikeAt = control.rec.strikes()[0]?.at as number;
    const doubtAt = control.rec.firstStateAt('doubt') as number;

    const { rec, engine } = scriptedEngine(dropAt(30_000));
    rec.run(0, doubtAt + TICK, TICK);
    expect(engine.snapshot().state).toBe('doubt');
    // Ajustes during DUDA: lowest sensitivity, longest timers, a different window.
    engine.setSettings(
      resolveStudyAiSettings({
        focusScoreThreshold: 30,
        doubtAfterMs: 60_000,
        strikeAfterDoubtMs: 120_000,
        noFaceStrikeMs: 180_000,
        focusWindowMs: 20_000,
        noCameraIdleMs: 1_200_000,
      }),
    );
    expect(engine.settingsInUse).toEqual(resolveStudyAiSettings());
    rec.run(doubtAt + TICK, 200_000, TICK);
    expect(rec.strikes()[0]?.at).toBe(strikeAt);
    expect(rec.of('doubt_cleared')).toEqual([]);
  });

  it('mid-session, stricter settings apply at once', () => {
    const control = scriptedEngine(dropAt(30_000));
    control.rec.run(0, 200_000, TICK);
    const doubtAt = control.rec.firstStateAt('doubt') as number;

    const { rec, engine } = scriptedEngine(dropAt(30_000));
    rec.run(0, doubtAt + TICK, TICK);
    engine.setSettings(
      resolveStudyAiSettings({ strikeAfterDoubtMs: 15_000, noFaceStrikeMs: 30_000 }),
    );
    expect(engine.settingsInUse.strikeAfterDoubtMs).toBe(15_000);
    expect(engine.settingsInUse.noFaceStrikeMs).toBe(30_000);
    rec.run(doubtAt + TICK, 120_000, TICK);
    expect(rec.strikes()[0]?.at).toBe(doubtAt + 15_000);
    // Mixed: each field keeps the stricter value.
    engine.setSettings(resolveStudyAiSettings({ focusScoreThreshold: 70, doubtAfterMs: 60_000 }));
    expect(engine.settingsInUse.focusScoreThreshold).toBe(70);
    expect(engine.settingsInUse.doubtAfterMs).toBe(15_000);
  });

  it('mid-absence, a longer no-face time does not push the strike back', () => {
    const { rec, engine } = scriptedEngine((i) => ({
      presence: i.now < 20_000 ? 'visible' : 'absent',
    }));
    rec.run(0, 50_000, TICK);
    engine.setSettings(resolveStudyAiSettings({ noFaceStrikeMs: 180_000 }));
    rec.run(50_000, 90_000, TICK);
    expect(rec.strikes()).toEqual([{ at: 80_000, cause: 'no_face' }]);
  });

  it('a higher sensitivity goes low sooner', () => {
    const at = (focusScoreThreshold: number) => {
      const { rec } = scriptedEngine(dropAt(30_000), { focusScoreThreshold });
      rec.run(0, 30_000, TICK);
      return firstLowAt(rec, 30_000, 60_000) as number;
    };
    expect(at(80)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(30));
  });
});

describe('smoothing and hysteresis', () => {
  it('does not flap for a signal oscillating ±5 around θ', () => {
    const { rec } = scriptedEngine((i) => ({
      study: Math.floor(i.now / 2_000) % 2 === 0 ? 0.45 : 0.55,
    }));
    let transitions = 0;
    let prev = false;
    for (let t = 0; t < 600_000; t += TICK) {
      const low = rec.tick({ now: t }).snapshot.low;
      if (low !== prev) transitions += 1;
      prev = low;
    }
    expect(transitions).toBeLessThanOrEqual(10);
  });

  it('fast recovery: 3 s of good signal clears low long before the 15 s mean would', () => {
    const { rec } = scriptedEngine((i) => ({ study: i.now >= 30_000 && i.now < 50_000 ? 0 : 1 }));
    rec.run(0, 50_000, TICK);
    expect(rec.engine.snapshot().low).toBe(true);
    let clearedAt: number | null = null;
    for (let t = 50_000; t < 70_000 && clearedAt === null; t += TICK) {
      if (!rec.tick({ now: t }).snapshot.low) clearedAt = t;
    }
    // ≈ 2 s for the short score to reach θ + 16, held 1.5 s; the long mean needs ≈ 7 s.
    expect((clearedAt as number) - 50_000).toBeLessThanOrEqual(4_000);
  });

  it('a 2 s glance at the screen every 20 s does not clear the doubt', () => {
    const { rec } = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      return { study: (i.now - 30_000) % 20_000 < 2_000 ? 1 : 0, evidence: { phone: true } };
    });
    rec.run(0, 120_000, TICK);
    expect(rec.of('doubt_cleared')).toEqual([]);
    expect(rec.strikes().map((s) => s.cause)).toEqual(['phone']);
  });

  it('needs a half-full window to go low (fresh after «No te veo»)', () => {
    const { rec } = scriptedEngine((i) => ({
      presence: i.now >= 20_000 && i.now < 30_000 ? 'absent' : 'visible',
      study: i.now >= 30_000 ? 0 : 1,
    }));
    rec.run(0, 30_000, TICK);
    const back = 32_000; // present for 2 s → warm-up
    const low = firstLowAt(rec, 30_000, 60_000) as number;
    expect(low - back).toBeGreaterThanOrEqual(7_000);
    expect(low - back).toBeLessThanOrEqual(8_000);
  });

  it('the snapshot counts down to DUDA and to the strike', () => {
    const { rec } = scriptedEngine((i) =>
      i.now < 30_000 ? { study: 1 } : { study: 0, cause: 'unknown' },
    );
    rec.run(0, 30_000, TICK);
    const low = firstLowAt(rec, 30_000, 60_000) as number;
    rec.run(low + TICK, low + 5_000, TICK);
    const snap = rec.tick({ now: low + 5_000 }).snapshot;
    expect(snap.doubtInMs).toBe(10_000);
    expect(snap.strikeInMs).toBe(40_000);
    expect(snap.cause).toBe('unknown');
  });
});

describe('eyes: drowsiness and yawns', () => {
  it('eyes closed for 2 min suggest a break once and never strike', () => {
    const { rec } = scriptedEngine((i) =>
      i.now >= 30_000 && i.now < 150_000 ? { study: null, eyes: { closed: true } } : { study: 1 },
    );
    rec.run(0, 200_000, TICK);
    expect(rec.of('suggest_break')).toHaveLength(1);
    const s = rec.of('suggest_break')[0];
    expect(s?.reason).toBe('eyes_closed');
    // PERCLOS ≥ 0.3 over the 43 s seen so far fires at ≈ 13 s; 80 % of 20 s at ≈ 16 s.
    expect((s?.at as number) - 30_000).toBeGreaterThanOrEqual(12_000);
    expect((s?.at as number) - 30_000).toBeLessThanOrEqual(17_000);
    expect(rec.strikes()).toEqual([]);
    expect(rec.warnings()).toEqual([]);
    expect(rec.engine.snapshot().drowsy).toBe(false);
  });

  it('drowsiness freezes a low timer instead of striking', () => {
    const { rec } = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      if (i.now < 45_000) return { study: 0 };
      return { study: 0.1, eyes: { closed: true } };
    });
    rec.run(0, 300_000, TICK);
    expect(rec.strikes()).toEqual([]);
    expect(rec.engine.snapshot().drowsy).toBe(true);
  });

  it('drowsiness never hides a phone in use or a distraction app (their frames are judged)', () => {
    // Glasses glare or heavy lids read as closed eyes; the pushed phone or distraction frames
    // still run the timers.
    for (const evidence of [{ phone: true }, { distractionApp: true }] as const) {
      const { rec } = scriptedEngine((i) => {
        if (i.now < 30_000) return { study: 1 };
        if (i.now < 60_000) return { study: null, eyes: { closed: true } }; // drowsy first
        return { study: 0.1, eyes: { closed: true }, evidence };
      });
      rec.run(0, 60_000, TICK);
      expect(rec.engine.snapshot().drowsy).toBe(true);
      rec.run(60_000, 180_000, TICK);
      const cause = 'phone' in evidence ? 'phone' : 'distraction_app';
      expect(rec.strikes()[0]?.cause, cause).toBe(cause);
      // DUDA after 15 s low (the window needs ~7 s to fall), strike 30 s later.
      expect((rec.strikes()[0]?.at as number) - 60_000, cause).toBeLessThanOrEqual(60_000);
    }
  });

  it('a nap with a video playing still freezes the timers (nothing pushed)', () => {
    const { rec } = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      if (i.now < 45_000) return { study: 0.1, evidence: { distractionApp: true } };
      return {
        presence: 'hidden',
        study: null,
        eyes: { closed: true },
        evidence: { distractionApp: true },
      };
    });
    rec.run(0, 600_000, TICK);
    expect(rec.strikes()).toEqual([]);
    expect(rec.engine.snapshot().drowsy).toBe(true);
  });

  it('a hidden head asleep on the desk: a break suggestion, no credit, never a strike', () => {
    // The observer marks hidden frames of a still head down as drowsy candidates.
    const { rec } = scriptedEngine((i) => {
      if (i.now < 30_000) return { study: 1 };
      if (i.now < 630_000) return { presence: 'hidden', study: null, eyes: { closed: true } };
      return { presence: 'hidden', study: 0.7 }; // moving again (writing), face still hidden
    });
    rec.run(0, 30_000, TICK);
    const credited = rec.engine.totals().focusedMs;
    rec.run(30_000, 630_000, TICK);
    const [suggest] = rec.of('suggest_break');
    expect(suggest?.reason).toBe('eyes_closed');
    expect((suggest?.at as number) - 30_000).toBeLessThanOrEqual(17_000);
    expect(rec.engine.snapshot().drowsy).toBe(true);
    expect(rec.engine.totals().focusedMs - credited).toBeLessThanOrEqual(17_000);
    expect(rec.strikes()).toEqual([]);
    expect(rec.warnings()).toEqual([]);
    // Awake again: drowsiness ends within the 5 s eyes-open window.
    rec.run(630_000, 640_000, TICK);
    expect(rec.engine.snapshot().drowsy).toBe(false);
  });

  it('suggests at most once per 10 min', () => {
    const closedAt = (t: number) => t % 300_000 >= 100_000 && t % 300_000 < 160_000;
    const { rec } = scriptedEngine((i) =>
      closedAt(i.now) ? { study: null, eyes: { closed: true } } : { study: 1 },
    );
    rec.run(0, 1_200_000, TICK);
    const at = rec.of('suggest_break').map((e) => e.at);
    expect(at.length).toBe(2);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(C.breakSuggestEveryMs);
  });

  it('three yawns in 5 min suggest a break', () => {
    const yawning = (t: number) => [60_000, 120_000, 180_000].some((y) => t >= y && t < y + 3_000);
    const { rec } = scriptedEngine((i) => ({ eyes: { yawn: yawning(i.now) } }));
    rec.run(0, 200_000, TICK);
    expect(rec.of('suggest_break').map((e) => [e.at, e.reason])).toEqual([[180_000, 'yawning']]);
  });
});

describe('strike cause (doubt path)', () => {
  const run = (spec: (t: number) => ObservationSpec) => {
    const { rec } = scriptedEngine((i) => (i.now < 30_000 ? { study: 1 } : spec(i.now)));
    rec.run(0, 120_000, TICK);
    return rec.strikes()[0]?.cause;
  };

  it('phone evidence ≥ 40 % of the low time → phone', () => {
    expect(run((t) => ({ study: 0.1, evidence: { phone: t % 2_000 < 1_000 } }))).toBe('phone');
  });

  it('else a distraction app ≥ 40 % → distraction_app', () => {
    expect(
      run((t) => ({
        study: 0.1,
        evidence: { phone: t % 10_000 < 3_000, distractionApp: t % 10_000 >= 5_000 },
      })),
    ).toBe('distraction_app');
  });

  it('else a timeout', () => {
    expect(
      run((t) => ({
        study: 0.1,
        cause: 'looking_away',
        evidence: { phone: t % 10_000 < 3_000, distractionApp: t % 10_000 >= 7_000 },
      })),
    ).toBe('doubt_timeout');
  });
});

describe('totals, credit and focus minutes', () => {
  it('credits warm-up and focused time, not low, doubt, drowsy or absent time', () => {
    const { rec, engine } = scriptedEngine((i) => {
      const t = i.now;
      if (t < 60_000) return { study: 1 };
      if (t < 90_000) return { presence: 'absent' };
      if (t < 150_000) return { study: 1 };
      return { study: 0 };
    });
    rec.run(0, 180_000 + TICK, TICK);
    const totals = engine.totals();
    expect(totals.workMs).toBe(180_000);
    expect(totals.ticks).toBe(721);
    // 60 s + (30 s absent: none) + 60 s back (2 s return delay while still «away»)
    const credited = totals.focusedMs;
    expect(credited).toBeGreaterThan(60_000 + 55_000);
    expect(credited).toBeLessThan(60_000 + 60_000 + 10_000);
    expect(engine.focusMinutes().total).toBe(3);
    expect(engine.focusMinutes().focused).toBe(2);
  });

  it('warnings count doubt and absence warnings', () => {
    const { rec, engine } = scriptedEngine((i) =>
      i.now < 30_000 ? { study: 1 } : i.now < 80_000 ? { study: 0 } : { presence: 'absent' },
    );
    rec.run(0, 200_000, TICK);
    expect(engine.totals().warnings).toBe(rec.warnings().length);
    expect(engine.totals().strikesRequested).toBe(rec.strikes().length);
    expect(rec.warnings('doubt').length).toBeGreaterThanOrEqual(1);
    expect(rec.warnings('absent').length).toBeGreaterThanOrEqual(1);
  });
});

describe('hints', () => {
  it('turn on after 5 s, off after 5 s, and off at a break', () => {
    const { rec } = scriptedEngine((i) => ({
      hints: i.now >= 20_000 && i.now < 40_000 ? ['low_light'] : [],
    }));
    rec.run(0, 60_000, TICK);
    expect(rec.of('hint').map((e) => [e.at, e.code, e.active])).toEqual([
      [25_000, 'low_light', true],
      [45_000, 'low_light', false],
    ]);
    const second = scriptedEngine(() => ({ hints: ['camera_cant_see_you'] }));
    second.rec.run(0, 10_000, TICK);
    expect(second.engine.snapshot().hints).toEqual(['camera_cant_see_you']);
    const out = second.rec.tick({ now: 10_000, phase: 'break' });
    expect(out.events.filter((e) => e.type === 'hint')).toEqual([
      { type: 'hint', at: 10_000, code: 'camera_cant_see_you', active: false },
    ]);
    expect(out.snapshot.hints).toEqual([]);
  });
});

describe('timeline from the engine', () => {
  it('records focused, low, doubt, away and break segments with marks', () => {
    const { rec, engine } = scriptedEngine((i) => {
      const t = i.now;
      if (t < 60_000) return { study: 1 };
      if (t < 150_000) return { study: 0 };
      if (t < 170_000) return { presence: 'absent' };
      return { study: 1 };
    });
    rec.run(0, 200_000, TICK);
    rec.run(200_000, 260_000, 1_000, { phase: 'break' });
    rec.run(260_000, 280_000, TICK);
    const tl = engine.timeline();
    expect(tl.durationMs).toBe(280_000 - TICK);
    const kinds = tl.segments.map((s) => s.kind);
    expect(kinds).toEqual([
      'focused',
      'low',
      'doubt',
      'low', // after the strike: still low, in the grace
      'away',
      'focused',
      'break',
      'focused',
    ]);
    for (let i = 1; i < tl.segments.length; i += 1) {
      expect(tl.segments[i]?.startMs).toBe(tl.segments[i - 1]?.endMs);
    }
    expect(tl.marks.map((m) => [m.kind, m.cause])).toEqual([
      ['warning', null],
      ['strike', 'doubt_timeout'],
    ]);
  });
});

describe('snapshot basics', () => {
  it('before the first tick, and with the classifier kind of a camera observer', () => {
    const observer = new ScriptedObserver(() => ({}));
    const engine = new AttentionEngine({
      settings: resolveStudyAiSettings(),
      observer,
      startedAt: 1_000,
    });
    const snap = engine.snapshot();
    expect(snap.state).toBe('warmup');
    expect(snap.score).toBeNull();
    expect(snap.classifier).toBeNull();
    expect(snap.graceLeftMs).toBe(0);
  });

  it('ticks faster than the window still produce integer scores', () => {
    const { rec } = scriptedEngine((i) => ({ study: (i.now % 1_000) / 1_000 }));
    const spec: TickSpec = { now: 0 };
    for (let t = 0; t < 30_000; t += 97) {
      spec.now = t;
      const s = rec.tick(spec).snapshot.score;
      if (s !== null) expect(Number.isInteger(s)).toBe(true);
    }
  });
});
