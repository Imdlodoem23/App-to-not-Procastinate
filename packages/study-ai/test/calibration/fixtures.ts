/**
 * LEARNING test fixtures: calibration recordings and profiles for the synth personas, plus a
 * few hand-made frames. Profiles are cached per test file (a build takes a few hundred ms).
 */
import { CalibrationRecorder } from '../../src/calibration/recorder';
import { buildProfile } from '../../src/calibration/profile';
import { CALIBRATION_CLASSES } from '../../src/types';
import type {
  CalibrationClass,
  CalibrationProfile,
  CameraIdentity,
  FaceFeatures,
  FrameFeatures,
  ObjectFeatures,
  SituationRecording,
} from '../../src/types';
import { gaussian, mulberry32 } from '../../src/util/rng';
import {
  PERSONAS,
  calibrationFrames,
  synthesize,
  type Activity,
  type Persona,
  type PersonaId,
} from '../synth';

export const CAMERA: CameraIdentity = Object.freeze({
  key: `sha256:${'a'.repeat(64)}`,
  aspect: 4 / 3,
});
export const OTHER_CAMERA: CameraIdentity = Object.freeze({
  key: `sha256:${'b'.repeat(64)}`,
  aspect: 4 / 3,
});
export const NOW = '2026-09-28T10:00:00.000Z';
export const LATER = '2026-09-28T11:00:00.000Z';

/** Feeds frames to a recorder the way the calibration loop does, then finishes at 20 s. */
export function record(
  cls: CalibrationClass,
  frames: readonly FrameFeatures[],
): SituationRecording {
  const start = frames[0]?.t ?? 0;
  const recorder = new CalibrationRecorder(cls, start);
  for (const frame of frames) recorder.push(frame);
  return recorder.finish(start + 20_000);
}

/** Frames of one situation. The secondMonitor persona looks at both screens for `screen`. */
export function situationFrames(
  persona: Persona,
  cls: CalibrationClass,
  seed: number,
): FrameFeatures[] {
  if (cls === 'screen' && persona.id === 'secondMonitor') {
    return synthesize(
      [
        ['screen', 10_000],
        ['secondMonitor', 10_000],
      ],
      { persona, seed, fps: 4, objectEveryMs: 500 },
    )
      .map((tick) => tick.frame)
      .filter((frame): frame is FrameFeatures => frame !== null);
  }
  return calibrationFrames(cls, { persona, seed });
}

export function recordAll(
  persona: Persona = PERSONAS.baseline,
  seed = 10,
): Record<CalibrationClass, SituationRecording> {
  const out = {} as Record<CalibrationClass, SituationRecording>;
  CALIBRATION_CLASSES.forEach((cls, i) => {
    out[cls] = record(cls, situationFrames(persona, cls, seed + i));
  });
  return out;
}

const cache = new Map<string, CalibrationProfile>();

