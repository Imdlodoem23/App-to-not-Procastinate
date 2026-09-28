/**
 * Engine scenarios for what the camera cannot judge well (DESIGN.md §7.1–7.3): a textbook
 * lying on the desk while the user looks elsewhere, a face the landmarker loses (framing,
 * light) while someone is clearly there, a dim room the luma thumbnail reads as covered,
 * landmarker dropouts on a still user, a book held up in front of the face and a nap with the
 * head on the desk. With the oracle classifier at 2, 3 and 4 fps, then again through the
 * real classifiers.
 */
import { describe, expect, it } from 'vitest';
import { CalibrationRecorder } from '../../src/calibration/recorder';
import { buildProfile } from '../../src/calibration/profile';
import { createGenericClassifier } from '../../src/classifier/generic';
import { createPersonalClassifier } from '../../src/classifier/personal';
import { CALIBRATION_CLASSES } from '../../src/types';
import type { AttentionClassifier, CalibrationClass, SituationRecording } from '../../src/types';
import { mulberry32 } from '../../src/util/rng';
import { implemented } from '../helpers/implemented';
import {
  PERSONAS,
  calibrationFrames,
  synthesize,
  type Activity,
  type Persona,
  type SynthTick,
} from '../synth';
import { cameraEngine, oracleClassifier, type Recorder } from './harness';

const MIN = 60_000;
const FPS = [2, 3, 4] as const;
const SEEDS = [1, 2, 3] as const;
const HEAVY_MS = 240_000;

interface Classifiers {
  classifier: AttentionClassifier;
  fallback: AttentionClassifier | null;
}

function runTicks(ticks: readonly SynthTick[], cls: Classifiers): Recorder {
  const { rec } = cameraEngine(cls.classifier, { fallback: cls.fallback });
  for (const t of ticks) {
    rec.tick({ now: t.now, phase: t.phase, context: t.context, camera: t.camera, frame: t.frame });
  }
  return rec;
}

/** A textbook lying at the front of the desk, seen by the detector in 3 runs out of 4. */
function bookOnDesk(ticks: SynthTick[]): SynthTick[] {
  const seen = new Map<number, boolean>();
  return ticks.map((t) => {
    const objects = t.frame?.objects;
    if (!t.frame || !objects) return t;
    if (!seen.has(objects.ranAt)) seen.set(objects.ranAt, seen.size % 4 !== 3);
    const book = seen.get(objects.ranAt)
      ? { score: 0.6, box: { cx: 0.3, cy: 0.9, w: 0.3, h: 0.15 } }
      : null;
    return { ...t, frame: { ...t.frame, objects: { ...objects, book } } };
  });
}

/** From `fromMs` on the landmarker never finds the face (someone is still in view). */
function faceLost(ticks: SynthTick[], fromMs: number, idleMs: number | null = null): SynthTick[] {
  return ticks.map((t) => {
    if (t.now < fromMs || !t.frame) return t;
    return {
      ...t,
      frame: { ...t.frame, face: null, quality: 0.6 },
      context: idleMs === null ? t.context : { ...t.context, idleMs },
    };
  });
}

/** A dim, low-contrast room: the luma thumbnail says «covered» on every sample. */
function dimRoom(ticks: SynthTick[], fromMs: number): SynthTick[] {
  return ticks.map((t) => {
    const luma = t.frame?.luma;
    if (t.now < fromMs || !t.frame || !luma) return t;
    const dark = { ...luma, mean: 0.06, spatialStd: 0.02, covered: true, lowLight: false };
    return { ...t, frame: { ...t.frame, luma: dark } };
  });
}

/** The person detector misses the user and a still user barely moves near the face. */
function noPerson(ticks: SynthTick[]): SynthTick[] {
  return ticks.map((t) => {
    if (!t.frame) return t;
    const { objects, luma } = t.frame;
    return {
      ...t,
      frame: {
        ...t.frame,
        objects: objects ? { ...objects, person: null } : objects,
        luma: luma ? { ...luma, motionNearFace: 0.008 } : luma,
      },
    };
  });
}

