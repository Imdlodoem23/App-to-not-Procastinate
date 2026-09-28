/** Frame weight q (pure, DESIGN.md §5.6). */
import type { FaceFeatures, LumaFeatures, ObjectFeatures } from '../types';
import { clamp, finiteOr } from '../util/math';
import {
  QUALITY_JITTER_CAP,
  QUALITY_JITTER_SCALE,
  QUALITY_LOW_LIGHT_PENALTY,
  QUALITY_MAX,
  QUALITY_MIN,
  QUALITY_PERSON_ONLY,
  QUALITY_TRUNCATED_WEIGHT,
} from './constants';

/**
 * - With a face: 1 − 0.5·truncated − min(0.4, jitter/0.02) − 0.2·lowLight.
 * - No face but a person: 0.6.
 * - Otherwise: 0.2.
 * Always clamped to [0.2, 1].
 */
export function frameQuality(
  face: FaceFeatures | null,
  objects: ObjectFeatures | null,
  luma: LumaFeatures | null,
): number {
  if (face !== null) {
    const truncated = finiteOr(face.truncated, 1);
    const jitter = finiteOr(face.jitter, QUALITY_JITTER_SCALE);
    const q =
      1 -
      QUALITY_TRUNCATED_WEIGHT * truncated -
      Math.min(QUALITY_JITTER_CAP, Math.max(0, jitter) / QUALITY_JITTER_SCALE) -
      (luma?.lowLight ? QUALITY_LOW_LIGHT_PENALTY : 0);
    return clamp(q, QUALITY_MIN, QUALITY_MAX);
  }
  if (objects?.person) return QUALITY_PERSON_ONLY;
  return QUALITY_MIN;
}
