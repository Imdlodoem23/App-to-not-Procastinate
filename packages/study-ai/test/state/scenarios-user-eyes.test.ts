/**
 * Engine scenarios for the user's own eyes and a face out of view (DESIGN.md §7.2–7.4, §7.6):
 *
 * - «eyes down» judged against the user's screen gaze: a laptop placed low (or progressive
 *   lenses) and a hunt-and-peck typist must not turn a distraction app into study time;
 * - glasses glare that appears after calibration must not hide a phone or a distraction, nor
 *   make a typing user «drowsy»;
 * - writing or reading with the face out of the camera's view is studying for as long as the
 *   user shows signs of life.
 *
 * With the oracle classifier, then again through LEARNING's generic and personal classifiers.
 */
import { describe, expect, it } from 'vitest';
import { CalibrationRecorder } from '../../src/calibration/recorder';
import { buildProfile } from '../../src/calibration/profile';
import { createGenericClassifier } from '../../src/classifier/generic';
import { createPersonalClassifier } from '../../src/classifier/personal';
import { CALIBRATION_CLASSES } from '../../src/types';
import type {
  AttentionClassifier,
  CalibrationClass,
  CalibrationProfile,
  SituationRecording,
} from '../../src/types';
import { implemented } from '../helpers/implemented';
import {
  GLARE_PERSONA,
  LOW_SCREEN_PERSONA,
  PERSONAS,
  calibrationFrames,
  synthesize,
  type Persona,
  type Script,
  type SynthTick,
} from '../synth';
import { cameraEngine, oracleClassifier, type Recorder } from './harness';
import { STUDY_SCRIPTS, focusShare } from './scenarios';

const MIN = 60_000;
const HEAVY_MS = 300_000;
const CAMERA = Object.freeze({ key: `sha256:${'c'.repeat(64)}`, aspect: 4 / 3 });

interface Classifiers {
  classifier: AttentionClassifier;
  fallback: AttentionClassifier | null;
}

type Kind = 'oracle' | 'generic' | 'personal';

const profiles = new Map<string, CalibrationProfile>();

