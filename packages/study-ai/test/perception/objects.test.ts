import { describe, expect, it } from 'vitest';
import { STUDY_AI_CONSTANTS } from '../../src/config';
import { FeatureExtractor } from '../../src/perception/extractor';
import {
  isNearFace,
  movedFrom,
  ObjectHold,
  PhoneTracker,
  sameSpot,
  selectObjects,
  touchesBottom,
} from '../../src/perception/objects';
import type { Box, DetectionResultLike, ObjectDetection, PhoneDetection } from '../../src/types';
import { gaussian, mulberry32, type Rng } from '../../src/util/rng';
import { H, NO_FACE, W, detection, faceResult } from './fixtures';

const FACE: Box = { cx: 0.5, cy: 0.35, w: 0.2, h: 0.28 };
const IN_HAND: Box = { cx: 0.55, cy: 0.75, w: 0.1, h: 0.16 };
const ON_DESK_FAR: Box = { cx: 0.95, cy: 0.9, w: 0.06, h: 0.05 };

/** `box` with Gaussian noise of `sd` pixels on each of its four edges (detector jitter). */
function jitterBox(rng: Rng, box: Box, sd: number): Box {
  const x0 = (box.cx - box.w / 2) * W + gaussian(rng, 0, sd);
  const x1 = (box.cx + box.w / 2) * W + gaussian(rng, 0, sd);
  const y0 = (box.cy - box.h / 2) * H + gaussian(rng, 0, sd);
  const y1 = (box.cy + box.h / 2) * H + gaussian(rng, 0, sd);
  return { cx: (x0 + x1) / 2 / W, cy: (y0 + y1) / 2 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

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

  it('keeps the best of each label (every phone for the tracker) and normalises pixel boxes', () => {
    const run = selectObjects(
      {
        detections: [
          detection('cell phone', 0.4, { ...ON_DESK_FAR, w: 0.08 }),
          detection('cell phone', 0.8, IN_HAND),
        ],
      },
      W,
      H,
      0.3,
    );
    expect(run.phone?.score).toBe(0.8);
    expect(run.phones.map((p) => p.score)).toEqual([0.8, 0.4]);
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
    expect(selectObjects(broken, W, H, 0.3)).toEqual({
      phone: null,
      phones: [],
      book: null,
      person: null,
    });
  });
});

describe('phone near the face', () => {
  it('overlapping the face, or in front of the chest within ±1.2 face widths', () => {
    expect(isNearFace(IN_HAND, FACE)).toBe(true);
    expect(isNearFace({ cx: 0.5, cy: 0.3, w: 0.1, h: 0.1 }, FACE)).toBe(true); // on a call
    expect(isNearFace({ cx: 0.73, cy: 0.35, w: 0.06, h: 0.12 }, FACE)).toBe(true); // at the ear
    // A phone lying at the side of the desk is not near, whatever the face size.
    expect(isNearFace(ON_DESK_FAR, FACE)).toBe(false);
    expect(isNearFace({ ...ON_DESK_FAR, cx: 0.8 }, FACE)).toBe(false);
    expect(isNearFace({ cx: 0.8, cy: 0.9, w: 0.1, h: 0.08 }, { ...FACE, w: 0.22, h: 0.3 })).toBe(
      false,
    );
    // Horizontal edge: 1.2 face widths from the face centre.
    expect(isNearFace({ cx: 0.5 + 1.19 * 0.2, cy: 0.7, w: 0.05, h: 0.05 }, FACE)).toBe(true);
    expect(isNearFace({ cx: 0.5 + 1.21 * 0.2, cy: 0.7, w: 0.05, h: 0.05 }, FACE)).toBe(false);
    // Vertical edges: the top of the face, and 1.5 face heights below the chin.
    const chin = FACE.cy + FACE.h / 2;
    expect(isNearFace({ cx: 0.6, cy: chin + 1.49 * FACE.h, w: 0.02, h: 0.02 }, FACE)).toBe(true);
    expect(isNearFace({ cx: 0.6, cy: chin + 1.51 * FACE.h, w: 0.02, h: 0.02 }, FACE)).toBe(false);
    expect(isNearFace({ cx: 0.5, cy: 0.02, w: 0.05, h: 0.03 }, FACE)).toBe(false); // above
  });

  it('touchesBottom: a box cut by the bottom edge of the frame (2 px)', () => {
    expect(touchesBottom({ cx: 0.5, cy: 0.95, w: 0.1, h: 0.1 }, H)).toBe(true);
    expect(touchesBottom({ cx: 0.5, cy: 0.95 - 1 / H, w: 0.1, h: 0.1 }, H)).toBe(true);
    expect(touchesBottom({ cx: 0.5, cy: 0.95 - 3 / H, w: 0.1, h: 0.1 }, H)).toBe(false);
  });
});

