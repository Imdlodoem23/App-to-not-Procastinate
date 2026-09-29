import { describe, expect, it } from 'vitest';
import {
  BlendshapeReader,
  chooseUserFace,
  FaceTracker,
  landmarkBox,
  type FaceCandidate,
} from '../../src/perception/face';
import type { Box } from '../../src/types';
import { BLENDSHAPE_ORDER, H, W, blendshapes, faceResult, landmarksInBox } from './fixtures';

const MEMORY = 10_000;
const USER: Box = { cx: 0.5, cy: 0.42, w: 0.22, h: 0.3 };

describe('blendshapes', () => {
  it('reads by name whatever the order, and the same after a reorder', () => {
    const values = {
      eyeBlinkLeft: 0.2,
      eyeBlinkRight: 0.4,
      eyeLookDownLeft: 0.5,
      eyeLookDownRight: 0.7,
      eyeLookUpLeft: 0.1,
      eyeLookUpRight: 0.3,
      jawOpen: 0.65,
    };
    const reader = new BlendshapeReader();
    const ordered = reader.read(blendshapes(values).categories);
    const shuffled = [...BLENDSHAPE_ORDER].reverse();
    const reversed = reader.read(blendshapes(values, shuffled).categories);
    const rotated = reader.read(
      blendshapes(values, [...BLENDSHAPE_ORDER.slice(20), ...BLENDSHAPE_ORDER.slice(0, 20)])
        .categories,
    );
    for (const out of [ordered, reversed, rotated]) {
      expect(out.blink).toBeCloseTo(0.3, 9);
      expect(out.lookDown).toBeCloseTo(0.6, 9);
      expect(out.lookUp).toBeCloseTo(0.2, 9);
      expect(out.jawOpen).toBeCloseTo(0.65, 9);
    }
  });

  it('gives 0 for missing names and non-finite scores, and clamps to 0–1', () => {
    const reader = new BlendshapeReader();
    const out = reader.read([
      { categoryName: 'eyeBlinkLeft', score: Number.NaN },
      { categoryName: 'eyeBlinkRight', score: 3 },
      { categoryName: 'jawOpen', score: -1 },
      { categoryName: 'eyeLookDownLeft', score: Number.POSITIVE_INFINITY },
    ]);
    expect(out).toEqual({ blink: 0.5, lookDown: 0, lookUp: 0, gazeX: 0, jawOpen: 0 });
    expect(reader.read(undefined)).toEqual({
      blink: 0,
      lookDown: 0,
      lookUp: 0,
      gazeX: 0,
      jawOpen: 0,
    });
  });

  it('gazeX is positive towards the subject’s left (image right), like yaw', () => {
    const reader = new BlendshapeReader();
    // Subject looks to their left: left eye looks out, right eye looks in (towards the nose).
    const toImageRight = reader.read(
      blendshapes({ eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 }).categories,
    );
    const toImageLeft = reader.read(
      blendshapes({ eyeLookInLeft: 0.8, eyeLookOutRight: 0.8 }).categories,
    );
    expect(toImageRight.gazeX).toBeGreaterThan(0.7);
    expect(toImageLeft.gazeX).toBeLessThan(-0.7);
    const extreme = reader.read(
      blendshapes({ eyeLookOutLeft: 1, eyeLookInRight: 1, eyeLookInLeft: 0, eyeLookOutRight: 0 })
        .categories,
    );
    expect(extreme.gazeX).toBeLessThanOrEqual(1);
  });
});

describe('landmark box', () => {
  it('spans the landmarks and counts the truncated share', () => {
    const lb = landmarkBox(landmarksInBox(USER))!;
    expect(lb.box.cx).toBeCloseTo(USER.cx, 9);
    expect(lb.box.cy).toBeCloseTo(USER.cy, 9);
    expect(lb.box.w).toBeCloseTo(USER.w, 9);
    expect(lb.box.h).toBeCloseTo(USER.h, 9);
    expect(lb.truncated).toBe(0);

    // Half the face below the bottom edge.
    const low = landmarkBox(landmarksInBox({ cx: 0.5, cy: 1, w: 0.2, h: 0.3 }))!;
    expect(low.truncated).toBeGreaterThan(0.4);
    expect(low.truncated).toBeLessThan(0.6);
  });

  it('skips NaN points and clamps wild ones', () => {
    const points = landmarksInBox(USER);
    points[3] = { x: Number.NaN, y: 0.5 };
    points[4] = { x: 1e300, y: -1e300 };
    const lb = landmarkBox(points)!;
    expect(lb.valid).toBe(points.length - 1);
    expect(Number.isFinite(lb.box.w)).toBe(true);
    expect(lb.box.w).toBeLessThanOrEqual(3);
    expect(landmarkBox([])).toBeNull();
    expect(landmarkBox([{ x: Number.NaN, y: 1 }])).toBeNull();
  });
});

