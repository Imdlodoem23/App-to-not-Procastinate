/**
 * The personal classifier through DECISION's real observer and engine: calibrated looking at
 * one spot of the screen (the wizard's own preview), then reading one side of that same
 * screen with the eyes (a PDF on one half, notes in a side window, a lecture in a side panel)
 * without touching the keyboard or mouse. No fallback classifier, so the stale-profile check
 * cannot hide what the profile itself says.
 */
import { describe, expect, it } from 'vitest';
import { buildProfile } from '../../src/calibration/profile';
import { createPersonalClassifier } from '../../src/classifier/personal';
import type { CalibrationProfile, FaceFeatures } from '../../src/types';
import { PERSONAS, synthesize, type Persona, type Script, type SynthTick } from '../synth';
import { cameraEngine } from '../state/harness';
import { CAMERA, NOW, recordAll } from '../calibration/fixtures';

const MIN = 60_000;
const TYPING_MS = 30_000;

function profileOf(persona: Persona, seed: number): CalibrationProfile {
  const result = buildProfile({
    recordings: recordAll(persona, seed),
    previous: null,
    camera: CAMERA,
    nowIso: NOW,
  });
  if (!result.ok) throw new Error(`calibration failed: ${JSON.stringify(result.issues)}`);
  return result.profile;
}

/** 30 s of typing, then `activity` with `change` applied to the face and no input at all. */
function session(
  persona: Persona,
  activity: 'screen' | 'lookAway',
  ms: number,
  change: (face: FaceFeatures) => FaceFeatures = (f) => f,
): SynthTick[] {
  const script: Script = [
    ['typing', TYPING_MS],
    [activity, ms],
  ];
  return synthesize(script, { persona, seed: 7 }).map((tick) => {
    if (tick.now < TYPING_MS) return tick;
    const face = tick.frame?.face;
    const frame = tick.frame && face ? { ...tick.frame, face: change(face) } : tick.frame;
    return { ...tick, frame, context: { ...tick.context, idleMs: tick.now - TYPING_MS } };
  });
}

const eyes =
  (gazeX: number, yaw = 0) =>
  (f: FaceFeatures): FaceFeatures => ({
    ...f,
    gazeX: Math.max(-1, Math.min(1, f.gazeX + gazeX)),
    pose: { ...f.pose, yaw: f.pose.yaw + yaw },
  });

const CASES: readonly (readonly [string, Persona, number])[] = [
  ['baseline, seed 40', PERSONAS.baseline, 40],
  ['baseline, seed 60', PERSONAS.baseline, 60],
  // Very steady eyes: the screen clip's gaze spread is tiny (sd 0.02).
  ['steady eyes, seed 40', { ...PERSONAS.baseline, eyeSd: 0.02 }, 40],
];

describe('personal classifier, real observer and engine', { timeout: 120_000 }, () => {
  it.each(CASES)(
    '%s: reading one side of the calibrated screen with the eyes never strikes',
    (_label, persona, seed) => {
      const profile = profileOf(persona, seed);
      for (const [name, change] of [
        ['gazeX +0.2', eyes(0.2)],
        ['gazeX −0.2', eyes(-0.2)],
        ['gazeX +0.3', eyes(0.3)],
        ['yaw +12°, gazeX +0.2', eyes(0.2, 12)],
        ['yaw −12°, gazeX −0.2', eyes(-0.2, -12)],
      ] as const) {
        const { rec, engine } = cameraEngine(createPersonalClassifier(profile));
        rec.synth(session(persona, 'screen', 6 * MIN, change));
        const totals = engine.totals();
        expect(rec.strikes(), name).toEqual([]);
        expect(rec.warnings(), name).toEqual([]);
        expect(totals.focusedMs / totals.workMs, name).toBeGreaterThanOrEqual(0.95);
      }
    },
  );

  it.each(CASES)('%s: looking away still strikes', (_label, persona, seed) => {
    const profile = profileOf(persona, seed);
    const { rec } = cameraEngine(createPersonalClassifier(profile));
    rec.synth(session(persona, 'lookAway', 2 * MIN));
    const strikes = rec.strikes();
    expect(strikes[0]?.cause).toBe('doubt_timeout');
    expect((strikes[0]?.at ?? Infinity) - TYPING_MS).toBeLessThanOrEqual(65_000);
  });
});
