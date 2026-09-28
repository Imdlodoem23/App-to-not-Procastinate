/**
 * Object Detector result → `ObjectFeatures` (pure, DESIGN.md §5.4): the phones, book and
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
  PHONE_BOTTOM_EDGE_PX,
  PHONE_MAX_TRACKS,
  PHONE_MEMORY_MS,
  PHONE_MOVE_AREA,
  PHONE_MOVE_DIAG,
  PHONE_NEAR_BELOW,
  PHONE_NEAR_UP,
  PHONE_NEAR_X,
  PHONE_RESTING_MS,
  PHONE_SPOT_AREA,
  PHONE_SPOT_DIAG,
  PHONE_SPOT_EDGE_PX,
  PHONE_SPOT_MIN_PX,
  PHONE_SPOT_SETTLE_SIGHTINGS,
  PHONE_STRAY_LIMIT,
  PHONE_STRAY_WINDOW,
  PHONE_TRACK_MS,
  type ObjectCategory,
} from './constants';
import { boxArea, boxFromPixels, boxesOverlap } from './geometry';

export interface ObjectRun {
  /** The best phone (highest score), or `null`. */
  phone: ObjectDetection | null;
  /** Every phone that passed the gates, best first: the tracker follows each of them. */
  phones: ObjectDetection[];
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
 * Keeps every `cell phone` with area ≥ 0.4 % (best first), the best `book` and the best
 * `person` with area ≥ 5 % of the frame. Every other label, a missing box or a low score is
 * ignored.
 */
export function selectObjects(
  result: DetectionResultLike | null | undefined,
  width: number,
  height: number,
  threshold: number,
): ObjectRun {
  const run: ObjectRun = { phone: null, phones: [], book: null, person: null };
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
      if (boxArea(box) >= MIN_PHONE_AREA) run.phones.push(found);
    } else if (category.name === 'book') {
      if (run.book === null || found.score > run.book.score) run.book = found;
    } else {
      if (boxArea(box) < MIN_PERSON_AREA) continue;
      if (run.person === null || found.score > run.person.score) run.person = found;
    }
  }
  run.phones.sort((a, b) => b.score - a.score);
  run.phone = run.phones[0] ?? null;
  return run;
}

/**
 * The phone box overlaps the face box, or its centre is within cx ± 1.2 face widths and
 * between the top of the face and 1.5 face heights below the chin: in the hand in front of
 * the chest or at the ear. A phone lying at the side of the desk is not near.
 */
export function isNearFace(phone: Box, face: Box): boolean {
  if (boxesOverlap(phone, face)) return true;
  const inX = Math.abs(phone.cx - face.cx) <= PHONE_NEAR_X * face.w;
  const top = face.cy - PHONE_NEAR_UP * face.h;
  const bottom = face.cy + face.h / 2 + PHONE_NEAR_BELOW * face.h;
  return inX && phone.cy >= top && phone.cy <= bottom;
}

/** The box reaches the bottom edge of a `height`-pixel frame (cut by it: usually the desk). */
export function touchesBottom(box: Box, height: number): boolean {
  return box.cy + box.h / 2 >= 1 - PHONE_BOTTOM_EDGE_PX / Math.max(1, height);
}

/**
 * A phone that has not moved for 20 s: it lies on the desk or stands on a stand. It is not
 * near the face by construction, and it is no phone evidence for anyone (DECISION's
 * `PHONE_STILL_MS` and the classifier rows use the same rule).
 */
export function isResting(phone: PhoneDetection): boolean {
  return !phone.moving && phone.stillMs >= PHONE_RESTING_MS;
}

/** Centre distance in pixels. */
function pixelDistance(a: Box, b: Box, width: number, height: number): number {
  return Math.hypot((a.cx - b.cx) * width, (a.cy - b.cy) * height);
}

interface SpotTolerance {
  diag: number;
  area: number;
}

const STILL: SpotTolerance = { diag: PHONE_SPOT_DIAG, area: PHONE_SPOT_AREA };
const MOVE: SpotTolerance = { diag: PHONE_MOVE_DIAG, area: PHONE_MOVE_AREA };

function withinSpot(
  box: Box,
  ref: Box,
  width: number,
  height: number,
  tolerance: SpotTolerance,
): boolean {
  const rw = ref.w * width;
  const rh = ref.h * height;
  const reach = Math.max(PHONE_SPOT_MIN_PX, tolerance.diag * Math.hypot(rw, rh));
  if (!(pixelDistance(box, ref, width, height) <= reach)) return false;
  const refArea = rw * rh;
  const area = box.w * width * box.h * height;
  return Math.abs(area - refArea) <= tolerance.area * refArea + PHONE_SPOT_EDGE_PX * (rw + rh);
}

/**
 * `box` is still at the spot `ref`: the centre moved at most max(4 px, 0.15 × the diagonal)
 * and the area changed at most 30 %, plus 3 px of edge jitter on every side. Measured in
 * pixels, so detector jitter on a small box is not a move.
 */
export function sameSpot(box: Box, ref: Box, width: number, height: number): boolean {
  return withinSpot(box, ref, width, height, STILL);
}