/** A calibrated profile for a persona (cached). */
export function profileFor(id: PersonaId = 'baseline', seed = 10): CalibrationProfile {
  const key = `${id}:${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = buildProfile({
    recordings: recordAll(PERSONAS[id], seed),
    previous: null,
    camera: CAMERA,
    nowIso: NOW,
  });
  if (!result.ok) throw new Error(`fixture profile failed: ${JSON.stringify(result.issues)}`);
  cache.set(key, result.profile);
  return result.profile;
}

/** Frames of one activity for a persona (60 s at 3 fps by default). */
export function activityFrames(
  persona: Persona,
  activity: Activity,
  seed = 99,
  ms = 60_000,
): FrameFeatures[] {
  return synthesize([[activity, ms]], { persona, seed })
    .map((tick) => tick.frame)
    .filter((frame): frame is FrameFeatures => frame !== null);
}

export interface FaceSpec {
  yaw?: number;
  pitch?: number;
  roll?: number;
  cx?: number;
  cy?: number;
  w?: number;
  h?: number;
  blink?: number;
  lookDown?: number;
  lookUp?: number;
  gazeX?: number;
}

export function face(spec: FaceSpec = {}): FaceFeatures {
  return {
    pose: { yaw: spec.yaw ?? 0, pitch: spec.pitch ?? -5, roll: spec.roll ?? 0 },
    box: { cx: spec.cx ?? 0.5, cy: spec.cy ?? 0.42, w: spec.w ?? 0.22, h: spec.h ?? 0.3 },
    truncated: 0,
    blink: spec.blink ?? 0.12,
    lookDown: spec.lookDown ?? 0.1,
    lookUp: spec.lookUp ?? 0.05,
    gazeX: spec.gazeX ?? 0,
    jawOpen: 0.02,
    jitter: 0.005,
    faces: 1,
  };
}

export interface FrameSpec {
  t?: number;
  face?: FaceFeatures | null;
  person?: number | null;
  phone?: { score: number; nearFace?: boolean; moving?: boolean; stillMs?: number } | null;
  book?: number | null;
  fresh?: boolean;
  luma?: { mean?: number; covered?: boolean } | null;
}

export function frame(spec: FrameSpec = {}): FrameFeatures {
  const f = spec.face === undefined ? face() : spec.face;
  const objects: ObjectFeatures = {
    ranAt: spec.t ?? 0,
    ageMs: 0,
    fresh: spec.fresh ?? true,
    phone:
      spec.phone === null || spec.phone === undefined
        ? null
        : {
            score: spec.phone.score,
            box: { cx: 0.5, cy: 0.7, w: 0.12, h: 0.18 },
            nearFace: spec.phone.nearFace ?? true,
            moving: spec.phone.moving ?? false,
            stillMs: spec.phone.stillMs ?? 0,
          },
    book:
      spec.book === null || spec.book === undefined
        ? null
        : { score: spec.book, box: { cx: 0.5, cy: 0.8, w: 0.35, h: 0.2 } },
    person:
      spec.person === null
        ? null
        : { score: spec.person ?? 0.9, box: { cx: 0.5, cy: 0.6, w: 0.6, h: 0.8 } },
  };
  const luma =
    spec.luma === null
      ? null
      : {
          at: spec.t ?? 0,
          mean: spec.luma?.mean ?? 0.45,
          spatialStd: spec.luma?.covered ? 0.01 : 0.12,
          temporalDiff: 0.01,
          motionNearFace: 0.02,
          covered: spec.luma?.covered ?? false,
          lowLight: false,
        };
  return { t: spec.t ?? 0, width: 320, height: 240, face: f, objects, luma, quality: 0.95 };
}

/**
 * `n` frames of a posture relative to a baseline (a tablet on a stand, a whiteboard…), with
 * a little pose noise, 3 fps.
 */
export function postureFrames(
  base: { yaw: number; pitch: number; roll: number; cx: number; cy: number; w: number; h: number },
  dyaw: number,
  dpitch: number,
  n: number,
  seed: number,
  gazeX = 0,
): FrameFeatures[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) =>
    frame({
      t: i * 333,
      face: face({
        yaw: base.yaw + dyaw + gaussian(rng, 0, 3),
        pitch: base.pitch + dpitch + gaussian(rng, 0, 3),
        roll: base.roll + gaussian(rng, 0, 1),
        cx: base.cx + gaussian(rng, 0, 0.01),
        cy: base.cy + gaussian(rng, 0, 0.01),
        w: base.w,
        h: base.h,
        blink: 0.15 + gaussian(rng, 0, 0.05),
        lookDown: 0.2,
        gazeX,
      }),
    }),
  );
}

/** Mean of p.screen + p.paper over the frames the classifier answers for. */
export function meanStudy(
  predict: (f: FrameFeatures) => Readonly<Record<CalibrationClass, number>> | null,
  frames: readonly FrameFeatures[],
): number {
  let n = 0;
  let s = 0;
  for (const f of frames) {
    const p = predict(f);
    if (!p) continue;
    n += 1;
    s += p.screen + p.paper;
  }
  return n > 0 ? s / n : Number.NaN;
}

/** CPU milliseconds spent by `fn` (robust to other processes sharing the machine). */
export function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1_000;
}
