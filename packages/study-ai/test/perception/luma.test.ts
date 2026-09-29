import { describe, expect, it } from 'vitest';
import { FeatureExtractor } from '../../src/perception/extractor';
import { isValidThumbnail, lumaStats, LumaTracker } from '../../src/perception/luma';
import { frameQuality } from '../../src/perception/quality';
import type { FaceFeatures, LumaFeatures, ObjectFeatures } from '../../src/types';
import { H, NO_FACE, W, faceResult, scene, thumbnail } from './fixtures';

describe('lumaStats', () => {
  it('a normal textured scene is neither covered nor dark', () => {
    const s = lumaStats(scene(), null, null);
    expect(s.mean).toBeGreaterThan(0.3);
    expect(s.spatialStd).toBeGreaterThan(0.05);
    expect(s.covered).toBe(false);
    expect(s.lowLight).toBe(false);
  });

  it('a finger or a closed lid (uniform and dark) is covered', () => {
    const dark = thumbnail(() => 8);
    const s = lumaStats(dark, scene().data, null);
    expect(s.covered).toBe(true);
    expect(s.lowLight).toBe(false);
  });

  it('a uniform, static bright surface right on the lens is covered', () => {
    const wall = thumbnail(() => 150);
    expect(lumaStats(wall, wall.data, null).covered).toBe(true);
    // The same surface still changing (light flicker, moving) is not.
    const changing = thumbnail(() => 158);
    expect(lumaStats(changing, wall.data, null).covered).toBe(false);
  });

  it('a dark but textured room is low light, not covered', () => {
    const dim = thumbnail((x, y) => 12 + ((x * 7 + y * 3) % 25));
    const s = lumaStats(dim, null, null);
    expect(s.covered).toBe(false);
    expect(s.lowLight).toBe(true);
  });

  it('temporalDiff and motionNearFace measure change, near the face only for the latter', () => {
    const before = scene();
    // Change only a block in the top-left corner.
    const after = thumbnail((x, y) => (x < 8 && y < 6 ? 250 : (before.data[y * 32 + x] as number)));
    const faceFar = { cx: 0.75, cy: 0.7, w: 0.2, h: 0.25 };
    const faceNear = { cx: 0.12, cy: 0.12, w: 0.2, h: 0.25 };
    const far = lumaStats(after, before.data, faceFar);
    const near = lumaStats(after, before.data, faceNear);
    expect(far.temporalDiff).toBeGreaterThan(0.01);
    expect(far.motionNearFace).toBe(0);
    expect(near.motionNearFace).toBeGreaterThan(far.temporalDiff);
    expect(lumaStats(before, before.data, faceNear)).toMatchObject({
      temporalDiff: 0,
      motionNearFace: 0,
    });
  });

  it('rejects malformed thumbnails', () => {
    expect(isValidThumbnail({ width: 32, height: 24, data: new Uint8Array(10) })).toBe(false);
    expect(isValidThumbnail({ width: 0, height: 24, data: new Uint8Array(0) })).toBe(false);
    expect(isValidThumbnail({ width: 2.5, height: 2, data: new Uint8Array(10) })).toBe(false);
    expect(isValidThumbnail(null)).toBe(false);
    expect(isValidThumbnail(scene())).toBe(true);
  });
});

describe('LumaTracker', () => {
  it('holds values ≤ 2 s and drops them after', () => {
    const tracker = new LumaTracker();
    tracker.sample(1_000, scene(), null);
    expect(tracker.at(3_000, 2_000)?.at).toBe(1_000);
    expect(tracker.at(3_001, 2_000)).toBeNull();
  });

  it('compares with the previous thumbnail, and forgets it on reset', () => {
    const tracker = new LumaTracker();
    tracker.sample(0, scene(0), null);
    expect(tracker.sample(1_000, scene(1), null).temporalDiff).toBeGreaterThan(0.1);
    tracker.reset();
    expect(tracker.sample(2_000, scene(0), null).temporalDiff).toBe(0);
  });

  it('brightens detector inputs only after 5 s of low light', () => {
    const tracker = new LumaTracker();
    const dim = thumbnail((x, y) => 28 + ((x + y) % 2) * 20); // mean 38/255 ≈ 0.149
    tracker.sample(0, dim, null);
    expect(tracker.gain).toBe(1);
    tracker.sample(4_000, dim, null);
    expect(tracker.gain).toBe(1);
    tracker.sample(5_000, dim, null);
    expect(tracker.gain).toBeCloseTo(0.4 / (38 / 255), 6);
    const veryDark = thumbnail((x, y) => 2 + ((x + y) % 2) * 20);
    tracker.sample(6_000, veryDark, null);
    expect(tracker.gain).toBe(3);
    tracker.sample(7_000, scene(), null);
    expect(tracker.gain).toBe(1);
  });
});