/**
 * `box` moved away from `ref`: the centre moved more than max(4 px, 0.25 × the diagonal) or
 * the area changed more than 50 % (plus the same edge jitter).
 */
export function movedFrom(box: Box, ref: Box, width: number, height: number): boolean {
  return !withinSpot(box, ref, width, height, MOVE);
}

/** A place where a phone stopped. */
interface Spot {
  /** Mean of the first sightings there (fixed after a few, so it cannot drift along). */
  box: Box;
  /** When the phone arrived there. */
  since: number;
  sightings: number;
  /** The last few sightings of this track since it stopped here, one bit each: 1 = stray. */
  strays: number;
}

/** One physical phone (or phone-like object) followed across runs. */
interface Track {
  /** Where it is (or last stopped). */
  spot: Spot;
  /** A single sighting away from `spot`, not confirmed yet: a glitch or the start of a move. */
  away: Spot | null;
  lastAt: number;
  lastBox: Box;
}

/**
 * How a sighting relates to a track: still at its spot, at its pending spot (the phone
 * moved there and stopped), close to one of them but not still (`near`), or moved.
 */
type MatchKind = 'spot' | 'away' | 'near' | 'moved';

const newSpot = (box: Box, at: number): Spot => ({
  box,
  since: at,
  sightings: 1,
  strays: 0,
});

/** Folds a sighting into the spot's mean until it has settled. */
function settle(spot: Spot, box: Box): void {
  if (spot.sightings >= PHONE_SPOT_SETTLE_SIGHTINGS) return;
  const n = spot.sightings + 1;
  const mix = (a: number, b: number): number => a + (b - a) / n;
  spot.box = {
    cx: mix(spot.box.cx, box.cx),
    cy: mix(spot.box.cy, box.cy),
    w: mix(spot.box.w, box.w),
    h: mix(spot.box.h, box.h),
  };
  spot.sightings = n;
}

const HISTORY_MASK = (1 << PHONE_STRAY_WINDOW) - 1;

/** Records one sighting outcome; returns the strays among the last `PHONE_STRAY_WINDOW`. */
function recordOutcome(spot: Spot, stray: boolean): number {
  spot.strays = ((spot.strays << 1) | (stray ? 1 : 0)) & HISTORY_MASK;
  let n = 0;
  for (let bits = spot.strays; bits !== 0; bits &= bits - 1) n += 1;
  return n;
}

const restingAt = (spot: Spot, t: number): boolean => t - spot.since >= PHONE_RESTING_MS;

/**
 * Follows every phone box across detector runs (DESIGN.md §5.4).
 *
 * - `stillMs`: how long the phone has been at its spot, a pixel-tolerant anchor
 *   (`sameSpot`). A phone missed by the detector is remembered by its spot for 60 s, and a
 *   stray sighting (jitter, a glitch) does not restart it; 4 strays among its last 8
 *   sightings (a hand wobbling around one place) or two clear moves in a row do.
 * - `moving`: seen clearly away (`movedFrom`) from its spot and from where it was heading,
 *   within 5 s of its previous sighting.
 * - `nearFace`: near the user's face (`isNearFace`), not cut by the bottom edge unless it
 *   moves, and not resting (a phone still for 20 s lies on the desk or stands on a stand).
 *
 * Several objects are followed at once (a phone on a stand, a calculator, the phone in the
 * hand), so a detector that alternates between them never turns one into a moving phone.
 * The reported phone is the best one that looks in hand (near the face or moving), else the
 * best one: a phone on a stand never hides the one in the hand.
 */
export class PhoneTracker {
  private tracks: Track[] = [];

  update(
    phones: readonly ObjectDetection[],
    ranAt: number,
    face: Box | null,
    width: number,
    height: number,
  ): PhoneDetection | null {
    if (!Number.isFinite(ranAt)) return null;
    this.expire(ranAt);
    if (phones.length === 0) return null;
    const used = new Set<Track>();
    const sorted = [...phones].sort((a, b) => b.score - a.score);
    let best: PhoneDetection | null = null;
    let bestInHand = false;
    for (const phone of sorted) {
      const { moving, stillMs } = this.follow(phone.box, ranAt, used, width, height);
      const found: PhoneDetection = { ...phone, nearFace: false, moving, stillMs };
      found.nearFace =
        face !== null &&
        !isResting(found) &&
        (moving || !touchesBottom(phone.box, height)) &&
        isNearFace(phone.box, face);
      const inHand = found.nearFace || moving;
      if (best === null || (inHand && !bestInHand)) {
        best = found;
        bestInHand = inHand;
      }
    }
    this.overlapped(sorted, used);
    return best;
  }

  reset(): void {
    this.tracks = [];
  }

  /** Drops phones not seen for 60 s (and everything if time went backwards). */
  private expire(t: number): void {
    this.tracks = this.tracks.filter((k) => t >= k.lastAt && t - k.lastAt <= PHONE_MEMORY_MS);
  }

