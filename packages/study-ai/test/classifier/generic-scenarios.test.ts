/**
 * The generic classifier through DECISION's real observer and engine (review probes e-more,
 * F, G and G2): a second monitor the user works on, writing right after «Empezar», and
 * glasses glare. LEARNING's copy of the scenario runner, with control over keyboard/mouse
 * input per step (`test/state/**` belongs to DECISION).
 */
import { describe, expect, it } from 'vitest';
import { createGenericClassifier } from '../../src/classifier/generic';
import type { MonoMs } from '../../src/types';
import { PERSONAS, synthesize, type Persona, type Script, type SynthTick } from '../synth';
import { cameraEngine, type Recorder } from '../state/harness';

const MIN = 60_000;

/**
 * Keyboard/mouse per step: `synth` keeps the activity's own rate, `typing` is continuous,
 * `none` is no input from the step's start.
 */
type Input = 'synth' | 'typing' | 'none';

interface Run {
  rec: Recorder;
  focus: number;
  /** Ticks spent drowsy, per step. */
  drowsyTicks: number[];
  stepStarts: MonoMs[];
}

function withInput(ticks: SynthTick[], script: Script, input: readonly Input[]): SynthTick[] {
  const lengths = script.map((s) => ('activity' in s ? s.ms : s[1]));
  let boundary = 0;
  let step = -1;
  let lastInput = 0;
  return ticks.map((tick) => {
    while (step + 1 < lengths.length && tick.now >= boundary) {
      step += 1;
      boundary += lengths[step] as number;
    }
    const mode = input[step] ?? 'synth';
    let idleMs = tick.context.idleMs ?? 0;
    if (mode === 'typing') {
      lastInput = tick.now;
      idleMs = 0;
    } else if (mode === 'none') {
      idleMs = tick.now - lastInput;
    } else {
      lastInput = tick.now - idleMs;
    }
    return { ...tick, context: { ...tick.context, idleMs } };
  });
}

function run(
  script: Script,
  input: readonly Input[],
  options: { persona?: Persona; fps?: number; seed?: number } = {},
): Run {
  const ticks = withInput(
    synthesize(script, {
      persona: options.persona ?? PERSONAS.baseline,
      fps: options.fps ?? 3,
      seed: options.seed ?? 31,
    }),
    script,
    input,
  );
  const { rec, engine } = cameraEngine(createGenericClassifier());
  const lengths = script.map((s) => ('activity' in s ? s.ms : s[1]));
  const drowsyTicks = lengths.map(() => 0);
  const stepStarts: MonoMs[] = [];
  let boundary = 0;
  let step = -1;
  for (const t of ticks) {
    while (step + 1 < lengths.length && t.now >= boundary) {
      step += 1;
      boundary += lengths[step] as number;
      stepStarts.push(t.now);
    }
    const out = rec.tick({
      now: t.now,
      phase: t.phase,
      context: t.context,
      camera: t.camera,
      frame: t.frame,
    });
    if (out.snapshot.drowsy) drowsyTicks[step] = (drowsyTicks[step] ?? 0) + 1;
  }
  const totals = engine.totals();
  return {
    rec,
    focus: totals.workMs > 0 ? totals.focusedMs / totals.workMs : 0,
    drowsyTicks,
    stepStarts,
  };
}

const PERSONA_LIST = Object.values(PERSONAS);