describe('frame quality', () => {
  const face = (over: Partial<FaceFeatures> = {}): FaceFeatures => ({
    pose: { yaw: 0, pitch: 0, roll: 0 },
    box: { cx: 0.5, cy: 0.5, w: 0.2, h: 0.3 },
    truncated: 0,
    blink: 0.1,
    lookDown: 0.1,
    lookUp: 0.1,
    gazeX: 0,
    jawOpen: 0,
    jitter: 0,
    faces: 1,
    ...over,
  });
  const luma = (lowLight: boolean): LumaFeatures => ({
    at: 0,
    mean: lowLight ? 0.1 : 0.4,
    spatialStd: 0.1,
    temporalDiff: 0.01,
    motionNearFace: 0,
    covered: false,
    lowLight,
  });
  const person: ObjectFeatures = {
    ranAt: 0,
    ageMs: 0,
    fresh: true,
    phone: null,
    book: null,
    person: { score: 0.8, box: { cx: 0.5, cy: 0.6, w: 0.6, h: 0.8 } },
  };

  it('follows the formula and stays in [0.2, 1]', () => {
    expect(frameQuality(face(), null, luma(false))).toBe(1);
    expect(frameQuality(face({ truncated: 0.4 }), null, null)).toBeCloseTo(0.8, 9);
    expect(frameQuality(face({ jitter: 0.006 }), null, null)).toBeCloseTo(0.7, 9);
    expect(frameQuality(face({ jitter: 1 }), null, null)).toBeCloseTo(0.6, 9);
    expect(frameQuality(face(), null, luma(true))).toBeCloseTo(0.8, 9);
    expect(frameQuality(face({ truncated: 1, jitter: 1 }), null, luma(true))).toBe(0.2);
    expect(frameQuality(null, person, null)).toBe(0.6);
    expect(frameQuality(null, null, null)).toBe(0.2);
    expect(
      frameQuality(face({ truncated: Number.NaN, jitter: Number.NaN }), null, null),
    ).toBeGreaterThanOrEqual(0.2);
  });
});

describe('luma through the extractor', () => {
  it('samples on luma frames, holds in between and uses the last face box for motion', () => {
    const ex = new FeatureExtractor();
    const face = faceResult([{ box: { cx: 0.5, cy: 0.45, w: 0.3, h: 0.4 } }]);
    const first = ex.extract({ t: 0, width: W, height: H, face, objects: null, gray: scene(0) });
    expect(first.luma?.at).toBe(0);
    const between = ex.extract({ t: 500, width: W, height: H, face, objects: null, gray: null });
    expect(between.luma).toBe(first.luma);
    const moved = ex.extract({
      t: 1_000,
      width: W,
      height: H,
      face: NO_FACE,
      objects: null,
      gray: scene(1),
    });
    expect(moved.face).toBeNull();
    expect(moved.luma?.motionNearFace).toBeGreaterThan(0.1);
    const stale = ex.extract({
      t: 3_500,
      width: W,
      height: H,
      face: NO_FACE,
      objects: null,
      gray: null,
    });
    expect(stale.luma).toBeNull();
  });

  it('exposes the low-light gain for the vision pipeline', () => {
    const ex = new FeatureExtractor();
    const dim = thumbnail((x, y) => 20 + ((x + y) % 2) * 20);
    for (let t = 0; t <= 6_000; t += 1_000) {
      ex.extract({ t, width: W, height: H, face: NO_FACE, objects: null, gray: dim });
    }
    expect(ex.lowLightGain).toBeGreaterThan(1);
    ex.reset();
    expect(ex.lowLightGain).toBe(1);
  });
});