/** From `fromMs` on: a textbook held up in front of the face (face hidden, book on every run). */
function raisedBook(ticks: SynthTick[], fromMs: number): SynthTick[] {
  const box = { cx: 0.5, cy: 0.45, w: 0.4, h: 0.35 };
  return ticks.map((t) => {
    if (t.now < fromMs || !t.frame) return t;
    const objects = t.frame.objects;
    return {
      ...t,
      frame: {
        ...t.frame,
        face: null,
        quality: 0.6,
        objects: objects ? { ...objects, book: { score: 0.85, box } } : objects,
      },
      context: { ...t.context, idleMs: t.now - fromMs },
    };
  });
}

/** From `fromMs` on: asleep with the head on the desk (face lost, body in view, no motion). */
function nap(ticks: SynthTick[], fromMs: number): SynthTick[] {
  return ticks.map((t) => {
    if (t.now < fromMs || !t.frame) return t;
    const luma = t.frame.luma;
    return {
      ...t,
      frame: {
        ...t.frame,
        face: null,
        quality: 0.6,
        luma: luma ? { ...luma, motionNearFace: 0.003 } : luma,
      },
      context: { ...t.context, idleMs: t.now - fromMs },
    };
  });
}

const LOW_LIGHT_03: Persona = { ...PERSONAS.lowLight, faceDrop: 0.3 };

/** 25 min in a dim room: typing (low-light persona missing 30 % of faces) or a notebook. */
function dimRoomStudy(kind: 'typing' | 'notebook', fps: number, seed: number, person = true) {
  const persona = kind === 'typing' ? LOW_LIGHT_03 : PERSONAS.baseline;
  const script: [Activity, number][] =
    kind === 'typing'
      ? [['typing', 25 * MIN]]
      : [
          ['typing', 30_000],
          ['notebook', 25 * MIN],
        ];
  const ticks = dimRoom(synthesize(script, { persona, fps, seed }), 0);
  return { persona, ticks: person ? ticks : noPerson(ticks) };
}

function checkNoStrike(rec: Recorder, label: string): void {
  expect(rec.strikes(), label).toEqual([]);
  expect(rec.warnings(), label).toEqual([]);
  const totals = rec.engine.totals();
  expect(totals.focusedMs / totals.workMs, label).toBeGreaterThanOrEqual(0.9);
}

function napScenario(cls: (p: Persona) => Classifiers, seed: number) {
  const persona = PERSONAS.baseline;
  const napAt = 90_000;
  const ticks = nap(
    synthesize(
      [
        ['typing', MIN],
        ['notebook', 30_000],
        ['notebook', 25 * MIN],
      ],
      { persona, seed },
    ),
    napAt,
  );
  const { rec } = cameraEngine(cls(persona).classifier, { fallback: cls(persona).fallback });
  let focusedAtNap = 0;
  for (const t of ticks) {
    rec.tick({ now: t.now, phase: t.phase, context: t.context, camera: t.camera, frame: t.frame });
    if (t.now < napAt) focusedAtNap = rec.engine.totals().focusedMs;
  }
  return { rec, napAt, focusedAtNap };
}

function checkNap(run: ReturnType<typeof napScenario>, label: string): void {
  const { rec, napAt, focusedAtNap } = run;
  const [suggest] = rec.of('suggest_break');
  expect(suggest?.reason, label).toBe('eyes_closed');
  // 90 s without a sign of life, then ~16 s of «closed» frames.
  expect((suggest?.at as number) - napAt, label).toBeLessThanOrEqual(120_000);
  // Asleep time earns no focus: at most the 90 s before it is known.
  expect(rec.engine.totals().focusedMs - focusedAtNap, label).toBeLessThanOrEqual(110_000);
  // Never a strike while asleep; only the absence path after 20 min of hidden time.
  const first = rec.strikes()[0];
  expect(first?.cause, label).toBe('no_face');
  expect((first?.at as number) - napAt, label).toBeGreaterThanOrEqual(20 * MIN + 60_000);
  expect(rec.warnings('doubt'), label).toEqual([]);
}

const oracle = (persona: Persona): Classifiers => ({
  classifier: oracleClassifier({ persona }),
  fallback: null,
});

function hintAt(rec: Recorder, code: string): number | null {
  return rec.of('hint').find((h) => h.code === code && h.active)?.at ?? null;
}

// ---------------------------------------------------------------------------------------