describe('generic classifier, real observer and engine', { timeout: 120_000 }, () => {
  it.each([40, 45, 50])(
    'a second monitor at %i° the user works on never strikes (e-more)',
    (yaw) => {
      const script: Script = [
        ['typing', MIN],
        ['secondMonitor', 10 * MIN],
      ];
      for (const persona of PERSONA_LIST) {
        for (const input of ['typing', 'synth'] as const) {
          for (const fps of [2, 4]) {
            const { rec, focus } = run(script, ['synth', input], {
              persona: { ...persona, secondScreenYaw: yaw },
              fps,
            });
            const label = `${persona.id} ${input} ${fps} fps`;
            expect(rec.strikes(), label).toEqual([]);
            expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
            expect(focus, label).toBeGreaterThanOrEqual(0.9);
          }
        }
      }
    },
  );

  it('alternating screens every 2 min with the usual scrolling never strikes', () => {
    const script: Script = Array.from({ length: 5 }, () => [
      ['screen', 2 * MIN] as const,
      ['secondMonitor', 2 * MIN] as const,
    ]).flat();
    for (const persona of PERSONA_LIST) {
      for (const yaw of [40, 45]) {
        const { rec, focus } = run(script, [], {
          persona: { ...persona, secondScreenYaw: yaw },
          seed: 32,
        });
        const label = `${persona.id} ${yaw}°`;
        expect(rec.strikes(), label).toEqual([]);
        expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
        expect(focus, label).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it.each(['notebook', 'readBook'] as const)(
    '%s right after «Empezar», then a lecture with no input, never strikes (F)',
    (first) => {
      const script: Script = [
        [first, 40_000],
        ['screen', 10 * MIN],
      ];
      for (const persona of PERSONA_LIST) {
        for (const fps of [2, 4]) {
          const { rec, focus } = run(script, ['synth', 'none'], { persona, fps });
          const label = `${persona.id} ${fps} fps`;
          expect(rec.strikes(), label).toEqual([]);
          expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
          expect(focus, label).toBeGreaterThanOrEqual(0.9);
        }
      }
    },
  );

  it('writing below a typing direction under the screen, then the face lost for a minute, never strikes', () => {
    // The screen at −5°, typing while looking at the keyboard at −18° (a study direction of
    // its own), then a notebook at −28° with the eyes only a little down (lookDown 0.35):
    // 10° under the typing direction, 23° under the screen. The landmarker then loses the
    // bent head for 60 s. Against the nearest (typing) direction the notebook was «not
    // down», so the hidden stretch had an unknown pose and went to the absence path.
    const script: Script = [
      ['screen', MIN],
      ['typing', MIN],
      ['notebook', 3 * MIN],
    ];
    const lostFrom = 3 * MIN;
    const lostTo = 4 * MIN;
    for (const seed of [31, 32, 33]) {
      for (const fps of [2, 3, 4]) {
        const ticks = synthesize(script, { seed, fps }).map((tick): SynthTick => {
          const f = tick.frame?.face;
          if (!tick.frame || !f) return tick;
          if (tick.activity === 'typing') {
            const pitch = -18 + (f.pose.pitch + 20) / 3;
            const face = { ...f, pose: { ...f.pose, pitch }, lookDown: 0.3 };
            return { ...tick, frame: { ...tick.frame, face } };
          }
          if (tick.activity !== 'notebook') return tick;
          if (tick.now >= lostFrom && tick.now < lostTo) {
            return { ...tick, frame: { ...tick.frame, face: null, quality: 0.6 } };
          }
          const pitch = -28 + (f.pose.pitch + 40) / 3;
          const face = { ...f, pose: { ...f.pose, pitch }, lookDown: 0.35 };
          return { ...tick, frame: { ...tick.frame, face } };
        });
        const { rec } = cameraEngine(createGenericClassifier(), { keepOutputs: true });
        rec.synth(ticks);
        const label = `seed ${seed}, ${fps} fps`;
        let visible = 0;
        let down = 0;
        for (const { observation: o } of rec.outputs) {
          if (o.at < 2 * MIN + 5_000 || o.presence !== 'visible') continue;
          visible += 1;
          if (o.evidence.lookingDown) down += 1;
        }
        expect(down / visible, label).toBeGreaterThanOrEqual(0.9);
        expect(rec.strikes(), label).toEqual([]);
        expect(rec.warnings(), label).toEqual([]);
      }
    }
  });

  it.each([0.55, 0.65])('glasses glare at blink %f is not drowsiness (G)', (blink) => {
    const persona: Persona = { ...PERSONAS.glasses, blink, eyeSd: 0.05 };
    for (const input of ['synth', 'none'] as const) {
      const { rec, focus, drowsyTicks } = run(
        [
          ['typing', MIN],
          ['screen', 10 * MIN],
        ],
        ['synth', input],
        { persona },
      );
      expect(rec.strikes(), input).toEqual([]);
      expect(rec.of('suggest_break'), input).toEqual([]);
      expect(drowsyTicks, input).toEqual([0, 0]);
      expect(focus, input).toBeGreaterThanOrEqual(0.9);
    }
  });

  it.each([0.55, 0.65])('glasses glare at blink %f still strikes looking away (G2)', (blink) => {
    const persona: Persona = { ...PERSONAS.glasses, blink, eyeSd: 0.05 };
    const { rec, drowsyTicks, stepStarts } = run(
      [
        ['screen', MIN],
        ['lookAway', 4 * MIN],
      ],
      ['synth', 'none'],
      { persona },
    );
    const strikes = rec.strikes();
    expect(strikes.length).toBeGreaterThanOrEqual(1);
    expect(strikes[0]?.cause).toBe('doubt_timeout');
    expect((strikes[0]?.at ?? 0) - (stepStarts[1] ?? 0)).toBeLessThanOrEqual(65_000);
    expect(drowsyTicks).toEqual([0, 0]);
  });

  it('ordinary eyes closed for 2 min still suggest a break, never a strike', () => {
    const { rec, drowsyTicks } = run(
      [
        ['screen', MIN],
        ['eyesClosed', 2 * MIN],
        ['screen', MIN],
      ],
      [],
    );
    expect(rec.strikes()).toEqual([]);
    expect(rec.of('suggest_break').map((e) => e.reason)).toEqual(['eyes_closed']);
    expect(drowsyTicks[1]).toBeGreaterThan(0);
  });

  it('looking away for 2 min still strikes with the usual input beforehand', () => {
    for (const persona of PERSONA_LIST) {
      const { rec } = run(
        [
          ['screen', MIN],
          ['lookAway', 2 * MIN],
        ],
        [],
        { persona, seed: 33 },
      );
      expect(rec.strikes()[0]?.cause, persona.id).toBe('doubt_timeout');
    }
  });
});
