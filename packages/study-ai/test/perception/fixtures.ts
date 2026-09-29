/**
 * Plain-object fixtures shaped like MediaPipe results (PERCEPTION tests only): transformation
 * matrices from known angles, landmark clouds with a known box, blendshape lists, detections
 * and grey thumbnails.
 */
import type {
  Box,
  CategoryLike,
  DetectionLike,
  FaceLandmarkerResultLike,
  GrayThumbnail,
  LandmarkLike,
  MatrixLike,
} from '../../src/types';

export const RAD = Math.PI / 180;

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3]; // rows

function mul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const at = (m: Mat3, r: number, c: number): number => (m[r] as Vec3)[c] as number;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      (out[r] as Vec3)[c] =
        at(a, r, 0) * at(b, 0, c) + at(a, r, 1) * at(b, 1, c) + at(a, r, 2) * at(b, 2, c);
    }
  }
  return out;
}

export const rotX = (a: number): Mat3 => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
export const rotY = (a: number): Mat3 => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
export const rotZ = (a: number): Mat3 => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/**
 * Head rotation composed independently of the implementation: turn (yaw about +Y), then nod
 * (pitch: positive lifts the chin), then tilt (roll). MediaPipe's metric space: +X image
 * right, +Y up, +Z towards the viewer.
 */
export function headRotation(yawDeg: number, pitchDeg: number, rollDeg: number): Mat3 {
  return mul(mul(rotY(yawDeg * RAD), rotX(-pitchDeg * RAD)), rotZ(-rollDeg * RAD));
}

export interface MatrixFixtureOptions {
  scale?: number;
  translation?: Vec3;
  layout?: 'column' | 'row';
}

/** 4×4 transform with rotation `rot` (rows), uniform scale and translation. */
export function transform(rot: Mat3, options: MatrixFixtureOptions = {}): MatrixLike {
  const s = options.scale ?? 1;
  const [tx, ty, tz] = options.translation ?? [1.5, -2, -45];
  // Row-major 4×4 first.
  const rows = [
    [rot[0][0] * s, rot[0][1] * s, rot[0][2] * s, tx],
    [rot[1][0] * s, rot[1][1] * s, rot[1][2] * s, ty],
    [rot[2][0] * s, rot[2][1] * s, rot[2][2] * s, tz],
    [0, 0, 0, 1],
  ];
  const data: number[] = [];
  if ((options.layout ?? 'column') === 'row') {
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) data.push(rows[r]![c]!);
  } else {
    for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) data.push(rows[r]![c]!);
  }
  return { rows: 4, columns: 4, data };
}

export function poseMatrix(
  yaw: number,
  pitch: number,
  roll = 0,
  options: MatrixFixtureOptions = {},
): MatrixLike {
  return transform(headRotation(yaw, pitch, roll), options);
}

// ---------------------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------------------

export const MESH_POINTS = 478;

/**
 * 478 landmarks spread on a grid that exactly spans `box` (its corners are included), so
 * the landmark box equals `box`. `shift` moves every point (normalised units).
 */
export function landmarksInBox(box: Box, shift: { dx?: number; dy?: number } = {}): LandmarkLike[] {
  const cols = 22;
  const rows = Math.ceil(MESH_POINTS / cols);
  const out: LandmarkLike[] = [];
  for (let i = 0; i < MESH_POINTS; i += 1) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({
      x: box.cx - box.w / 2 + (box.w * c) / (cols - 1) + (shift.dx ?? 0),
      y: box.cy - box.h / 2 + (box.h * Math.min(r, rows - 1)) / (rows - 1) + (shift.dy ?? 0),
      z: 0,
    });
  }
  // Make sure the far corner exists whatever the grid rounding.
  out[MESH_POINTS - 1] = {
    x: box.cx + box.w / 2 + (shift.dx ?? 0),
    y: box.cy + box.h / 2 + (shift.dy ?? 0),
    z: 0,
  };
  return out;
}

// ---------------------------------------------------------------------------------------
// Blendshapes (the 52 names of the MediaPipe model, in its order)
// ---------------------------------------------------------------------------------------

export const BLENDSHAPE_ORDER = [
  '_neutral',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
] as const;

/** All 52 categories (unset ones at 0.01), in model order unless `order` is given. */
export function blendshapes(
  values: Partial<Record<string, number>>,
  order: readonly string[] = BLENDSHAPE_ORDER,
): { categories: CategoryLike[] } {
  return {
    categories: order.map((name, index) => ({
      index,
      categoryName: name,
      displayName: '',
      score: values[name] ?? 0.01,
    })),
  };
}

export interface FaceFixture {
  box: Box;
  yaw?: number;
  pitch?: number;
  roll?: number;
  shapes?: Partial<Record<string, number>>;
  shift?: { dx?: number; dy?: number };
}

export function faceResult(faces: readonly FaceFixture[]): FaceLandmarkerResultLike {
  return {
    faceLandmarks: faces.map((f) => landmarksInBox(f.box, f.shift)),
    faceBlendshapes: faces.map((f) => blendshapes(f.shapes ?? {})),
    facialTransformationMatrixes: faces.map((f) =>
      poseMatrix(f.yaw ?? 0, f.pitch ?? 0, f.roll ?? 0),
    ),
  };
}

export const NO_FACE: FaceLandmarkerResultLike = {
  faceLandmarks: [],
  faceBlendshapes: [],
  facialTransformationMatrixes: [],
};

// ---------------------------------------------------------------------------------------
// Detections (pixel boxes, like the Object Detector)
// ---------------------------------------------------------------------------------------

export const W = 320;
export const H = 240;

/** A detection whose normalised box is `box` on a W×H frame. */
export function detection(name: string, score: number, box: Box): DetectionLike {
  return {
    categories: [{ index: 0, categoryName: name, displayName: '', score }],
    boundingBox: {
      originX: (box.cx - box.w / 2) * W,
      originY: (box.cy - box.h / 2) * H,
      width: box.w * W,
      height: box.h * H,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Grey thumbnails (32×24)
// ---------------------------------------------------------------------------------------

export function thumbnail(
  fill: (x: number, y: number) => number,
  width = 32,
  height = 24,
): GrayThumbnail {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(fill(x, y))));
  return { width, height, data };
}

/** A textured, normally lit scene (checker + gradient). */
export const scene = (offset = 0): GrayThumbnail =>
  thumbnail((x, y) => 60 + 3 * x + 2 * y + (((x + y + offset) & 1) === 0 ? 40 : 0));