function lookAwayWithBook(cls: (p: Persona) => Classifiers, fps: number, seed: number) {
  const persona = PERSONAS.baseline;
  const ticks = bookOnDesk(
    synthesize(
      [
        ['typing', MIN],
        ['lookAway', 2 * MIN],
      ],
      { persona, fps, seed },
    ),
  );
  return runTicks(ticks, cls(persona));
}

function slidOutOfFrame(cls: (p: Persona) => Classifiers, fps: number, seed: number) {
  const persona = PERSONAS.baseline;
  // Reading the screen, then leaning back: the face leaves the frame, the body does not.
  const ticks = faceLost(
    synthesize(
      [
        ['screen', 2 * MIN],
        ['screen', 3 * MIN],
      ],
      { persona, fps, seed },
    ),
    2 * MIN,
    30_000,
  );
  return runTicks(ticks, cls(persona));
}

function checkLookAwayWithBook(rec: Recorder, label: string): void {
  const doubt = (rec.warnings('doubt')[0] as number) - MIN;
  const strike = rec.strikes()[0];
  expect(doubt, label).toBeGreaterThanOrEqual(15_000);
  expect(doubt, label).toBeLessThanOrEqual(35_000);
  expect(strike?.cause, label).toBe('doubt_timeout');
  expect((strike?.at as number) - MIN, label).toBeGreaterThanOrEqual(45_000);
  expect((strike?.at as number) - MIN, label).toBeLessThanOrEqual(65_000);
}

function checkSlidOut(rec: Recorder, label: string): void {
  const lostAt = 2 * MIN;
  const hint = hintAt(rec, 'camera_cant_see_you');
  const warning = rec.warnings('absent')[0];
  const strike = rec.strikes()[0];
  // Told at once (5 s + the 5 s hint debounce), before any warning.
  expect((hint as number) - lostAt, label).toBeLessThanOrEqual(11_000);
  // Not «¿Sigues ahí?»: framing is not attention. «No te veo» at half, no_face at full.
  expect(rec.warnings('doubt'), label).toEqual([]);
  expect((warning as number) - lostAt, label).toBeGreaterThanOrEqual(45_000);
  expect((warning as number) - lostAt, label).toBeLessThanOrEqual(55_000);
  expect(strike?.cause, label).toBe('no_face');
  expect((strike?.at as number) - (warning as number), label).toBeGreaterThanOrEqual(29_000);
  expect((strike?.at as number) - (warning as number), label).toBeLessThanOrEqual(31_000);
  expect(rec.strikes(), label).toHaveLength(1); // 3 min: the next one would come at +200 s
}

