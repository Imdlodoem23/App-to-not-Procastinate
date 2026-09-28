/**
 * Classifier vector x and its expansion φ(x) (owner: LEARNING). DESIGN.md §6.5.
 *
 * x (16): face, dyaw, dpitch, droll, gazeX, gazeY(=lookUp−lookDown), dcx, dcy, logScale,
 * blink, phone, phone·phoneNear, phone·phoneMoving, book, person, (1−face)·person.
 * φ: robust-standardised x (clipped, face-dependent entries × face), dyaw², dpitch²,
 * dyaw·dpitch and K ≤ 4 RBF bumps over the standardised (dyaw, dpitch, gazeX).
 */
import type { FaceFeatures, FeatureRow, RelativePose, ScreenBaseline } from '../types';
import { clamp, iqr, median } from '../util/math';
import {
  ANGLE_ENTRIES,
  FACE_DEPENDENT,
  QUAD_DIVISOR,
  RBF_ENTRIES,
  SCALE_FLOOR_ANGLE,
  SCALE_FLOOR_FACE,
  SCALE_FLOOR_SCORE,
  XI,
  X_DIM,
  Z_CLIP,
  phiDim,
} from './constants';
import { COL } from './rows';

/** Angle offsets added to the baseline (the personal classifier's slow drift). */
export interface PoseDrift {
  yaw: number;
  pitch: number;
  roll: number;
}

export const NO_DRIFT: Readonly<PoseDrift> = Object.freeze({ yaw: 0, pitch: 0, roll: 0 });

/** Standardisation and RBF parameters (the numeric part of `SoftmaxModelData`). */
export interface FeatureSpace {
  center: readonly number[];
  scale: readonly number[];
  anchors: readonly (readonly number[])[];
  sigma: number;
}

