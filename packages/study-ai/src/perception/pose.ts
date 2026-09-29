/**
 * Head pose from the Face Landmarker's facial transformation matrix (owner: PERCEPTION).
 * DESIGN.md §5.3: forward-vector method, layout auto-detect, degrees.
 *
 * MediaPipe's metric space (the camera frame of the matrix) has +X towards the image's right,
 * +Y up and +Z towards the viewer; the canonical face looks along its own +Z. So for a face
 * looking straight at the camera the rotation is the identity, and:
 * - yaw = atan2(f.x, f.z): positive when the face turns towards the image's right;
 * - pitch = atan2(f.y, hypot(f.x, f.z)): positive up, negative when writing or reading;
 * - roll: angle of the face's up vector around f, positive when it leans towards the
 *   image's right.
 * Working from the forward vector avoids Euler decomposition order and gimbal problems.
 */
import type { HeadPose, MatrixLike } from '../types';
import { DEG } from '../util/math';

type Vec3 = [number, number, number];

function normalize(x: number, y: number, z: number): Vec3 | null {
  const n = Math.hypot(x, y, z);
  if (!(n > 1e-9) || !Number.isFinite(n)) return null;
  return [x / n, y / n, z / n];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Reads the 16 values as column-major (`m[c*4+r]`). A row-major matrix is recognised by its
 * translation sitting in the last column of the rows (m3, m7, m11) instead of m12..m14, and
 * transposed. With no translation at all, column-major is assumed (MediaPipe's layout).
 */
function columnMajor(data: ArrayLike<number>): number[] | null {
  if (data.length < 16) return null;
  const m: number[] = new Array<number>(16);
  for (let i = 0; i < 16; i += 1) {
    const v = data[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    m[i] = v;
  }
  const rowMajorTranslation = Math.abs(m[3]!) + Math.abs(m[7]!) + Math.abs(m[11]!);
  const colMajorTranslation = Math.abs(m[12]!) + Math.abs(m[13]!) + Math.abs(m[14]!);
  if (rowMajorTranslation <= colMajorTranslation) return m;
  const t: number[] = new Array<number>(16);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) t[c * 4 + r] = m[r * 4 + c]!;
  return t;
}

/** `null` for a malformed matrix, NaN values or a face pointing away from the camera. */
export function poseFromMatrix(matrix: MatrixLike): HeadPose | null {
  if (matrix === null || typeof matrix !== 'object') return null;
  if (matrix.rows !== 4 || matrix.columns !== 4 || !matrix.data) return null;
  const m = columnMajor(matrix.data);
  if (m === null) return null;

  // Column 2 is the face's +Z (out of the face), column 1 its +Y (up), in camera space.
  const f = normalize(m[8]!, m[9]!, m[10]!);
  const u = normalize(m[4]!, m[5]!, m[6]!);
  if (f === null || u === null || !(f[2] > 0)) return null;

  const yaw = Math.atan2(f[0], f[2]) * DEG;
  const pitch = Math.atan2(f[1], Math.hypot(f[0], f[2])) * DEG;

  // Camera up projected on the plane facing f; roll is u's angle from it around f.
  const up0 = normalize(-f[1] * f[0], 1 - f[1] * f[1], -f[1] * f[2]);
  let roll = 0;
  if (up0 !== null) {
    const right0 = cross(up0, f);
    roll = Math.atan2(dot(u, right0), dot(u, up0)) * DEG;
  }

  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)) return null;
  return { yaw, pitch, roll };
}
