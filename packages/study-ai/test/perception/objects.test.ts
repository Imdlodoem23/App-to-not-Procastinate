import { describe, expect, it } from 'vitest';
import { STUDY_AI_CONSTANTS } from '../../src/config';
import { FeatureExtractor } from '../../src/perception/extractor';
import { isNearFace, ObjectHold, PhoneTracker, selectObjects } from '../../src/perception/objects';
import type { Box, DetectionResultLike } from '../../src/types';
import { H, NO_FACE, W, detection, faceResult } from './fixtures';

const FACE: Box = { cx: 0.5, cy: 0.35, w: 0.2, h: 0.28 };
const IN_HAND: Box = { cx: 0.55, cy: 0.75, w: 0.1, h: 0.16 };
const ON_DESK_FAR: Box = { cx: 0.95, cy: 0.9, w: 0.06, h: 0.05 };

describe('selectObjects', () => {
  it('keeps only the allowlisted labels above the threshold', () => {
    const run = selectObjects(
      {
        detections: [
          detection('dog', 0.9, IN_HAND),
          detection('cell phone', 0.29, IN_HAND),
          detection('book', 0.31, { cx: 0.4, cy: 0.8, w: 0.3, h: 0.15 }),
          detection('laptop', 0.95, { cx: 0.5, cy: 0.8, w: 0.5, h: 0.3 }),
        ],
      },
      W,
      H,
      0.3,
    );
    expect(run.phone).toBeNull();
    expect(run.person).toBeNull();
    expect(run.book?.score).toBeCloseTo(0.31, 9);
  });

  it('applies the area gates: phone ≥ 0.4 %, person ≥ 5 %', () => {
    const tinyPhone = { cx: 0.5, cy: 0.5, w: 0.05, h: 0.06 }; // 0.3 %
    const okPhone = { cx: 0.5, cy: 0.5, w: 0.07, h: 0.07 }; // 0.49 %
    const smallPerson = { cx: 0.2, cy: 0.3, w: 0.2, h: 0.2 }; // 4 %
    const bigPerson = { cx: 0.5, cy: 0.6, w: 0.6, h: 0.8 };
    const a = selectObjects(
      {
        detections: [
          detection('cell phone', 0.9, tinyPhone),
          detection('person', 0.9, smallPerson),
        ],
      },
      W,
      H,
      0.3,
    );
    expect(a.phone).toBeNull();
    expect(a.person).toBeNull();
    const b = selectObjects(
      { detections: [detection('cell phone', 0.5, okPhone), detection('person', 0.8, bigPerson)] },
      W,
      H,
      0.3,
    );
    expect(b.phone?.score).toBe(0.5);
    expect(b.person?.box.w).toBeCloseTo(0.6, 9);
  });

  it('keeps the best of each label and normalises pixel boxes', () => {
    const run = selectObjects(
      {
        detections: [
          detection('cell phone', 0.4, ON_DESK_FAR),
          detection('cell phone', 0.8, IN_HAND),
        ],
      },
      W,
      H,
      0.3,
    );
    expect(run.phone?.score).toBe(0.8);
    expect(run.phone?.box.cx).toBeCloseTo(IN_HAND.cx, 9);
    expect(run.phone?.box.h).toBeCloseTo(IN_HAND.h, 9);
  });

  it('drops detections with broken boxes or scores', () => {
    const broken: DetectionResultLike = {
      detections: [
        { categories: [{ categoryName: 'cell phone', score: 0.9 }] },
        {
          categories: [{ categoryName: 'cell phone', score: Number.NaN }],
          boundingBox: { originX: 10, originY: 10, width: 40, height: 60 },
        },
        {
          categories: [{ categoryName: 'book', score: 0.9 }],
          boundingBox: { originX: Number.POSITIVE_INFINITY, originY: 0, width: 10, height: 10 },
        },
        {
          categories: [{ categoryName: 'person', score: 0.9 }],
          boundingBox: { originX: 400, originY: 10, width: 40, height: 60 },
        },
      ],
    };
    expect(selectObjects(broken, W, H, 0.3)).toEqual({ phone: null, book: null, person: null });
  });
});

