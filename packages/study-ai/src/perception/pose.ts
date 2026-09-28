/**
 * Head pose from the Face Landmarker's facial transformation matrix (owner: PERCEPTION).
 * DESIGN.md §5.3: forward-vector method, layout auto-detect, degrees.
 */
import type { HeadPose, MatrixLike } from '../types';
import { notImplemented } from '../util/not-implemented';

/** `null` for a malformed matrix, NaN values or a face pointing away from the camera. */
export function poseFromMatrix(_matrix: MatrixLike): HeadPose | null {
  return notImplemented('poseFromMatrix');
}
