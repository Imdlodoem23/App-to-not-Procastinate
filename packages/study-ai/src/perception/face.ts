/**
 * Face Landmarker result → the user's `FaceFeatures` (pure, DESIGN.md §5.3). Landmarks and
 * the 52 blendshapes are read in the frame's scope only; the tracker keeps the previous user
 * box and ~20 stable landmark positions (40 numbers) to measure continuity and jitter.
 */
import type {
  Box,
  CategoryLike,
  FaceFeatures,
  FaceLandmarkerResultLike,
  HeadPose,
  LandmarkLike,
} from '../types';
import { clamp, clamp01 } from '../util/math';
import {
  FACE_CONTINUITY_WEIGHT,
  JITTER_SAME_FACE_IOU,
  LANDMARK_MAX,
  LANDMARK_MIN,
  MIN_FACE_BOX_H,
  STABLE_LANDMARKS,
} from './constants';
import { boxArea, boxIou } from './geometry';
import { poseFromMatrix } from './pose';

// ---------------------------------------------------------------------------------------
// Blendshapes
// ---------------------------------------------------------------------------------------

export const BLENDSHAPE_NAMES = Object.freeze([
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'jawOpen',
] as const);
export type BlendshapeName = (typeof BLENDSHAPE_NAMES)[number];

export interface BlendshapeFeatures {
  blink: number;
  lookDown: number;
  lookUp: number;
  gazeX: number;
  jawOpen: number;
}

/**
 * Reads blendshapes by `categoryName`. The name → index map is built once and re-checked on
 * every read, so a different order (or a model update) rebuilds it instead of mixing values.
 */
export class BlendshapeReader {
  private index = new Map<string, number>();

  read(categories: ArrayLike<CategoryLike> | null | undefined): BlendshapeFeatures {
    const v = (name: BlendshapeName): number => this.score(categories, name);
    const outL = v('eyeLookOutLeft');
    const inR = v('eyeLookInRight');
    const inL = v('eyeLookInLeft');
    const outR = v('eyeLookOutRight');
    return {
      blink: (v('eyeBlinkLeft') + v('eyeBlinkRight')) / 2,
      lookDown: (v('eyeLookDownLeft') + v('eyeLookDownRight')) / 2,
      lookUp: (v('eyeLookUpLeft') + v('eyeLookUpRight')) / 2,
      // Both eyes towards the subject's left (the image's right): same sign as yaw.
      gazeX: clamp((outL + inR - (inL + outR)) / 2, -1, 1),
      jawOpen: v('jawOpen'),
    };
  }

  /** 0 for a missing name or a non-finite score; clamped to 0–1. */
  private score(categories: ArrayLike<CategoryLike> | null | undefined, name: string): number {
    if (!categories || typeof categories.length !== 'number') return 0;
    let i = this.index.get(name);
    if (i === undefined || categories[i]?.categoryName !== name) {
      this.rebuild(categories);
      i = this.index.get(name);
      if (i === undefined) return 0;
    }
    const raw = categories[i]?.score;
    return typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : 0;
  }