describe('spot tests in pixels', () => {
  const DESK: Box = { cx: 0.8, cy: 0.9, w: 0.1, h: 0.08 }; // 32×19 px

  it('1–2 px of edge jitter on a small box is the same spot and not a move', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 2_000; i += 1) {
      const box = jitterBox(rng, DESK, 1.5);
      expect(sameSpot(box, DESK, W, H)).toBe(true);
      expect(movedFrom(box, DESK, W, H)).toBe(false);
    }
  });

  it('a shift of a quarter diagonal or a 50 % bigger box is a move; in between is neither', () => {
    const diag = Math.hypot(DESK.w * W, DESK.h * H);
    const shifted = (px: number): Box => ({ ...DESK, cx: DESK.cx - px / W });
    expect(sameSpot(shifted(0.14 * diag), DESK, W, H)).toBe(true);
    expect(sameSpot(shifted(0.2 * diag), DESK, W, H)).toBe(false);
    expect(movedFrom(shifted(0.2 * diag), DESK, W, H)).toBe(false);
    expect(movedFrom(shifted(0.3 * diag), DESK, W, H)).toBe(true);
    const bigger = { ...DESK, w: DESK.w * 1.35, h: DESK.h * 1.35 }; // area × 1.8
    expect(movedFrom(bigger, DESK, W, H)).toBe(true);
    // Tiny boxes still get 4 px of slack.
    const tiny: Box = { cx: 0.5, cy: 0.5, w: 0.02, h: 0.03 };
    expect(sameSpot({ ...tiny, cx: tiny.cx + 3.5 / W }, tiny, W, H)).toBe(true);
  });
});