describe('phone near the face', () => {
  it('uses the face box region or an overlap', () => {
    expect(isNearFace(IN_HAND, FACE)).toBe(true);
    expect(isNearFace({ cx: 0.5, cy: 0.3, w: 0.1, h: 0.1 }, FACE)).toBe(true); // on a call
    // ±2.5 face widths covers most of the frame for a close face; a smaller one shows the edge.
    const smallFace = { cx: 0.5, cy: 0.35, w: 0.14, h: 0.2 };
    expect(isNearFace(ON_DESK_FAR, smallFace)).toBe(false);
    expect(isNearFace({ ...ON_DESK_FAR, cx: 0.8 }, smallFace)).toBe(true);
    expect(isNearFace({ cx: 0.5, cy: 0.02, w: 0.05, h: 0.03 }, FACE)).toBe(false); // above
  });
});

describe('PhoneTracker', () => {
  const phone = (box: Box, score = 0.7) => ({ score, box });

  it('a new phone is not moving and not still yet', () => {
    const tracker = new PhoneTracker();
    const p = tracker.update(phone(IN_HAND), 0, FACE, W, H)!;
    expect(p).toMatchObject({ nearFace: true, moving: false, stillMs: 0 });
  });

  it('moving: centre moved more than a quarter of the diagonal, or area changed > 30 %', () => {
    const tracker = new PhoneTracker();
    tracker.update(phone(IN_HAND), 0, FACE, W, H);
    const moved = tracker.update(phone({ ...IN_HAND, cx: IN_HAND.cx + 0.06 }), 1_000, FACE, W, H)!;
    expect(moved.moving).toBe(true);
    const small = tracker.update(phone({ ...IN_HAND, cx: IN_HAND.cx + 0.065 }), 2_000, FACE, W, H)!;
    expect(small.moving).toBe(false);
    const closer = tracker.update(
      phone({ ...IN_HAND, cx: IN_HAND.cx + 0.065, w: 0.13, h: 0.2 }),
      3_000,
      FACE,
      W,
      H,
    )!;
    expect(closer.moving).toBe(true);
  });

  it('stillMs grows while the box stays put, even across a few missed runs', () => {
    const tracker = new PhoneTracker();
    const desk = { cx: 0.5, cy: 0.85, w: 0.1, h: 0.08 };
    tracker.update(phone(desk), 0, FACE, W, H);
    expect(tracker.update(phone(desk), 1_000, FACE, W, H)!.stillMs).toBe(1_000);
    expect(tracker.update(null, 2_000, FACE, W, H)).toBeNull();
    expect(tracker.update(null, 3_000, FACE, W, H)).toBeNull();
    const back = tracker.update(phone({ ...desk, cx: desk.cx + 0.002 }), 4_000, FACE, W, H)!;
    expect(back.stillMs).toBe(4_000);
    expect(back.moving).toBe(false);
    // Picked up: resets.
    const picked = tracker.update(phone(IN_HAND), 5_000, FACE, W, H)!;
    expect(picked.stillMs).toBe(0);
    expect(picked.moving).toBe(true);
  });

  it('forgets a phone not seen for more than 5 s', () => {
    const tracker = new PhoneTracker();
    tracker.update(phone(IN_HAND), 0, FACE, W, H);
    tracker.update(phone(IN_HAND), 1_000, FACE, W, H);
    const later = tracker.update(phone(IN_HAND), 7_000, FACE, W, H)!;
    expect(later.stillMs).toBe(0);
    expect(later.moving).toBe(false);
  });

  it('without a face box, nothing is near the face', () => {
    const tracker = new PhoneTracker();
    expect(tracker.update(phone(IN_HAND), 0, null, W, H)!.nearFace).toBe(false);
  });
});

