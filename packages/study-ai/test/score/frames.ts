/** Hand-made `FrameFeatures` for DECISION unit tests. */
import type { FaceFeatures, FrameFeatures, LumaFeatures, ObjectFeatures } from '../../src/types';

export interface FaceOptions {
  yaw?: number;
  pitch?: number;
  roll?: number;
  blink?: number;
  lookDown?: number;
  jawOpen?: number;
  truncated?: number;
}

export function faceOf(o: FaceOptions = {}): FaceFeatures {
  return {
    pose: { yaw: o.yaw ?? 0, pitch: o.pitch ?? -5, roll: o.roll ?? 0 },
    box: { cx: 0.5, cy: 0.42, w: 0.22, h: 0.3 },
    truncated: o.truncated ?? 0,
    blink: o.blink ?? 0.12,
    lookDown: o.lookDown ?? 0.1,
    lookUp: 0.05,
    gazeX: 0,
    jawOpen: o.jawOpen ?? 0.02,
    jitter: 0.005,
    faces: 1,
  };
}

export interface FrameOptions {
  face?: FaceFeatures | null;
  /** Detector run on this frame (fresh). `undefined` = no detector values at all. */
  run?: {
    person?: number;
    phone?: { score: number; nearFace?: boolean; moving?: boolean; stillMs?: number };
    book?: number;
  };
  luma?: Partial<LumaFeatures>;
  quality?: number;
}

export function frameAt(t: number, o: FrameOptions = {}): FrameFeatures {
  const box = { cx: 0.5, cy: 0.6, w: 0.3, h: 0.3 };
  const objects: ObjectFeatures | null = o.run
    ? {
        ranAt: t,
        ageMs: 0,
        fresh: true,
        phone: o.run.phone
          ? {
              score: o.run.phone.score,
              box,
              nearFace: o.run.phone.nearFace ?? true,
              moving: o.run.phone.moving ?? false,
              stillMs: o.run.phone.stillMs ?? 0,
            }
          : null,
        book: o.run.book === undefined ? null : { score: o.run.book, box },
        person: o.run.person === undefined ? null : { score: o.run.person, box },
      }
    : null;
  const luma: LumaFeatures = {
    at: t,
    mean: 0.45,
    spatialStd: 0.12,
    temporalDiff: 0.01,
    motionNearFace: 0.005,
    covered: false,
    lowLight: false,
    ...o.luma,
  };
  return {
    t,
    width: 320,
    height: 240,
    face: o.face === undefined ? faceOf() : o.face,
    objects,
    luma,
    quality: o.quality ?? 0.95,
  };
}
