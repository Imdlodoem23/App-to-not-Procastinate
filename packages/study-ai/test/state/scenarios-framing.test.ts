/**
 * Engine scenarios for what the camera cannot judge well (DESIGN.md §7.1–7.3): a textbook
 * lying on the desk while the user looks elsewhere, a face the landmarker loses (framing,
 * light) while someone is clearly there, and a dim room the luma thumbnail reads as covered.
 * With the oracle classifier at 2, 3 and 4 fps, then again through the real classifiers.
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
import { PERSONAS, calibrationFrames, synthesize, type Persona, type SynthTick } from '../synth';
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
