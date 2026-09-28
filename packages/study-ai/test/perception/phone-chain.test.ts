/**
 * A phone that is not in use, end to end: synthetic detector boxes (with edge jitter and
 * detector flicker) → the real `PhoneTracker` → LEARNING's classifiers → DECISION's observer
 * and engine. A phone lying on the desk, a timer on a stand or a calculator must never cost a
 * strike; picking the phone up still must.
 *
 * Before the anchor-based tracker, 1 px of jitter on a 32×19 px desk box reset `stillMs` on
 * almost every run and `nearFace` covered most of the frame: 10–11 `phone` strikes in 20 min.
 */
import { describe, expect, it } from 'vitest';
import { createGenericClassifier } from '../../src/classifier/generic';
import { createPersonalClassifier } from '../../src/classifier/personal';
import type { AttentionClassifier } from '../../src/types';
import { profileFor } from '../calibration/fixtures';
import { implemented } from '../helpers/implemented';
import { cameraEngine, type Recorder } from '../state/harness';
import { PERSONAS, synthesize, type Persona, type PersonaId, type Script } from '../synth';

const MIN = 60_000;
const HEAVY_MS = 300_000;
const JITTER_PX = [0, 1, 1.5, 2] as const;

type Kind = 'generic' | 'personal';

const ready =
  implemented(() => createGenericClassifier()) && implemented(() => profileFor('baseline'));

function classifiers(kind: Kind, id: PersonaId) {
  const classifier: AttentionClassifier =
    kind === 'generic' ? createGenericClassifier() : createPersonalClassifier(profileFor(id));
  return { classifier, fallback: kind === 'personal' ? createGenericClassifier() : null };
}

function play(
  script: Script,
  kind: Kind,
  persona: Persona,
  phoneJitterPx: number,
  seed = 21,
): { rec: Recorder; focus: number } {
  const { classifier, fallback } = classifiers(kind, persona.id);
  const { rec, engine } = cameraEngine(classifier, { fallback });
  for (const t of synthesize(script, { persona, seed, phoneJitterPx })) {
    rec.tick({ now: t.now, phase: t.phase, context: t.context, camera: t.camera, frame: t.frame });
  }
  const totals = engine.totals();
  return { rec, focus: totals.workMs > 0 ? totals.focusedMs / totals.workMs : 0 };
}

function expectStudy(run: { rec: Recorder; focus: number }, label: string): void {
  expect(run.rec.strikes(), label).toEqual([]);
  expect(run.rec.warnings().length, label).toBeLessThanOrEqual(1);
  expect(run.focus, label).toBeGreaterThanOrEqual(0.9);
}

describe.runIf(ready)('a phone that is not in use never strikes', { timeout: HEAVY_MS }, () => {
  describe.each<Kind>(['generic', 'personal'])('%s classifier', (kind) => {
    it('a phone lying on the desk for 20 min (0–2 px of jitter, half the runs missed)', () => {
      for (const px of JITTER_PX) {
        const run = play(
          [
            ['typing', 30_000],
            ['phoneOnDesk', 20 * MIN],
          ],
          kind,
          PERSONAS.baseline,
          px,
        );
        expectStudy(run, `${px} px`);
      }
    });

    it('a phone upright on a stand in front of the chest, score 0.7–0.9, for 20 min', () => {
      for (const px of JITTER_PX) {
        expectStudy(play([['phoneOnStand', 20 * MIN]], kind, PERSONAS.baseline, px), `${px} px`);
      }
    });

    it('a calculator in view while working on screen and on paper (20 min)', () => {
      const script: Script = [
        ['screen', 10 * MIN],
        ['notebook', 10 * MIN],
      ];
      for (const px of [1, 2]) {
        expectStudy(play(script, kind, PERSONAS.calculator, px), `${px} px`);
      }
    });

    it('picking the phone up from its stand still strikes with cause phone in 45–65 s', () => {
      for (const px of [0, 1.5]) {
        const script: Script = [
          ['phoneOnStand', 2 * MIN],
          ['phoneInHand', 2 * MIN],
        ];
        const { rec } = play(script, kind, PERSONAS.baseline, px);
        const strike = rec.strikes()[0];
        expect(strike?.cause, `${px} px`).toBe('phone');
        const after = (strike?.at ?? 0) - 2 * MIN;
        expect(after, `${px} px`).toBeGreaterThanOrEqual(45_000);
        expect(after, `${px} px`).toBeLessThanOrEqual(65_000);
      }
    });
  });
});
