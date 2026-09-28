/**
 * Object Detector result → `ObjectFeatures` (pure, DESIGN.md §5.4): the best phone, book and
 * person of each run, the phone tracker across runs and the 4 s hold between runs.
 */
import type {
  Box,
  CategoryLike,
  DetectionResultLike,
  ObjectDetection,
  ObjectFeatures,
  PhoneDetection,
} from '../types';
import { clamp01 } from '../util/math';
import {
  MIN_PERSON_AREA,
  MIN_PHONE_AREA,
  OBJECT_CATEGORIES,
  PHONE_MOVE_AREA,
  PHONE_MOVE_DIAG,
  PHONE_NEAR_DOWN,
  PHONE_NEAR_UP,
  PHONE_NEAR_X,
  PHONE_STILL_IOU,
  PHONE_TRACK_MS,
  type ObjectCategory,
} from './constants';
import { boxArea, boxFromPixels, boxIou, boxesOverlap } from './geometry';

export interface ObjectRun {
  phone: ObjectDetection | null;
  book: ObjectDetection | null;
  person: ObjectDetection | null;
}

const isCategory = (name: unknown): name is ObjectCategory =>
  typeof name === 'string' && (OBJECT_CATEGORIES as readonly string[]).includes(name);

/** Best allowed category of one detection above the threshold, or `null`. */
function bestCategory(
  categories: ArrayLike<CategoryLike> | null | undefined,
  threshold: number,
): { name: ObjectCategory; score: number } | null {
  if (!categories || typeof categories.length !== 'number') return null;
  let best: { name: ObjectCategory; score: number } | null = null;
  for (let i = 0; i < categories.length; i += 1) {
    const c = categories[i];
    if (!c || !isCategory(c.categoryName)) continue;
    const score = c.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < threshold) continue;
    if (best === null || score > best.score) best = { name: c.categoryName, score };
  }
  return best;
}

/**
 * Keeps the best `cell phone` with area ≥ 0.4 %, the best `book` and the best `person` with
 * area ≥ 5 % of the frame. Every other label, a missing box or a low score is ignored.
 */
export function selectObjects(
  result: DetectionResultLike | null | undefined,
  width: number,
  height: number,
  threshold: number,
): ObjectRun {
  const run: ObjectRun = { phone: null, book: null, person: null };
  const detections = result?.detections;
  if (!detections || typeof detections.length !== 'number') return run;
  for (let i = 0; i < detections.length; i += 1) {
    const d = detections[i];
    if (!d) continue;
    const category = bestCategory(d.categories, threshold);
    const bb = d.boundingBox;
    if (category === null || !bb) continue;
    const box = boxFromPixels(bb.originX, bb.originY, bb.width, bb.height, width, height);
    if (box === null) continue;
    const found: ObjectDetection = { score: clamp01(category.score), box };
    if (category.name === 'cell phone') {
      if (boxArea(box) < MIN_PHONE_AREA) continue;
      if (run.phone === null || found.score > run.phone.score) run.phone = found;
    } else if (category.name === 'book') {
      if (run.book === null || found.score > run.book.score) run.book = found;
    } else {
      if (boxArea(box) < MIN_PERSON_AREA) continue;
      if (run.person === null || found.score > run.person.score) run.person = found;
    }
  }
  return run;
}

/** Centre within cx ± 2.5·w and cy − 0.5·h … cy + 3·h of the face box, or overlapping it. */
export function isNearFace(phone: Box, face: Box): boolean {
  const inX = Math.abs(phone.cx - face.cx) <= PHONE_NEAR_X * face.w;
  const inY =
    phone.cy >= face.cy - PHONE_NEAR_UP * face.h && phone.cy <= face.cy + PHONE_NEAR_DOWN * face.h;
  return (inX && inY) || boxesOverlap(phone, face);
}

interface PhoneSighting {
  box: Box;
  at: number;
  stillMs: number;
}

/**
 * Follows the phone box across detector runs. `moving`: the centre moved more than 0.25 ×
 * the box diagonal (in pixels) or the area changed more than 30 % since the previous
 * sighting. `stillMs` grows while IoU ≥ 0.8 with it. A phone missed for a few runs (≤ 5 s)
 * is compared with its last sighting, so detector flicker does not reset a desk phone.
 */
export class PhoneTracker {
  private last: PhoneSighting | null = null;

  update(
    phone: ObjectDetection | null,
    ranAt: number,
    face: Box | null,
    width: number,
    height: number,
  ): PhoneDetection | null {
    if (this.last !== null && !(ranAt - this.last.at <= PHONE_TRACK_MS)) this.last = null;
    if (phone === null) return null;

    const ref = this.last;
    let moving = false;
    let stillMs = 0;
    if (ref !== null) {
      const dx = (phone.box.cx - ref.box.cx) * width;
      const dy = (phone.box.cy - ref.box.cy) * height;
      const diag = Math.hypot(phone.box.w * width, phone.box.h * height);
      const refArea = boxArea(ref.box);
      const areaChange = refArea > 0 ? Math.abs(boxArea(phone.box) - refArea) / refArea : 1;
      moving = Math.hypot(dx, dy) > PHONE_MOVE_DIAG * diag || areaChange > PHONE_MOVE_AREA;
      if (boxIou(phone.box, ref.box) >= PHONE_STILL_IOU) {
        stillMs = ref.stillMs + Math.max(0, ranAt - ref.at);
      }
    }
    this.last = { box: phone.box, at: ranAt, stillMs };
    return {
      score: phone.score,
      box: phone.box,
      nearFace: face !== null && isNearFace(phone.box, face),
      moving,
      stillMs,
    };
  }

  reset(): void {
    this.last = null;
  }
}

/**
 * The latest detector values, held between runs with `fresh: false` and a growing `ageMs`;
 * `null` once older than the hold time.
 */
export class ObjectHold {
  private latest: ObjectFeatures | null = null;

  /** Records a run on this frame and returns it (`fresh: true`, `ageMs: 0`). */
  ran(t: number, run: Omit<ObjectFeatures, 'ranAt' | 'ageMs' | 'fresh'>): ObjectFeatures {
    this.latest = { ranAt: t, ageMs: 0, fresh: true, ...run };
    return this.latest;
  }

  /** The held values at `t`, or `null` after `holdMs` (or before any run). */
  at(t: number, holdMs: number): ObjectFeatures | null {
    const latest = this.latest;
    if (latest === null) return null;
    const age = t - latest.ranAt;
    if (!(age <= holdMs)) {
      this.latest = null;
      return null;
    }
    return { ...latest, ageMs: Math.max(0, age), fresh: false };
  }

  reset(): void {
    this.latest = null;
  }
}