describe('choosing the user’s face', () => {
  const candidate = (index: number, box: Box): FaceCandidate => ({
    index,
    box,
    truncated: 0,
    pose: { yaw: 0, pitch: 0, roll: 0 },
  });

  it('ignores faces under 8 % of the frame height', () => {
    const tiny = candidate(0, { cx: 0.5, cy: 0.5, w: 0.06, h: 0.07 });
    expect(chooseUserFace([tiny], null)).toBeNull();
  });

  it('a second, smaller face never wins', () => {
    const user = candidate(1, USER);
    const behind = candidate(0, { cx: 0.8, cy: 0.3, w: 0.08, h: 0.1 });
    expect(chooseUserFace([behind, user], null)!.index).toBe(1);
    expect(chooseUserFace([behind, user], USER)!.index).toBe(1);
  });

  it('continuity keeps the tracked face against a slightly bigger newcomer', () => {
    const tracked = candidate(0, USER);
    const bigger = candidate(1, { cx: 0.2, cy: 0.4, w: 0.25, h: 0.33 });
    expect(chooseUserFace([tracked, bigger], null)!.index).toBe(1);
    expect(chooseUserFace([tracked, bigger], USER)!.index).toBe(0);
  });

  it('FaceTracker picks the user and counts every detected face', () => {
    const tracker = new FaceTracker();
    const result = faceResult([
      { box: { cx: 0.85, cy: 0.3, w: 0.07, h: 0.09 }, yaw: 40 },
      { box: USER, yaw: 5, pitch: -20, shapes: { eyeBlinkLeft: 0.3, eyeBlinkRight: 0.3 } },
    ]);
    const face = tracker.extract(result, 0, W, H, MEMORY)!;
    expect(face.faces).toBe(2);
    expect(face.pose.yaw).toBeCloseTo(5, 6);
    expect(face.pose.pitch).toBeCloseTo(-20, 6);
    expect(face.blink).toBeCloseTo(0.3, 9);
    expect(face.box.h).toBeCloseTo(USER.h, 9);
  });

  it('a face without a usable matrix is not a face', () => {
    const tracker = new FaceTracker();
    const result = faceResult([{ box: USER }]);
    const noMatrix = { ...result, facialTransformationMatrixes: [] };
    expect(tracker.extract(noMatrix, 0, W, H, MEMORY)).toBeNull();
  });
});

describe('jitter', () => {
  it('is 0 on the first frame and after a lost face', () => {
    const tracker = new FaceTracker();
    expect(tracker.extract(faceResult([{ box: USER }]), 0, W, H, MEMORY)!.jitter).toBe(0);
    expect(tracker.extract(faceResult([]), 300, W, H, MEMORY)).toBeNull();
    const again = tracker.extract(
      faceResult([{ box: USER, shift: { dx: 0.01 } }]),
      600,
      W,
      H,
      MEMORY,
    )!;
    expect(again.jitter).toBe(0);
  });

  it('is the median displacement in pixels over the box height in pixels', () => {
    const tracker = new FaceTracker();
    tracker.extract(faceResult([{ box: USER }]), 0, W, H, MEMORY);
    // Shift 1.8 px right and 2.4 px down: 3 px on a 72 px tall box.
    const face = tracker.extract(
      faceResult([{ box: USER, shift: { dx: 1.8 / W, dy: 2.4 / H } }]),
      333,
      W,
      H,
      MEMORY,
    )!;
    expect(face.jitter).toBeCloseTo(3 / (USER.h * H), 6);
  });

  it('restarts at 0 when a different face takes over', () => {
    const tracker = new FaceTracker();
    tracker.extract(faceResult([{ box: USER }]), 0, W, H, MEMORY);
    const other = tracker.extract(
      faceResult([{ box: { cx: 0.15, cy: 0.5, w: 0.25, h: 0.33 } }]),
      333,
      W,
      H,
      MEMORY,
    )!;
    expect(other.jitter).toBe(0);
  });
});
