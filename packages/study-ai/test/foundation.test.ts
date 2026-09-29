/** Tests of the lead-owned foundation: settings, assets, utilities and the synth generator. */
import { STUDY_RULES } from '@centrate/shared/points';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_ASSETS,
  CALIBRATION_CLASSES,
  DEFAULT_STUDY_AI_SETTINGS,
  FEATURE_ROW_COLUMNS,
  MODEL_MANIFEST,
  STUDY_AI_CONSTANTS,
  isAllowedAssetUrl,
  resolveStudyAiSettings,
} from '../src/index';
import { median, quantile, quantize } from '../src/util/math';
import { gaussian, mulberry32 } from '../src/util/rng';
import { ACTIVITIES, PERSONAS, calibrationFrames, synthesize } from './synth';

describe('resolveStudyAiSettings', () => {
  it('uses the brief defaults', () => {
    expect(DEFAULT_STUDY_AI_SETTINGS).toEqual({
      doubtAfterMs: 15_000,
      strikeAfterDoubtMs: 30_000,
      noFaceStrikeMs: 60_000,
      focusScoreThreshold: 50,
      focusWindowMs: 15_000,
      noCameraIdleMs: 480_000,
    });
  });

  it('clamps out-of-range and non-finite values (settings cannot turn strikes off)', () => {
    const s = resolveStudyAiSettings({
      doubtAfterMs: 1,
      strikeAfterDoubtMs: Number.POSITIVE_INFINITY,
      noFaceStrikeMs: 10_000_000,
      focusScoreThreshold: 99,
      focusWindowMs: 5_000,
      noCameraIdleMs: Number.NaN,
    });
    expect(s.doubtAfterMs).toBe(STUDY_RULES.doubtAfterMs.min);
    expect(s.strikeAfterDoubtMs).toBe(STUDY_RULES.strikeAfterDoubtMs.default);
    expect(s.noFaceStrikeMs).toBe(STUDY_RULES.noFaceStrikeMs.max);
    expect(s.focusScoreThreshold).toBe(80);
    expect(s.focusWindowMs).toBe(10_000);
    expect(s.noCameraIdleMs).toBe(480_000);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('keeps the grace equal to the guardian cooldown', () => {
    expect(STUDY_AI_CONSTANTS.strikeGraceMs).toBe(STUDY_RULES.strikeCooldownMs);
  });
});

describe('assets', () => {
  it('lists the two pinned models', () => {
    expect(MODEL_MANIFEST.map((m) => m.file)).toEqual([
      'face_landmarker.task',
      'efficientdet_lite0_int8.tflite',
    ]);
    for (const m of MODEL_MANIFEST) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts only local asset URLs', () => {
    expect(isAllowedAssetUrl(ANALYSIS_ASSETS.wasmBaseUrl)).toBe(true);
    expect(isAllowedAssetUrl('centrate-ai://assets/models/face_landmarker.task')).toBe(true);
    expect(isAllowedAssetUrl('http://127.0.0.1:5173/models/x.task')).toBe(true);
    expect(isAllowedAssetUrl('http://localhost:5173/wasm')).toBe(true);
    expect(isAllowedAssetUrl('centrate-ai://other/x')).toBe(false);
    expect(isAllowedAssetUrl('https://storage.googleapis.com/mediapipe-models/x')).toBe(false);
    expect(isAllowedAssetUrl('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm')).toBe(
      false,
    );
    expect(isAllowedAssetUrl('http://user:pw@localhost/x')).toBe(false);
    expect(isAllowedAssetUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedAssetUrl('not a url')).toBe(false);
  });
});

describe('vocabularies', () => {
  it('keeps the calibration order and the row schema', () => {
    expect(CALIBRATION_CLASSES).toEqual(['screen', 'paper', 'phone', 'away', 'absent']);
    expect(FEATURE_ROW_COLUMNS).toHaveLength(22);
    expect(new Set(FEATURE_ROW_COLUMNS).size).toBe(22);
  });
});

describe('util', () => {
  it('computes quantiles and quantises exactly', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    const q = quantize(0.1 + 0.2, 0.001);
    expect(q).toBe(0.3);
    expect(JSON.parse(JSON.stringify(q))).toBe(q);
    expect(quantize(-12.345, 0.1)).toBe(-12.3);
  });

  it('seeded randomness is deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i += 1) expect(a()).toBe(b());
    const g = mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 2_000; i += 1) sum += gaussian(g);
    expect(Math.abs(sum / 2_000)).toBeLessThan(0.1);
  });
});

describe('synth generator', () => {
  it('is deterministic per seed and covers every activity', () => {
    const script = ACTIVITIES.map((a) => [a, 5_000] as const);
    const a = synthesize(script, { seed: 3 });
    const b = synthesize(script, { seed: 3 });
    expect(a).toEqual(b);
    expect(new Set(a.map((t) => t.activity))).toEqual(new Set(ACTIVITIES));
  });

  it('produces the expected rates and shapes', () => {
    const ticks = synthesize([['screen', 60_000]], { fps: 3, seed: 1 });
    expect(ticks.length).toBeGreaterThan(170);
    expect(ticks.length).toBeLessThan(190);
    const fresh = ticks.filter((t) => t.frame?.objects?.fresh).length;
    expect(fresh).toBeGreaterThan(55);
    expect(fresh).toBeLessThan(65);
    for (const t of ticks) {
      expect(t.frame?.face).not.toBeNull();
      expect(t.frame?.width).toBe(320);
    }
  });

  it('models absence, covering and writing', () => {
    const absent = synthesize([['absent', 10_000]], { seed: 2 });
    expect(absent.every((t) => t.frame?.face === null)).toBe(true);
    const covered = synthesize([['covered', 10_000]], { seed: 2 });
    expect(covered.some((t) => t.frame?.luma?.covered)).toBe(true);
    expect(covered.every((t) => (t.context.idleMs ?? 0) < 5_000)).toBe(true);
    const notebook = synthesize([['notebook', 30_000]], { seed: 2 });
    const pitches = notebook.flatMap((t) => (t.frame?.face ? [t.frame.face.pose.pitch] : []));
    expect(median(pitches)).toBeLessThan(-30);
    expect(notebook.at(-1)?.context.idleMs).toBeGreaterThan(20_000);
  });

  it('builds calibration clips for every class and persona', () => {
    for (const persona of Object.values(PERSONAS)) {
      for (const cls of CALIBRATION_CLASSES) {
        const frames = calibrationFrames(cls, { persona, seed: 9 });
        expect(frames.length).toBeGreaterThan(75);
      }
    }
  });
});