describe('ObjectHold', () => {
  it('holds between runs with fresh:false and expires after 4 s', () => {
    const hold = new ObjectHold();
    expect(hold.at(0, 4_000)).toBeNull();
    const run = hold.ran(1_000, { phone: null, book: null, person: null });
    expect(run).toMatchObject({ ranAt: 1_000, ageMs: 0, fresh: true });
    expect(hold.at(2_500, 4_000)).toMatchObject({ ranAt: 1_000, ageMs: 1_500, fresh: false });
    expect(hold.at(5_000, 4_000)).toMatchObject({ ageMs: 4_000, fresh: false });
    expect(hold.at(5_001, 4_000)).toBeNull();
    expect(hold.at(5_002, 4_000)).toBeNull();
  });

  it('reset() drops the held values', () => {
    const hold = new ObjectHold();
    hold.ran(0, { phone: null, book: null, person: null });
    hold.reset();
    expect(hold.at(1, 4_000)).toBeNull();
  });
});

describe('objects through the extractor', () => {
  const hold = STUDY_AI_CONSTANTS.objectHoldMs;

  it('fresh only on run frames, held after, null after the hold', () => {
    const ex = new FeatureExtractor();
    const face = faceResult([{ box: FACE }]);
    const run = ex.extract({
      t: 0,
      width: W,
      height: H,
      face,
      objects: { detections: [detection('cell phone', 0.8, IN_HAND)] },
      gray: null,
    });
    expect(run.objects?.fresh).toBe(true);
    expect(run.objects?.phone?.nearFace).toBe(true);
    const held = ex.extract({ t: 333, width: W, height: H, face, objects: null, gray: null });
    expect(held.objects).toMatchObject({ fresh: false, ageMs: 333, ranAt: 0 });
    expect(held.objects?.phone?.score).toBe(0.8);
    const gone = ex.extract({ t: hold + 1, width: W, height: H, face, objects: null, gray: null });
    expect(gone.objects).toBeNull();
  });

  it('an empty run replaces the held phone', () => {
    const ex = new FeatureExtractor();
    ex.extract({
      t: 0,
      width: W,
      height: H,
      face: NO_FACE,
      objects: { detections: [detection('cell phone', 0.8, IN_HAND)] },
      gray: null,
    });
    const empty = ex.extract({
      t: 1_000,
      width: W,
      height: H,
      face: NO_FACE,
      objects: { detections: [] },
      gray: null,
    });
    expect(empty.objects).toEqual({
      ranAt: 1_000,
      ageMs: 0,
      fresh: true,
      phone: null,
      book: null,
      person: null,
    });
  });

  it('uses the last face box (≤ 10 s) for nearFace when the face is hidden', () => {
    const ex = new FeatureExtractor();
    ex.extract({
      t: 0,
      width: W,
      height: H,
      face: faceResult([{ box: FACE }]),
      objects: null,
      gray: null,
    });
    const hidden = ex.extract({
      t: 5_000,
      width: W,
      height: H,
      face: NO_FACE,
      objects: { detections: [detection('cell phone', 0.8, IN_HAND)] },
      gray: null,
    });
    expect(hidden.face).toBeNull();
    expect(hidden.objects?.phone?.nearFace).toBe(true);
    const tooLate = ex.extract({
      t: 16_000,
      width: W,
      height: H,
      face: NO_FACE,
      objects: { detections: [detection('cell phone', 0.8, IN_HAND)] },
      gray: null,
    });
    expect(tooLate.objects?.phone?.nearFace).toBe(false);
  });

  it('honours a custom score threshold', () => {
    const ex = new FeatureExtractor({ objectScoreThreshold: 0.6 });
    const out = ex.extract({
      t: 0,
      width: W,
      height: H,
      face: NO_FACE,
      objects: { detections: [detection('cell phone', 0.5, IN_HAND)] },
      gray: null,
    });
    expect(out.objects?.phone).toBeNull();
  });
});