  private rebuild(categories: ArrayLike<CategoryLike>): void {
    this.index.clear();
    for (let i = 0; i < categories.length; i += 1) {
      const name = categories[i]?.categoryName;
      if (typeof name === 'string' && !this.index.has(name)) this.index.set(name, i);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Landmarks: box, truncation
// ---------------------------------------------------------------------------------------

export interface LandmarkBox {
  box: Box;
  /** Share of valid landmarks outside [0, 1]. */
  truncated: number;
  /** Landmarks with finite x and y. */
  valid: number;
}

const finiteCoord = (p: LandmarkLike | undefined): p is LandmarkLike =>
  !!p &&
  typeof p.x === 'number' &&
  typeof p.y === 'number' &&
  Number.isFinite(p.x) &&
  Number.isFinite(p.y);

/** Min/max box of the landmarks (clamped to −1…2), or `null` without valid landmarks. */
export function landmarkBox(
  landmarks: ArrayLike<LandmarkLike> | null | undefined,
): LandmarkBox | null {
  if (!landmarks || typeof landmarks.length !== 'number') return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let valid = 0;
  let outside = 0;
  for (let i = 0; i < landmarks.length; i += 1) {
    const p = landmarks[i];
    if (!finiteCoord(p)) continue;
    valid += 1;
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) outside += 1;
    const x = clamp(p.x, LANDMARK_MIN, LANDMARK_MAX);
    const y = clamp(p.y, LANDMARK_MIN, LANDMARK_MAX);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (valid === 0) return null;
  return {
    box: { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY },
    truncated: outside / valid,
    valid,
  };
}

// ---------------------------------------------------------------------------------------
// Face choice and tracking
// ---------------------------------------------------------------------------------------

export interface FaceCandidate {
  index: number;
  box: Box;
  truncated: number;
  pose: HeadPose;
}

/**
 * The user's face among the detected ones: faces shorter than 8 % of the frame are ignored;
 * score = area × (1 + 2·IoU with the previous user box). No identity recognition, on purpose.
 */
export function chooseUserFace(
  candidates: readonly FaceCandidate[],
  previous: Box | null,
): FaceCandidate | null {
  let best: FaceCandidate | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (!(c.box.h >= MIN_FACE_BOX_H)) continue;
    const continuity = previous ? boxIou(c.box, previous) : 0;
    const score = boxArea(c.box) * (1 + FACE_CONTINUITY_WEIGHT * continuity);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Candidates with a valid box and pose, in detection order. */
export function faceCandidates(result: FaceLandmarkerResultLike | null | undefined): {
  detected: number;
  candidates: FaceCandidate[];
} {
  const faces = result?.faceLandmarks;
  if (!faces || typeof faces.length !== 'number') return { detected: 0, candidates: [] };
  const matrixes = result?.facialTransformationMatrixes;
  const candidates: FaceCandidate[] = [];
  let detected = 0;
  for (let i = 0; i < faces.length; i += 1) {
    const lb = landmarkBox(faces[i]);
    if (lb === null) continue;
    detected += 1;
    const matrix = matrixes && typeof matrixes.length === 'number' ? matrixes[i] : undefined;
    const pose = matrix ? poseFromMatrix(matrix) : null;
    if (pose === null) continue;
    candidates.push({ index: i, box: lb.box, truncated: lb.truncated, pose });
  }
  return { detected, candidates };
}

/** Indices used for jitter: the stable set, or the first 20 points of a smaller fixture. */
function jitterIndices(count: number): readonly number[] {
  const stable = STABLE_LANDMARKS.filter((i) => i < count);
  if (stable.length >= 3) return stable;
  return Array.from({ length: Math.min(count, STABLE_LANDMARKS.length) }, (_, i) => i);
}

/**
 * Remembers the previous user box and stable landmark positions between frames. Jitter =
 * median displacement of the stable landmarks (in pixels) / box height (in pixels).
 */
export class FaceTracker {
  private readonly blendshapes = new BlendshapeReader();
  private prevBox: Box | null = null;
  private prevPoints: Float64Array | null = null;
  private prevIndices: readonly number[] = [];

  /** Last user box seen, with its time (face choice memory, phone and motion rules). */
  lastBox: Box | null = null;
  lastBoxAt = -Infinity;

  extract(
    result: FaceLandmarkerResultLike | null | undefined,
    t: number,
    width: number,
    height: number,
    memoryMs: number,
  ): FaceFeatures | null {
    const { detected, candidates } = faceCandidates(result);
    const previous = this.lastBox !== null && t - this.lastBoxAt <= memoryMs ? this.lastBox : null;
    const user = chooseUserFace(candidates, previous);
    if (user === null) {
      this.prevBox = null;
      this.prevPoints = null;
      return null;
    }

    const landmarks = result?.faceLandmarks[user.index] as ArrayLike<LandmarkLike>;
    const indices = jitterIndices(landmarks.length);
    const points = new Float64Array(indices.length * 2);
    for (let k = 0; k < indices.length; k += 1) {
      const p = landmarks[indices[k] as number];
      points[2 * k] = finiteCoord(p) ? p.x : Number.NaN;
      points[2 * k + 1] = finiteCoord(p) ? p.y : Number.NaN;
    }
    const jitter = this.jitter(user.box, points, indices, width, height);
    this.prevBox = user.box;
    this.prevPoints = points;
    this.prevIndices = indices;
    this.lastBox = user.box;
    this.lastBoxAt = t;

    const blendshapeList = result?.faceBlendshapes;
    const categories =
      blendshapeList && typeof blendshapeList.length === 'number'
        ? blendshapeList[user.index]?.categories
        : undefined;
    const bs = this.blendshapes.read(categories);

    return {
      pose: user.pose,
      box: user.box,
      truncated: clamp01(user.truncated),
      blink: bs.blink,
      lookDown: bs.lookDown,
      lookUp: bs.lookUp,
      gazeX: bs.gazeX,
      jawOpen: bs.jawOpen,
      jitter,
      faces: Math.max(1, detected),
    };
  }

  private jitter(
    box: Box,
    points: Float64Array,
    indices: readonly number[],
    width: number,
    height: number,
  ): number {
    const prev = this.prevPoints;
    if (
      prev === null ||
      this.prevBox === null ||
      this.prevIndices.length !== indices.length ||
      this.prevIndices.some((v, i) => v !== indices[i]) ||
      boxIou(box, this.prevBox) < JITTER_SAME_FACE_IOU
    ) {
      return 0;
    }
    const boxPx = box.h * height;
    if (!(boxPx > 0)) return 0;
    const moves: number[] = [];
    for (let k = 0; k < indices.length; k += 1) {
      const dx = ((points[2 * k] as number) - (prev[2 * k] as number)) * width;
      const dy = ((points[2 * k + 1] as number) - (prev[2 * k + 1] as number)) * height;
      const d = Math.hypot(dx, dy);
      if (Number.isFinite(d)) moves.push(d);
    }
    if (moves.length === 0) return 0;
    moves.sort((a, b) => a - b);
    const mid = moves.length >> 1;
    const median =
      moves.length % 2 === 1
        ? (moves[mid] as number)
        : ((moves[mid - 1] as number) + (moves[mid] as number)) / 2;
    const value = median / boxPx;
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  reset(): void {
    this.prevBox = null;
    this.prevPoints = null;
    this.prevIndices = [];
    this.lastBox = null;
    this.lastBoxAt = -Infinity;
  }
}