  /**
   * A track not seen in this run although a phone was seen overlapping its spot: whatever
   * stopped there is somewhere else now (one phone wobbling in the hand must not split into
   * several tracks that each look still). It strays, and is dropped once it keeps doing so.
   */
  private overlapped(phones: readonly ObjectDetection[], used: ReadonlySet<Track>): void {
    this.tracks = this.tracks.filter((track) => {
      if (used.has(track)) return true;
      if (!phones.some((p) => boxesOverlap(p.box, track.spot.box))) return true;
      return recordOutcome(track.spot, true) < PHONE_STRAY_LIMIT;
    });
  }

  /** Adds a track, dropping the least recently seen one when full. */
  private add(track: Track): void {
    if (this.tracks.length >= PHONE_MAX_TRACKS) {
      let oldest = 0;
      this.tracks.forEach((k, i) => {
        if (k.lastAt < (this.tracks[oldest] as Track).lastAt) oldest = i;
      });
      this.tracks.splice(oldest, 1);
    }
    this.tracks.push(track);
  }

  /**
   * A spot the track leaves stays followed on its own when something rested there (≥ 20 s):
   * it may be a second object the detector alternated with, or the place the phone is put
   * back. Otherwise it is forgotten.
   */
  private retire(spot: Spot, t: number): void {
    if (!restingAt(spot, t)) return;
    this.add({ spot, away: null, lastAt: t, lastBox: spot.box });
  }

  /** Assigns the sighting to a track (or starts one) and returns its motion values. */
  private follow(
    box: Box,
    t: number,
    used: Set<Track>,
    width: number,
    height: number,
  ): { moving: boolean; stillMs: number } {
    const match = this.match(box, t, used, width, height);
    if (match === null) {
      const track: Track = { spot: newSpot(box, t), away: null, lastAt: t, lastBox: box };
      this.add(track);
      used.add(track);
      return { moving: false, stillMs: 0 };
    }

    const { track, kind } = match;
    used.add(track);
    let moving = false;
    switch (kind) {
      case 'spot': {
        recordOutcome(track.spot, false);
        // Back at its spot after one sighting elsewhere: if that one did not even overlap
        // the spot, it was another object (the detector alternates between two).
        const away = track.away;
        track.away = null;
        if (away !== null && !boxesOverlap(away.box, track.spot.box)) {
          const other: Track = { spot: away, away: null, lastAt: away.since, lastBox: away.box };
          this.add(other);
          used.add(other);
        }
        break;
      }
      case 'away':
        // Seen twice at the new place: the phone moved there and stopped.
        this.retire(track.spot, t);
        track.spot = track.away as Spot;
        track.away = null;
        break;
      case 'near':
      case 'moved': {
        moving = kind === 'moved';
        // A stray sighting keeps the spot (detector jitter or a glitch), unless the phone
        // keeps leaving it (a hand wobbling around one place) or moves on a second time.
        const strays = recordOutcome(track.spot, true);
        const movesOn = moving && track.away !== null;
        if (movesOn || strays >= PHONE_STRAY_LIMIT) {
          this.retire(track.spot, t);
          track.spot = newSpot(box, t);
          track.away = null;
        } else {
          track.away = newSpot(box, t);
        }
        break;
      }
    }
    if (kind === 'spot' || kind === 'away') settle(track.spot, box);
    track.lastAt = t;
    track.lastBox = box;
    // A clear move is not at the spot: it has not been still at all.
    return { moving, stillMs: moving ? 0 : Math.max(0, t - track.spot.since) };
  }

  /**
   * The track this sighting belongs to, in order: one whose spot (or pending spot) it is
   * still at; one it is close to (a jittery box); the nearest track seen in the last 5 s (it
   * moved), preferring one that was already moving over one resting on the desk.
   */
  private match(
    box: Box,
    t: number,
    used: ReadonlySet<Track>,
    width: number,
    height: number,
  ): { track: Track; kind: MatchKind } | null {
    let best: { track: Track; kind: MatchKind } | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestCost = Number.POSITIVE_INFINITY;
    const consider = (track: Track, kind: MatchKind, rank: number, cost: number): void => {
      if (rank < bestRank || (rank === bestRank && cost < bestCost)) {
        best = { track, kind };
        bestRank = rank;
        bestCost = cost;
      }
    };
    const diagonal = Math.hypot(width, height);
    for (const track of this.tracks) {
      if (used.has(track)) continue;
      for (const [kind, spot] of [
        ['spot', track.spot],
        ['away', track.away],
      ] as const) {
        if (spot === null) continue;
        const cost = pixelDistance(box, spot.box, width, height);
        if (sameSpot(box, spot.box, width, height)) consider(track, kind, 0, cost);
        else if (!movedFrom(box, spot.box, width, height)) consider(track, 'near', 1, cost);
      }
      if (t - track.lastAt <= PHONE_TRACK_MS) {
        const resting = track.away === null && restingAt(track.spot, t);
        const cost = (resting ? diagonal : 0) + pixelDistance(box, track.lastBox, width, height);
        consider(track, 'moved', 2, cost);
      }
    }
    return best;
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
