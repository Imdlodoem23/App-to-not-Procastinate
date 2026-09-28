/**
 * Engine scenarios: synth `FrameFeatures` through the real CameraObserver and engine with an
 * oracle classifier (DESIGN.md §7.12). The brief's acceptance cases come first.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/util/rng';
import { PERSONAS, synthesize, type Activity, type Script, type ScriptStep } from '../synth';
import { cameraEngine, oracleClassifier } from './harness';
import { STUDY_SCRIPTS, focusShare, runScenario } from './scenarios';

const MIN = 60_000;
const FPS = [2, 3, 4] as const;
const SEEDS = [1, 2, 3] as const;
const PERSONA_LIST = Object.values(PERSONAS);

/** Long synthetic sessions: generous per-test time (CI machines vary). */
const HEAVY_MS = 180_000;

/** One tick at the slowest rate (2 fps) plus jitter. */
const ONE_TICK = 520;

describe('acceptance (brief)', { timeout: HEAVY_MS }, () => {
  it.each(FPS)('writing in a notebook, looking down, for 20 min: 0 strikes (%i fps)', (fps) => {
    for (const persona of PERSONA_LIST) {
      for (const seed of SEEDS) {
        const { rec } = runScenario(STUDY_SCRIPTS.notebook as Script, { persona, fps, seed });
        const label = `${persona.id} seed ${seed}`;
        expect(rec.strikes(), label).toEqual([]);
        expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
        expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it.each(FPS)('phone in hand: DUDA at 18–30 s, strike at 45–65 s, cause phone (%i fps)', (fps) => {
    for (const persona of PERSONA_LIST) {
      for (const seed of SEEDS) {
        const { rec, stepStarts } = runScenario(
          [
            ['screen', MIN],
            ['phoneInHand', 2 * MIN],
          ],
          { persona, fps, seed },
        );
        const label = `${persona.id} seed ${seed}`;
        const phoneAt = stepStarts[1] as number;
        const doubt = (rec.warnings('doubt')[0] as number) - phoneAt;
        const strike = rec.strikes()[0];
        expect(doubt, label).toBeGreaterThanOrEqual(18_000);
        expect(doubt, label).toBeLessThanOrEqual(30_000);
        expect(strike?.cause, label).toBe('phone');
        expect((strike?.at as number) - phoneAt, label).toBeGreaterThanOrEqual(45_000);
        expect((strike?.at as number) - phoneAt, label).toBeLessThanOrEqual(65_000);
      }
    }
  });

  it.each(FPS)(
    'leaving for 60 s: no_face strike 60 s after the absence is seen (%i fps)',
    (fps) => {
      for (const persona of PERSONA_LIST) {
        for (const seed of SEEDS) {
          const { rec, stepStarts, firstPresence } = runScenario(
            [
              ['screen', MIN],
              ['absent', 70_000],
              ['screen', MIN],
            ],
            { persona, fps, seed },
          );
          const label = `${persona.id} seed ${seed}`;
          const leftAt = stepStarts[1] as number;
          const seenAt = firstPresence.get('absent') as number;
          expect(seenAt - leftAt, label).toBeLessThanOrEqual(3_600); // last person runs fade
          const strikes = rec.strikes();
          expect(
            strikes.map((s) => s.cause),
            label,
          ).toEqual(['no_face']);
          const delay = (strikes[0]?.at as number) - seenAt;
          expect(delay, label).toBeGreaterThanOrEqual(60_000);
          expect(delay, label).toBeLessThanOrEqual(60_000 + ONE_TICK);
          expect(rec.warnings('absent'), label).toHaveLength(1);
        }
      }
    },
  );

  it.each(FPS)('a 5-min Pomodoro break away from the desk: no strike (%i fps)', (fps) => {
    for (const persona of PERSONA_LIST) {
      for (const seed of SEEDS) {
        const script: Script = [
          ['screen', 5 * MIN],
          ['absent', 5_000], // leaves a little early
          { activity: 'absent', ms: 10_000, phase: 'break' },
          { activity: 'absent', ms: 5 * MIN - 10_000, phase: 'break', camera: 'off' },
          ['absent', 8_000], // comes back a little late
          ['screen', 5 * MIN],
        ];
        const { rec } = runScenario(script, { persona, fps, seed });
        const label = `${persona.id} seed ${seed}`;
        expect(rec.strikes(), label).toEqual([]);
        expect(rec.warnings(), label).toEqual([]);
        expect(
          rec.of('state').map((e) => e.to),
          label,
        ).toContain('break');
      }
    }
  });
});

describe('true positives', { timeout: HEAVY_MS }, () => {
  const cases: [string, Script, string][] = [
    [
      'looking away for 2 min',
      [
        ['screen', MIN],
        ['lookAway', 2 * MIN],
      ],
      'doubt_timeout',
    ],
    [
      'covering the camera while typing',
      [
        ['screen', MIN],
        ['covered', 70_000],
      ],
      'no_face',
    ],
    [
      'a distraction in the foreground while looking at the screen',
      [['screen', MIN], { activity: 'screen', ms: 2 * MIN, foreground: 'distraction' }],
      'distraction_app',
    ],
  ];
  it.each(cases)('%s → strike %s', (_name, script, cause) => {
    for (const fps of FPS) {
      for (const seed of SEEDS) {
        const { rec } = runScenario(script, { fps, seed });
        expect(rec.strikes()[0]?.cause, `${fps} fps seed ${seed}`).toBe(cause);
      }
    }
  });

  it('covering the camera: no_face 60 s after it is seen, whatever the typing', () => {
    for (const fps of FPS) {
      const { rec, firstPresence } = runScenario(
        [
          ['screen', MIN],
          ['covered', 70_000],
        ],
        { fps },
      );
      const delay = (rec.strikes()[0]?.at as number) - (firstPresence.get('covered') as number);
      expect(delay).toBeGreaterThanOrEqual(60_000);
      expect(delay).toBeLessThanOrEqual(60_000 + ONE_TICK);
    }
  });

  it('looking away for 40 s then back: one DUDA, no strike', () => {
    for (const fps of FPS) {
      for (const seed of SEEDS) {
        const { rec } = runScenario(
          [
            ['screen', MIN],
            ['lookAway', 40_000],
            ['screen', 2 * MIN],
          ],
          { fps, seed },
        );
        expect(rec.warnings('doubt')).toHaveLength(1);
        expect(rec.strikes()).toEqual([]);
        expect(rec.of('doubt_cleared')).toHaveLength(1);
      }
    }
  });

  it('eyes closed for 2 min: suggest a break, never a strike', () => {
    for (const persona of PERSONA_LIST) {
      for (const fps of FPS) {
        const { rec } = runScenario(
          [
            ['screen', MIN],
            ['eyesClosed', 2 * MIN],
            ['screen', MIN],
          ],
          { persona, fps },
        );
        const label = `${persona.id} ${fps} fps`;
        expect(rec.strikes(), label).toEqual([]);
        // Glasses glare can hide the eyes; with reliable eyes the break is suggested.
        expect(
          rec.of('suggest_break').map((e) => e.reason),
          label,
        ).toEqual(['eyes_closed']);
      }
    }
  });

  it('any script with ≥ 70 s of continuous phone use strikes', () => {
    const rng = mulberry32(77);
    for (let k = 0; k < 20; k += 1) {
      const lead = 30_000 + Math.floor(rng() * 5) * 30_000;
      const phone = 70_000 + Math.floor(rng() * 4) * 10_000;
      const fps = FPS[k % 3] as number;
      const { rec } = runScenario(
        [
          ['notebook', lead],
          ['phoneInHand', phone],
          ['notebook', MIN],
        ],
        { fps, seed: k + 1, persona: PERSONA_LIST[k % PERSONA_LIST.length] },
      );
      expect(rec.strikes().length, `run ${k}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('continuous distraction keeps the ≈ 105 s cadence and all three strikes come only if it continues', () => {
    const { rec } = runScenario([
      ['screen', MIN],
      ['lookAway', 5 * MIN],
    ]);
    const at = rec.strikes().map((s) => s.at);
    expect(at.length).toBe(3);
    for (let i = 1; i < at.length; i += 1) {
      // 60 s grace + 15 s + 30 s; classifier noise may only delay it a little.
      expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(105_000);
      expect((at[i] as number) - (at[i - 1] as number)).toBeLessThanOrEqual(115_000);
    }
  });
});

describe('false positives: study never strikes', { timeout: HEAVY_MS }, () => {
  const names = Object.keys(STUDY_SCRIPTS);

  it.each(names)('%s, every persona (3 fps)', (name) => {
    for (const persona of PERSONA_LIST) {
      const { rec } = runScenario(STUDY_SCRIPTS[name] as Script, { persona, seed: 5 });
      const label = `${persona.id}`;
      expect(rec.strikes(), label).toEqual([]);
      expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
      expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
    }
  });

  it.each(names)('%s, baseline persona at 2, 3 and 4 fps with 3 seeds', (name) => {
    for (const fps of FPS) {
      for (const seed of SEEDS) {
        const { rec } = runScenario(STUDY_SCRIPTS[name] as Script, { fps, seed });
        const label = `${fps} fps seed ${seed}`;
        expect(rec.strikes(), label).toEqual([]);
        expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
        expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
      }
    }
  });

  it('a seeded fuzz of 50 random 30-min study-only scripts never strikes', () => {
    const rng = mulberry32(2026);
    const long: Activity[] = [
      'screen',
      'secondMonitor',
      'typing',
      'notebook',
      'readBook',
      'phoneOnDesk',
    ];
    const short: Activity[] = ['coffeeSip', 'stretch'];
    for (let k = 0; k < 50; k += 1) {
      const script: ScriptStep[] = [];
      let total = 0;
      while (total < 30 * MIN) {
        const brief = rng() < 0.2;
        const activity = brief
          ? (short[Math.floor(rng() * short.length)] as Activity)
          : (long[Math.floor(rng() * long.length)] as Activity);
        const ms = brief
          ? 5_000 + Math.floor(rng() * 16) * 1_000
          : 10_000 + Math.floor(rng() * 290) * 1_000;
        script.push({ activity, ms });
        total += ms;
      }
      const persona = PERSONA_LIST[k % PERSONA_LIST.length];
      const { rec } = runScenario(script, { persona, fps: 2 + (k % 3), seed: 100 + k });
      expect(rec.strikes(), `fuzz ${k} (${persona?.id})`).toEqual([]);
    }
  });
});

describe('performance', { timeout: HEAVY_MS }, () => {
  it('100 k ticks of observer + engine take under 1 s of CPU (after warm-up)', () => {
    const ticks = synthesize(
      [
        ['screen', 4 * 3_600_000],
        ['notebook', 4 * 3_600_000],
      ],
      { fps: 4, seed: 9 },
    ).slice(0, 100_000);
    expect(ticks.length).toBe(100_000);
    const measure = (count: number): number => {
      const { engine } = cameraEngine(oracleClassifier());
      const start = process.cpuUsage();
      for (let i = 0; i < count; i += 1) {
        const t = ticks[i] as (typeof ticks)[number];
        engine.tick({
          now: t.now,
          phase: t.phase,
          context: t.context,
          camera: t.camera,
          frame: t.frame,
        });
      }
      const used = process.cpuUsage(start);
      return (used.user + used.system) / 1_000;
    };
    measure(20_000); // JIT warm-up
    const best = Math.min(measure(100_000), measure(100_000));
    expect(best).toBeLessThan(1_000);
  });
});