describe('oracle classifier', { timeout: HEAVY_MS }, () => {
  it.each(FPS)(
    'looking away with a textbook on the desk: DUDA, then doubt_timeout (%i fps)',
    (fps) => {
      for (const seed of SEEDS) {
        checkLookAwayWithBook(lookAwayWithBook(oracle, fps, seed), `seed ${seed}`);
      }
    },
  );

  it('a textbook on the desk still never punishes reading it', () => {
    for (const fps of FPS) {
      const persona = PERSONAS.baseline;
      const ticks = bookOnDesk(
        synthesize(
          [
            ['typing', 30_000],
            ['readBook', 20 * MIN],
          ],
          { persona, fps, seed: 4 },
        ),
      );
      const rec = runTicks(ticks, oracle(persona));
      expect(rec.strikes(), `${fps} fps`).toEqual([]);
      expect(rec.warnings().length, `${fps} fps`).toBeLessThanOrEqual(1);
    }
  });

  it.each(FPS)(
    'face slides out of the frame: hint at once, «No te veo», no_face (%i fps)',
    (fps) => {
      for (const seed of SEEDS) checkSlidOut(slidOutOfFrame(oracle, fps, seed), `seed ${seed}`);
    },
  );

  it('the same during a Pomodoro break: nothing', () => {
    const persona = PERSONAS.baseline;
    const ticks = faceLost(
      synthesize(
        [['screen', MIN], { activity: 'screen', ms: 5 * MIN, phase: 'break' }, ['screen', 20_000]],
        { persona, seed: 5 },
      ),
      MIN,
    );
    const rec = runTicks(ticks, oracle(persona));
    expect(rec.strikes()).toEqual([]);
    expect(rec.warnings()).toEqual([]);
  });

  it('low light, face never found, someone typing: judged like no-camera, no strike', () => {
    for (const fps of FPS) {
      const persona = PERSONAS.lowLight;
      const ticks = faceLost(
        synthesize(
          [
            ['typing', MIN],
            ['typing', 5 * MIN],
          ],
          { persona, fps, seed: 6 },
        ),
        MIN,
      );
      const rec = runTicks(ticks, oracle(persona));
      expect(rec.strikes(), `${fps} fps`).toEqual([]);
      expect(rec.warnings(), `${fps} fps`).toEqual([]);
      expect(hintAt(rec, 'low_light'), `${fps} fps`).not.toBeNull();
    }
  });

  it('low light does not hide a distraction app or a long idle stretch', () => {
    const persona = PERSONAS.lowLight;
    const dist = faceLost(
      synthesize(
        [['typing', MIN], { activity: 'typing', ms: 3 * MIN, foreground: 'distraction' }],
        { persona, seed: 7 },
      ),
      MIN,
    );
    expect(runTicks(dist, oracle(persona)).strikes()[0]?.cause).toBe('distraction_app');
    const idle = faceLost(
      synthesize(
        [
          ['typing', MIN],
          ['screen', 12 * MIN],
        ],
        { persona, seed: 8 },
      ),
      MIN,
    ).map((t) => (t.now >= MIN ? { ...t, context: { ...t.context, idleMs: t.now - MIN } } : t));
    const rec = runTicks(idle, oracle(persona));
    // Idle past noCameraIdleMs (8 min): not observable → the absence path.
    expect(rec.strikes()[0]?.cause).toBe('no_face');
    expect(rec.strikes()[0]?.at as number).toBeGreaterThan(MIN + 8 * MIN);
  });

  it('a dim room the luma reads as covered: a tracked face is still there (no strike)', () => {
    for (const fps of FPS) {
      const persona = PERSONAS.baseline;
      const ticks = dimRoom(
        synthesize(
          [
            ['typing', MIN],
            ['typing', 3 * MIN],
          ],
          { persona, fps, seed: 9 },
        ),
        MIN,
      );
      const rec = runTicks(ticks, oracle(persona));
      expect(rec.strikes(), `${fps} fps`).toEqual([]);
      expect(rec.warnings(), `${fps} fps`).toEqual([]);
    }
  });

  it.each(['typing', 'notebook'] as const)(
    '25 min in a dim room read as covered, %s with landmarker dropouts: no strike',
    (kind) => {
      for (const fps of FPS) {
        for (const seed of SEEDS) {
          const { persona, ticks } = dimRoomStudy(kind, fps, seed);
          checkNoStrike(runTicks(ticks, oracle(persona)), `${fps} fps seed ${seed}`);
        }
      }
    },
  );

  it.each(['typing', 'notebook'] as const)(
    'the same when the person detector misses a still user too (%s)',
    (kind) => {
      for (const fps of FPS) {
        for (const seed of SEEDS) {
          const { persona, ticks } = dimRoomStudy(kind, fps, seed, false);
          const rec = runTicks(ticks, oracle(persona));
          expect(rec.strikes(), `${fps} fps seed ${seed}`).toEqual([]);
          expect(rec.warnings().length, `${fps} fps seed ${seed}`).toBeLessThanOrEqual(1);
        }
      }
    },
  );

  it('normal light, 25 % of faces missed, no person detected, still user: no strike', () => {
    for (const fps of FPS) {
      for (const seed of SEEDS) {
        const persona: Persona = { ...PERSONAS.baseline, faceDrop: 0.25 };
        const ticks = noPerson(synthesize([['typing', 25 * MIN]], { persona, fps, seed }));
        checkNoStrike(runTicks(ticks, oracle(persona)), `${fps} fps seed ${seed}`);
      }
    }
  });

  it('a textbook held up in front of the face: no «No te veo», no strike', () => {
    for (const fps of FPS) {
      for (const seed of SEEDS) {
        const persona = PERSONAS.baseline;
        const ticks = raisedBook(
          synthesize(
            [
              ['screen', MIN],
              ['screen', 10 * MIN],
            ],
            { persona, fps, seed },
          ),
          MIN,
        );
        checkNoStrike(runTicks(ticks, oracle(persona)), `${fps} fps seed ${seed}`);
      }
    }
  });

  it('asleep with the head on the desk: a break suggestion and no focus, not a strike', () => {
    for (const seed of SEEDS) checkNap(napScenario(oracle, seed), `seed ${seed}`);
  });

  it('covering the lens is still «not there», whatever the dim-room rule', () => {
    const rng = mulberry32(3);
    for (const fps of FPS) {
      const ticks = synthesize(
        [
          ['screen', MIN],
          ['covered', 70_000],
        ],
        { fps, seed: 1 + Math.floor(rng() * 10) },
      );
      const rec = runTicks(ticks, oracle(PERSONAS.baseline));
      expect(rec.strikes()[0]?.cause, `${fps} fps`).toBe('no_face');
    }
  });
});