/** A profile calibrated on the persona's five situations (cached per persona variant). */
function profileFor(persona: Persona): CalibrationProfile {
  const key = persona.label ?? persona.id;
  const hit = profiles.get(key);
  if (hit) return hit;
  const recordings: Partial<Record<CalibrationClass, SituationRecording>> = {};
  CALIBRATION_CLASSES.forEach((cls, i) => {
    const frames = calibrationFrames(cls, { persona, seed: 80 + i });
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
  profiles.set(key, result.profile);
  return result.profile;
}

/** Classifiers of `kind`; the personal profile is calibrated on `calibratedOn`. */
function classifiers(kind: Kind, calibratedOn: Persona): Classifiers {
  switch (kind) {
    case 'oracle':
      return { classifier: oracleClassifier({ persona: calibratedOn }), fallback: null };
    case 'generic':
      return { classifier: createGenericClassifier(), fallback: null };
    case 'personal':
      return {
        classifier: createPersonalClassifier(profileFor(calibratedOn)),
        fallback: createGenericClassifier(),
      };
  }
}

function runTicks(ticks: readonly SynthTick[], cls: Classifiers): Recorder {
  const { rec } = cameraEngine(cls.classifier, { fallback: cls.fallback });
  for (const t of ticks) {
    rec.tick({ now: t.now, phase: t.phase, context: t.context, camera: t.camera, frame: t.frame });
  }
  return rec;
}

function run(script: Script, persona: Persona, cls: Classifiers, seed = 1, fps = 3): Recorder {
  return runTicks(synthesize(script, { persona, seed, fps }), cls);
}

function causes(rec: Recorder): string[] {
  return rec.strikes().map((s) => s.cause);
}

function checkStudy(rec: Recorder, label: string): void {
  expect(rec.strikes(), label).toEqual([]);
  expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
  expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
}

/**
 * From `fromMs` on the landmarker never finds the face while the person detector still sees
 * the user and the head moves where the face was (`motion`).
 */
function faceHidden(ticks: SynthTick[], fromMs: number, motion: number): SynthTick[] {
  return ticks.map((t) => {
    if (t.now < fromMs || !t.frame) return t;
    const luma = t.frame.luma;
    return {
      ...t,
      frame: {
        ...t.frame,
        face: null,
        quality: 0.6,
        luma: luma ? { ...luma, motionNearFace: motion } : luma,
      },
    };
  });
}

const STUDY_ON_LOW_SCREEN = [
  'screen',
  'notebook',
  'readBook',
  'sideNotebook',
  'sideBook',
  'typing',
  'secondMonitor',
  'coffeeSip',
  'stretch',
] as const;

// ---------------------------------------------------------------------------------------
// Scenarios, per classifier
// ---------------------------------------------------------------------------------------

function suite(kind: Kind): void {
  const cls = (calibratedOn: Persona = PERSONAS.baseline) => classifiers(kind, calibratedOn);

  describe('eyes down, against the user’s own screen gaze', () => {
    it('eyes at 0.5–0.55 on a low screen: a distraction app still strikes', () => {
      for (const lookDownAdd of [0.4, 0.45]) {
        const persona: Persona = { ...LOW_SCREEN_PERSONA, lookDownAdd };
        for (const seed of [1, 2]) {
          const rec = run(
            [['screen', MIN], { activity: 'screen', ms: 5 * MIN, foreground: 'distraction' }],
            persona,
            cls(LOW_SCREEN_PERSONA),
            seed,
          );
          const label = `+${lookDownAdd} seed ${seed}`;
          expect(causes(rec).length, label).toBeGreaterThanOrEqual(2);
          expect(new Set(causes(rec)), label).toEqual(new Set(['distraction_app']));
          expect(focusShare(rec), label).toBeLessThan(0.5);
        }
      }
    });

    it('eyes at 0.5 on a low screen: studying never strikes', () => {
      for (const name of STUDY_ON_LOW_SCREEN) {
        const rec = run(STUDY_SCRIPTS[name] as Script, LOW_SCREEN_PERSONA, cls(LOW_SCREEN_PERSONA));
        checkStudy(rec, name);
      }
      // Writing notes with the video in front is still studying (looking down).
      const notes = run(
        [['screen', 30_000], { activity: 'notebook', ms: 10 * MIN, foreground: 'distraction' }],
        LOW_SCREEN_PERSONA,
        cls(LOW_SCREEN_PERSONA),
      );
      expect(notes.strikes()).toEqual([]);
      expect(focusShare(notes)).toBeGreaterThanOrEqual(0.9);
    });

    it('hunt-and-peck typing into a chat app strikes (the keys are not paper)', () => {
      for (const seed of [1, 2, 3]) {
        const rec = run(
          [['typing', MIN], { activity: 'huntAndPeck', ms: 10 * MIN, foreground: 'distraction' }],
          PERSONAS.baseline,
          cls(),
          seed,
        );
        expect(causes(rec).length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
        expect(new Set(causes(rec)), `seed ${seed}`).toEqual(new Set(['distraction_app']));
        expect(focusShare(rec), `seed ${seed}`).toBeLessThan(0.3);
      }
    });

    it('hunt-and-peck typing in the notes app never strikes', () => {
      for (const fps of [2, 4]) {
        const rec = run([['huntAndPeck', 20 * MIN]], PERSONAS.baseline, cls(), 4, fps);
        checkStudy(rec, `${fps} fps`);
      }
    });
  });

  describe('glasses glare after calibration', () => {
    it('a phone held at eye level still strikes `phone`', () => {
      for (const seed of [1, 2]) {
        const rec = run(
          [
            ['typing', MIN],
            ['phoneEyeLevel', 5 * MIN],
          ],
          GLARE_PERSONA,
          cls(),
          seed,
        );
        expect(causes(rec)[0], `seed ${seed}`).toBe('phone');
        expect(causes(rec).length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      }
    });

    it('a distraction app in the foreground still strikes `distraction_app`', () => {
      const rec = run(
        [['typing', MIN], { activity: 'screen', ms: 8 * MIN, foreground: 'distraction' }],
        GLARE_PERSONA,
        cls(),
      );
      expect(causes(rec).length).toBeGreaterThanOrEqual(3);
      expect(new Set(causes(rec))).toEqual(new Set(['distraction_app']));
    });

    it('typing or reading the screen is not «drowsy»', () => {
      for (const script of [[['typing', 10 * MIN]], [['screen', 10 * MIN]]] as Script[]) {
        const rec = run(script, GLARE_PERSONA, cls());
        const label = JSON.stringify(script[0]);
        checkStudy(rec, label);
        expect(rec.of('suggest_break'), label).toEqual([]);
      }
    });
  });

  describe('the face out of view while writing or reading', () => {
    it('20 min over a notebook or a book with the face hidden: no strike', () => {
      for (const activity of ['notebook', 'readBook'] as const) {
        for (const seed of [1, 2]) {
          const ticks = faceHidden(
            synthesize(
              [
                ['typing', 30_000],
                [activity, 21 * MIN],
              ],
              { seed },
            ),
            35_000,
            0.012,
          );
          const rec = runTicks(ticks, cls());
          const label = `${activity} seed ${seed}`;
          expect(rec.strikes(), label).toEqual([]);
          expect(rec.warnings(), label).toEqual([]);
          expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
          expect(rec.of('suggest_break'), label).toEqual([]);
          // Told, not punished: the camera cannot see the face.
          expect(
            rec.of('hint').some((h) => h.code === 'camera_cant_see_you' && h.active),
            label,
          ).toBe(true);
        }
      }
    });

    it('a still reader with the book in view is not asleep', () => {
      const ticks = faceHidden(
        synthesize(
          [
            ['typing', 30_000],
            ['readBook', 21 * MIN],
          ],
          { seed: 3 },
        ),
        35_000,
        0.007,
      );
      const rec = runTicks(ticks, cls());
      checkStudy(rec, 'still reader');
      expect(rec.of('suggest_break')).toEqual([]);
    });

    it('leaving after a long hidden stretch strikes `no_face` 60 s later', () => {
      const leaveAt = 30_000 + 15 * MIN;
      const ticks = faceHidden(
        synthesize(
          [
            ['typing', 30_000],
            ['notebook', 15 * MIN],
            ['absent', 70_000],
          ],
          { seed: 5 },
        ),
        35_000,
        0.012,
      ).map((t) =>
        // Nobody there: nothing moves where the face was.
        t.now >= leaveAt && t.frame?.luma
          ? { ...t, frame: { ...t.frame, luma: { ...t.frame.luma, motionNearFace: 0.003 } } }
          : t,
      );
      const rec = runTicks(ticks, cls());
      expect(causes(rec)).toEqual(['no_face']);
      const after = (rec.strikes()[0]?.at as number) - leaveAt;
      // The person detector keeps the last 3 runs (≤ 3 s at 1 Hz), then 60 s of absence.
      expect(after).toBeGreaterThanOrEqual(60_000);
      expect(after).toBeLessThanOrEqual(65_000);
    });
  });
}

describe('oracle classifier', { timeout: HEAVY_MS }, () => {
  suite('oracle');
});

const ready =
  implemented(() => createGenericClassifier()) && implemented(() => profileFor(PERSONAS.baseline));

describe.runIf(ready)('generic classifier', { timeout: HEAVY_MS }, () => {
  suite('generic');
});

describe.runIf(ready)('personal classifier', { timeout: HEAVY_MS }, () => {
  suite('personal');
});
