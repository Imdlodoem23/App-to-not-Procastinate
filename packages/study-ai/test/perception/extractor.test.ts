import { describe, expect, it } from 'vitest';
import { FeatureExtractor } from '../../src/perception/extractor';
import type {
  CategoryLike,
  DetectionResultLike,
  FaceLandmarkerResultLike,
  FrameFeatures,
  GrayThumbnail,
  LandmarkLike,
} from '../../src/types';
import { mulberry32, type Rng } from '../../src/util/rng';
import { BLENDSHAPE_ORDER, H, W, detection, faceResult, poseMatrix, scene } from './fixtures';

const WILD = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e308,
  -1e308,
  -5,
  0,
  0.5,
  1,
  7,
];
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
const wild = (rng: Rng, normal: () => number): number => (rng() < 0.3 ? pick(rng, WILD) : normal());

function wildFace(rng: Rng): FaceLandmarkerResultLike {
  const faces = Math.floor(rng() * 3);
  const landmarks: LandmarkLike[][] = [];
  const shapes: { categories: CategoryLike[] }[] = [];
  const matrixes = [];
  for (let f = 0; f < faces; f += 1) {
    const cx = rng();
    const cy = rng();
    const pts: LandmarkLike[] = [];
    const n = rng() < 0.2 ? Math.floor(rng() * 5) : 478;
    for (let i = 0; i < n; i += 1) {
      pts.push({
        x: wild(rng, () => cx + (rng() - 0.5) * 0.3),
        y: wild(rng, () => cy + (rng() - 0.5) * 0.4),
      });
    }
    landmarks.push(pts);
    shapes.push({
      categories: BLENDSHAPE_ORDER.map((name) => ({ categoryName: name, score: wild(rng, rng) })),
    });
    const m = poseMatrix((rng() - 0.5) * 120, (rng() - 0.5) * 120, (rng() - 0.5) * 60);
    const data = Array.from(m.data).map((v) => (rng() < 0.05 ? pick(rng, WILD) : v));
    matrixes.push({ rows: 4, columns: 4, data });
  }
  return {
    faceLandmarks: landmarks,
    faceBlendshapes: rng() < 0.1 ? [] : shapes,
    facialTransformationMatrixes: rng() < 0.1 ? [] : matrixes,
  };
}

function wildObjects(rng: Rng): DetectionResultLike | null {
  if (rng() < 0.5) return null;
  const detections = [];
  for (let i = 0; i < Math.floor(rng() * 5); i += 1) {
    detections.push({
      categories: [
        {
          categoryName: pick(rng, ['cell phone', 'book', 'person', 'cat']),
          score: wild(rng, rng),
        },
      ],
      boundingBox: {
        originX: wild(rng, () => rng() * W),
        originY: wild(rng, () => rng() * H),
        width: wild(rng, () => rng() * W),
        height: wild(rng, () => rng() * H),
      },
    });
  }
  return { detections };
}

function wildGray(rng: Rng): GrayThumbnail | null {
  if (rng() < 0.5) return null;
  if (rng() < 0.1) return { width: 32, height: 24, data: new Uint8Array(3) };
  const data = new Uint8Array(32 * 24);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(rng() * 256);
  return { width: 32, height: 24, data };
}