/** Signed difference a − b wrapped to (−180, 180]. */
export function wrapDeg(a: number): number {
  let d = a % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

const EPS = 1e-9;

function relative(
  yaw: number,
  pitch: number,
  roll: number,
  cx: number,
  cy: number,
  h: number,
  base: ScreenBaseline,
  drift: Readonly<PoseDrift>,
): RelativePose {
  const w0 = Math.max(base.w, EPS);
  const h0 = Math.max(base.h, EPS);
  return {
    dyaw: wrapDeg(yaw - base.yaw - drift.yaw),
    dpitch: clamp(pitch - base.pitch - drift.pitch, -180, 180),
    droll: wrapDeg(roll - base.roll - drift.roll),
    dcx: (cx - base.cx) / w0,
    dcy: (cy - base.cy) / h0,
    logScale: h > EPS ? Math.log(h / h0) : 0,
  };
}

/** Relative pose of a live face (not quantised). */
export function relativeFromFace(
  face: FaceFeatures,
  base: ScreenBaseline,
  drift: Readonly<PoseDrift> = NO_DRIFT,
): RelativePose {
  const p = face.pose;
  const b = face.box;
  return relative(p.yaw, p.pitch, p.roll, b.cx, b.cy, b.h, base, drift);
}

/** Relative pose of a stored row; `null` for a face-less row. */
export function relativeFromRow(
  row: FeatureRow,
  base: ScreenBaseline,
  drift: Readonly<PoseDrift> = NO_DRIFT,
): RelativePose | null {
  if ((row[COL.face] ?? 0) < 0.5) return null;
  const v = (i: number): number => row[i] ?? 0;
  return relative(
    v(COL.yaw),
    v(COL.pitch),
    v(COL.roll),
    v(COL.cx),
    v(COL.cy),
    v(COL.h),
    base,
    drift,
  );
}

/** Writes the 16-entry classifier vector x of a row into `out`. */
export function rowToX(
  row: FeatureRow,
  base: ScreenBaseline,
  out: Float64Array,
  drift: Readonly<PoseDrift> = NO_DRIFT,
): Float64Array {
  const v = (i: number): number => {
    const x = row[i] ?? 0;
    return Number.isFinite(x) ? x : 0;
  };
  const face = v(COL.face) >= 0.5 ? 1 : 0;
  out.fill(0);
  out[XI.face] = face;
  if (face === 1) {
    const rel = relative(
      v(COL.yaw),
      v(COL.pitch),
      v(COL.roll),
      v(COL.cx),
      v(COL.cy),
      v(COL.h),
      base,
      drift,
    );
    out[XI.dyaw] = rel.dyaw;
    out[XI.dpitch] = rel.dpitch;
    out[XI.droll] = rel.droll;
    out[XI.gazeX] = v(COL.gazeX);
    out[XI.gazeY] = v(COL.lookUp) - v(COL.lookDown);
    out[XI.dcx] = rel.dcx;
    out[XI.dcy] = rel.dcy;
    out[XI.logScale] = rel.logScale;
    out[XI.blink] = v(COL.blink);
  }
  const phone = v(COL.phone);
  out[XI.phone] = phone;
  out[XI.phoneNear] = phone * v(COL.phoneNear);
  out[XI.phoneMoving] = phone * v(COL.phoneMoving);
  out[XI.book] = v(COL.book);
  const person = v(COL.person);
  out[XI.person] = person;
  out[XI.hiddenPerson] = (1 - face) * person;
  return out;
}

const FACE_DEP = new Set(FACE_DEPENDENT);
const ANGLES = new Set(ANGLE_ENTRIES);

function scaleFloor(entry: number): number {
  if (ANGLES.has(entry)) return SCALE_FLOOR_ANGLE;
  if (FACE_DEP.has(entry)) return SCALE_FLOOR_FACE;
  return SCALE_FLOOR_SCORE;
}

/**
 * Robust standardisation fitted on a set of x vectors: median and max(IQR/1.349, floor).
 * Face-dependent entries use face rows only (face-less rows hold zeros there).
 */
export function fitStandardisation(xs: readonly Float64Array[]): {
  center: number[];
  scale: number[];
} {
  const center = new Array<number>(X_DIM).fill(0);
  const scale = new Array<number>(X_DIM).fill(1);
  const faceRows = xs.filter((x) => (x[XI.face] ?? 0) === 1);
  for (let d = 0; d < X_DIM; d += 1) {
    const source = FACE_DEP.has(d) ? faceRows : xs;
    const floor = scaleFloor(d);
    if (source.length === 0) {
      scale[d] = floor;
      continue;
    }
    const col = Float64Array.from(source, (x) => x[d] ?? 0);
    const c = median(col);
    const s = iqr(col) / 1.349;
    center[d] = Number.isFinite(c) ? c : 0;
    scale[d] = Number.isFinite(s) ? Math.max(s, floor) : floor;
  }
  return { center, scale };
}

/** Standardised, clipped entry d of x (face-dependent entries are 0 without a face). */
export function standardEntry(x: Float64Array, space: FeatureSpace, d: number): number {
  const face = x[XI.face] ?? 0;
  if (FACE_DEP.has(d) && face === 0) return 0;
  const z = ((x[d] ?? 0) - (space.center[d] ?? 0)) / (space.scale[d] ?? 1);
  return clamp(Number.isFinite(z) ? z : 0, -Z_CLIP, Z_CLIP);
}

/** The standardised (dyaw, dpitch, gazeX) point used by the RBF anchors. */
export function rbfPoint(x: Float64Array, space: FeatureSpace): [number, number, number] {
  return [
    standardEntry(x, space, RBF_ENTRIES[0] as number),
    standardEntry(x, space, RBF_ENTRIES[1] as number),
    standardEntry(x, space, RBF_ENTRIES[2] as number),
  ];
}

/** Writes φ(x) into `out` (length `phiDim(anchors)`); returns `out`. */
export function expand(x: Float64Array, space: FeatureSpace, out: Float64Array): Float64Array {
  const face = x[XI.face] === 1 ? 1 : 0;
  for (let d = 0; d < X_DIM; d += 1) out[d] = standardEntry(x, space, d);
  const zy = out[XI.dyaw] as number;
  const zp = out[XI.dpitch] as number;
  out[X_DIM] = (zy * zy) / QUAD_DIVISOR;
  out[X_DIM + 1] = (zp * zp) / QUAD_DIVISOR;
  out[X_DIM + 2] = (zy * zp) / QUAD_DIVISOR;
  const k = space.anchors.length;
  if (k > 0) {
    const zg = out[XI.gazeX] as number;
    const inv = 1 / (2 * space.sigma * space.sigma);
    for (let a = 0; a < k; a += 1) {
      const anchor = space.anchors[a] as readonly number[];
      if (face === 0) {
        out[X_DIM + 3 + a] = 0;
        continue;
      }
      const dy = zy - (anchor[0] ?? 0);
      const dp = zp - (anchor[1] ?? 0);
      const dg = zg - (anchor[2] ?? 0);
      out[X_DIM + 3 + a] = Math.exp(-(dy * dy + dp * dp + dg * dg) * inv);
    }
  }
  return out;
}

/** Allocates a φ buffer for this space. */
export function phiBuffer(space: FeatureSpace): Float64Array {
  return new Float64Array(phiDim(space.anchors.length));
}