// ---------------------------------------------------------------------------------------
// The same through LEARNING's classifiers
// ---------------------------------------------------------------------------------------

const CAMERA = Object.freeze({ key: `sha256:${'c'.repeat(64)}`, aspect: 4 / 3 });

function personalFor(persona: Persona): Classifiers {
  const recordings: Partial<Record<CalibrationClass, SituationRecording>> = {};
  CALIBRATION_CLASSES.forEach((cls, i) => {
    const frames = calibrationFrames(cls, { persona, seed: 60 + i });
    const start = frames[0]?.t ?? 0;
    const recorder = new CalibrationRecorder(cls, start);
    for (const f of frames) recorder.push(f);
    recordings[cls] = recorder.finish(start + 20_000);
  });
  const result = buildProfile({
    recordings,
    previous: null,
    camera: CAMERA,
    nowIso: '2026-09-28T10:00:00.000Z',
  });
  if (!result.ok) throw new Error(`calibration failed: ${JSON.stringify(result.issues)}`);
  return {
    classifier: createPersonalClassifier(result.profile),
    fallback: createGenericClassifier(),
  };
}

const generic = (): Classifiers => ({ classifier: createGenericClassifier(), fallback: null });

const ready =
  implemented(() => createGenericClassifier()) && implemented(() => personalFor(PERSONAS.baseline));

describe.runIf(ready)('real classifiers', { timeout: HEAVY_MS }, () => {
  const kinds: [string, (p: Persona) => Classifiers][] = [
    ['generic', generic],
    ['personal', personalFor],
  ];

  it.each(kinds)('%s: looking away with a textbook on the desk strikes', (_name, cls) => {
    for (const seed of SEEDS) checkLookAwayWithBook(lookAwayWithBook(cls, 3, seed), `seed ${seed}`);
  });

  it.each(kinds)('%s: face slides out of the frame → no_face, not doubt_timeout', (_name, cls) => {
    for (const seed of SEEDS) checkSlidOut(slidOutOfFrame(cls, 3, seed), `seed ${seed}`);
  });

  it.each(kinds)('%s: 25 min in a dim room with landmarker dropouts never strike', (_name, cls) => {
    for (const kind of ['typing', 'notebook'] as const) {
      const { persona, ticks } = dimRoomStudy(kind, 3, 1);
      checkNoStrike(runTicks(ticks, cls(persona)), kind);
    }
  });

  it.each(kinds)('%s: a textbook held up in front of the face never strikes', (_name, cls) => {
    const persona = PERSONAS.baseline;
    const ticks = raisedBook(
      synthesize(
        [
          ['screen', MIN],
          ['screen', 10 * MIN],
        ],
        { persona, seed: 2 },
      ),
      MIN,
    );
    checkNoStrike(runTicks(ticks, cls(persona)), 'raised book');
  });

  it.each(kinds)('%s: a nap on the desk suggests a break and earns no focus', (_name, cls) => {
    checkNap(napScenario(cls, 1), 'nap');
  });

  it.each(kinds)('%s: a dim room with a tracked face never strikes', (_name, cls) => {
    const persona = PERSONAS.lowLight;
    const ticks = dimRoom(
      synthesize(
        [
          ['typing', MIN],
          ['typing', 3 * MIN],
        ],
        { persona, seed: 3 },
      ),
      MIN,
    );
    expect(runTicks(ticks, cls(persona)).strikes()).toEqual([]);
  });
});