/** Every out-of-range number of `f`, as readable strings (empty when sane). */
function insane(f: FrameFeatures): string[] {
  const bad: string[] = [];
  const inRange = (v: number, lo: number, hi: number, name: string): void => {
    if (!Number.isFinite(v) || v < lo || v > hi) bad.push(`${name}=${v}`);
  };
  inRange(f.t, -1e15, 1e15, 't');
  inRange(f.width, 1, 16_384, 'width');
  inRange(f.height, 1, 16_384, 'height');
  inRange(f.quality, 0.2, 1, 'quality');
  if (f.face) {
    const { pose, box } = f.face;
    inRange(pose.yaw, -90, 90, 'yaw');
    inRange(pose.pitch, -90, 90, 'pitch');
    inRange(pose.roll, -180, 180, 'roll');
    inRange(box.cx, -1, 2, 'cx');
    inRange(box.cy, -1, 2, 'cy');
    inRange(box.w, 0, 3, 'w');
    inRange(box.h, 0.08, 3, 'h');
    for (const k of ['truncated', 'blink', 'lookDown', 'lookUp', 'jawOpen'] as const) {
      inRange(f.face[k], 0, 1, k);
    }
    inRange(f.face.gazeX, -1, 1, 'gazeX');
    inRange(f.face.jitter, 0, 1e6, 'jitter');
    inRange(f.face.faces, 1, 10, 'faces');
  }
  if (f.objects) {
    inRange(f.objects.ageMs, 0, 4_000, 'ageMs');
    for (const d of [f.objects.phone, f.objects.book, f.objects.person]) {
      if (!d) continue;
      inRange(d.score, 0.3, 1, 'score');
      inRange(d.box.cx, 0, 1, 'obj cx');
      inRange(d.box.cy, 0, 1, 'obj cy');
      inRange(d.box.w, 0, 1, 'obj w');
      inRange(d.box.h, 0, 1, 'obj h');
    }
    if (f.objects.phone) inRange(f.objects.phone.stillMs, 0, 1e9, 'stillMs');
  }
  if (f.luma) {
    for (const k of ['mean', 'spatialStd', 'temporalDiff', 'motionNearFace'] as const) {
      inRange(f.luma[k], 0, 1, k);
    }
  }
  return bad;
}

describe('FeatureExtractor', () => {
  it('turns a plain MediaPipe-shaped frame into features', () => {
    const ex = new FeatureExtractor();
    const out = ex.extract({
      t: 1_000,
      width: W,
      height: H,
      face: faceResult([
        {
          box: { cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 },
          yaw: 10,
          pitch: -25,
          shapes: { eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6, jawOpen: 0.1 },
        },
      ]),
      objects: {
        detections: [
          detection('book', 0.7, { cx: 0.5, cy: 0.85, w: 0.4, h: 0.2 }),
          detection('person', 0.9, { cx: 0.5, cy: 0.6, w: 0.7, h: 0.8 }),
        ],
      },
      gray: scene(),
    });
    expect(out.face?.pose.yaw).toBeCloseTo(10, 6);
    expect(out.face?.pose.pitch).toBeCloseTo(-25, 6);
    expect(out.face?.lookDown).toBeCloseTo(0.6, 9);
    expect(out.objects?.book?.score).toBe(0.7);
    expect(out.objects?.person?.score).toBe(0.9);
    expect(out.luma?.covered).toBe(false);
    expect(out.quality).toBe(1);
    expect(insane(out)).toEqual([]);
  });

  it('gives finite, clamped numbers from NaN, Infinity and malformed inputs (seeded fuzz)', () => {
    const rng = mulberry32(20260928);
    const ex = new FeatureExtractor();
    let t = 0;
    const problems: string[] = [];
    for (let i = 0; i < 800; i += 1) {
      t += rng() < 0.02 ? 10_000 : 333;
      const out = ex.extract({
        t: rng() < 0.02 ? Number.NaN : t,
        width: rng() < 0.02 ? pick(rng, WILD) : W,
        height: rng() < 0.02 ? pick(rng, WILD) : H,
        face: rng() < 0.02 ? ({} as FaceLandmarkerResultLike) : wildFace(rng),
        objects: wildObjects(rng),
        gray: wildGray(rng),
      });
      for (const p of insane(out)) problems.push(`frame ${i}: ${p}`);
      if (rng() < 0.01) ex.reset();
    }
    expect(problems).toEqual([]);
  });

  it('reset() forgets the face, the phone and every held value', () => {
    const ex = new FeatureExtractor();
    const face = faceResult([{ box: { cx: 0.5, cy: 0.4, w: 0.2, h: 0.3 } }]);
    ex.extract({
      t: 0,
      width: W,
      height: H,
      face,
      objects: {
        detections: [detection('cell phone', 0.8, { cx: 0.5, cy: 0.7, w: 0.1, h: 0.15 })],
      },
      gray: scene(),
    });
    ex.reset();
    const after = ex.extract({
      t: 100,
      width: W,
      height: H,
      face: { faceLandmarks: [] },
      objects: null,
      gray: null,
    });
    expect(after).toEqual({
      t: 100,
      width: W,
      height: H,
      face: null,
      objects: null,
      luma: null,
      quality: 0.2,
    });
  });
});