describe('PhoneTracker', () => {
  const phone = (box: Box, score = 0.7): ObjectDetection => ({ score, box });
  const DESK_NEAR: Box = { cx: 0.62, cy: 0.8, w: 0.07, h: 0.13 }; // in front of the chest
  const DESK_EDGE: Box = { cx: 0.55, cy: 0.93, w: 0.08, h: 0.14 }; // cut by the bottom edge

  /** Runs `seconds` of 1 Hz detector runs; `place(t)` gives the box or `null` (missed). */
  function play(
    tracker: PhoneTracker,
    seconds: number,
    place: (t: number) => Box | null,
    from = 0,
    face: Box | null = FACE,
  ): (PhoneDetection | null)[] {
    const out: (PhoneDetection | null)[] = [];
    for (let s = 0; s < seconds; s += 1) {
      const t = from + s * 1_000;
      const box = place(t);
      out.push(tracker.update(box ? [phone(box)] : [], t, face, W, H));
    }
    return out;
  }

  const inHand = (p: PhoneDetection | null): boolean =>
    p !== null && (p.nearFace || p.moving) && p.stillMs < 20_000;

  it('a new phone is not moving and not still yet', () => {
    const tracker = new PhoneTracker();
    const p = tracker.update([phone(IN_HAND)], 0, FACE, W, H)!;
    expect(p).toMatchObject({ nearFace: true, moving: false, stillMs: 0 });
    expect(tracker.update([], 1_000, FACE, W, H)).toBeNull();
  });

  it('moving: a clear move since its spot and its previous sighting', () => {
    const tracker = new PhoneTracker();
    tracker.update([phone(IN_HAND)], 0, FACE, W, H);
    const moved = tracker.update([phone({ ...IN_HAND, cx: IN_HAND.cx + 0.06 })], 1_000, FACE, W, H)!;
    expect(moved.moving).toBe(true);
    const again = tracker.update([phone({ ...IN_HAND, cx: IN_HAND.cx - 0.05 })], 2_000, FACE, W, H)!;
    expect(again.moving).toBe(true);
    expect(again.stillMs).toBe(0); // moved on twice: a new spot
    const stays = tracker.update(
      [phone({ ...IN_HAND, cx: IN_HAND.cx - 0.051 })],
      3_000,
      FACE,
      W,
      H,
    )!;
    expect(stays).toMatchObject({ moving: false, stillMs: 1_000 });
    const closer = tracker.update(
      [phone({ ...IN_HAND, cx: IN_HAND.cx - 0.05, w: 0.13, h: 0.21 })],
      4_000,
      FACE,
      W,
      H,
    )!;
    expect(closer.moving).toBe(true);
  });

  it('a jittery phone on the desk, missed half the time, is still and never in hand (10 min)', () => {
    for (const sd of [0, 1, 1.5, 2]) {
      const rng = mulberry32(17);
      const tracker = new PhoneTracker();
      const seen = play(tracker, 600, () => (rng() < 0.5 ? jitterBox(rng, DESK_NEAR, sd) : null));
      const hits = seen.filter((p): p is PhoneDetection => p !== null);
      expect(hits.length).toBeGreaterThan(250);
      expect(hits.some((p) => p.moving), `${sd} px`).toBe(false);
      // Near the face only in the first 20 s, before it counts as resting.
      const first = seen.findIndex((p) => p !== null);
      hits.forEach((p, i) => {
        const at = seen.indexOf(p);
        expect(p.stillMs, `${sd} px run ${i}`).toBe((at - first) * 1_000);
        expect(inHand(p), `${sd} px at ${at} s`).toBe(at - first < 20);
      });
    }
  });

  it('far from the face, a desk phone is never near the face, even when new', () => {
    const rng = mulberry32(3);
    const tracker = new PhoneTracker();
    const seen = play(tracker, 120, () => (rng() < 0.5 ? jitterBox(rng, ON_DESK_FAR, 1.5) : null));
    expect(seen.some(inHand)).toBe(false);
  });

  it('remembers a phone lying still across 60 s of misses, and forgets it after', () => {
    const tracker = new PhoneTracker();
    tracker.update([phone(DESK_NEAR)], 0, FACE, W, H);
    expect(tracker.update([phone(DESK_NEAR)], 55_000, FACE, W, H)!.stillMs).toBe(55_000);
    expect(tracker.update([phone(DESK_NEAR)], 115_000, FACE, W, H)!.stillMs).toBe(115_000);
    const forgotten = tracker.update([phone(DESK_NEAR)], 176_000, FACE, W, H)!;
    expect(forgotten).toMatchObject({ stillMs: 0, moving: false, nearFace: true });
  });

  it('one glitch keeps the stillness; picking the phone up restarts it', () => {
    const tracker = new PhoneTracker();
    play(tracker, 30, () => DESK_NEAR);
    const glitch = tracker.update([phone({ ...DESK_NEAR, w: 0.2, h: 0.2 })], 30_000, FACE, W, H)!;
    expect(glitch.moving).toBe(true);
    expect(glitch.stillMs).toBeGreaterThanOrEqual(20_000); // one stray sighting
    const back = tracker.update([phone(DESK_NEAR)], 31_000, FACE, W, H)!;
    expect(back).toMatchObject({ moving: false, stillMs: 31_000, nearFace: false });
    // Picked up: two clear moves in a row.
    tracker.update([phone(IN_HAND)], 32_000, FACE, W, H);
    const held = tracker.update([phone({ ...IN_HAND, cx: 0.45 })], 33_000, FACE, W, H)!;
    expect(held).toMatchObject({ moving: true, stillMs: 0, nearFace: true });
  });

  it('a box cut by the bottom edge is near the face only while it moves', () => {
    const tracker = new PhoneTracker();
    expect(tracker.update([phone(DESK_EDGE)], 0, FACE, W, H)!.nearFace).toBe(false);
    const lifted = { ...DESK_EDGE, cx: 0.45, cy: 0.9, h: 0.2 };
    const moving = tracker.update([phone(lifted)], 1_000, FACE, W, H)!;
    expect(moving).toMatchObject({ moving: true, nearFace: true });
  });

  it('a phone wobbling in the hand never counts as resting', () => {
    for (const seed of [1, 2, 3, 4]) {
      const rng = mulberry32(seed);
      const tracker = new PhoneTracker();
      const seen = play(tracker, 600, () =>
        rng() < 0.7
          ? jitterBox(rng, { ...IN_HAND, cx: FACE.cx + gaussian(rng, 0, 0.05) }, 1)
          : null,
      ).filter((p): p is PhoneDetection => p !== null);
      const share = seen.filter(inHand).length / seen.length;
      expect(share, `seed ${seed}`).toBeGreaterThan(0.95);
    }
  });

  it('two objects lying still keep their own stillness when the detector alternates', () => {
    const rng = mulberry32(8);
    const tracker = new PhoneTracker();
    const seen = play(tracker, 300, () => {
      const r = rng();
      return r < 0.35 ? jitterBox(rng, DESK_NEAR, 1) : r < 0.7 ? jitterBox(rng, ON_DESK_FAR, 1) : null;
    });
    // Telling the two apart costs at most a couple of moving sightings at the start.
    expect(seen.filter((p) => p?.moving).length).toBeLessThanOrEqual(2);
    const late = seen.slice(60).filter((p): p is PhoneDetection => p !== null);
    expect(late.length).toBeGreaterThan(120);
    expect(late.some((p) => p.moving || p.nearFace)).toBe(false);
    expect(late.every((p) => p.stillMs >= 20_000)).toBe(true);
  });

  it('reports the phone in the hand over a better-scored one on a stand', () => {
    const tracker = new PhoneTracker();
    play(tracker, 30, () => DESK_NEAR);
    const both = tracker.update(
      [phone(DESK_NEAR, 0.9), phone(IN_HAND, 0.6)],
      30_000,
      FACE,
      W,
      H,
    )!;
    expect(both).toMatchObject({ score: 0.6, nearFace: true });
    // Alone, the resting one is reported as it is.
    expect(tracker.update([phone(DESK_NEAR, 0.9)], 31_000, FACE, W, H)).toMatchObject({
      score: 0.9,
      nearFace: false,
      moving: false,
    });
  });

  it('without a face box, nothing is near the face', () => {
    const tracker = new PhoneTracker();
    expect(tracker.update([phone(IN_HAND)], 0, null, W, H)!.nearFace).toBe(false);
  });

  it('starts over when time goes backwards, and ignores a non-finite time', () => {
    const tracker = new PhoneTracker();
    play(tracker, 30, () => DESK_NEAR);
    expect(tracker.update([phone(DESK_NEAR)], 5_000, FACE, W, H)!.stillMs).toBe(0);
    expect(tracker.update([phone(DESK_NEAR)], Number.NaN, FACE, W, H)).toBeNull();
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
