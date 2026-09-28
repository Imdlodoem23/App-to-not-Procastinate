/**
 * Profile training, serialisation and strict parsing (owner: LEARNING). DESIGN.md §6.4–6.11.
 */
import type {
  BuildProfileInput,
  BuildProfileResult,
  CalibrationProfile,
  CameraIdentity,
  ParseProfileResult,
} from '../types';
import { notImplemented } from '../util/not-implemented';

/** Current trainer version (`profile.trainer`); bump when training changes. */
export const PROFILE_TRAINER_VERSION = 1;

/** Trains a profile: baseline, thresholds, eyes, CV-selected λ, trust and report. */
export function buildProfile(_input: BuildProfileInput): BuildProfileResult {
  return notImplemented('buildProfile');
}

/** Canonical JSON (stable key order, numbers only besides fixed strings). */
export function serializeProfile(_profile: CalibrationProfile): string {
  return notImplemented('serializeProfile');
}

/** Strict: ≤ 512 KB, ≤ 5 000 rows, finite numbers, no unknown keys, known version. */
export function parseProfile(_json: string): ParseProfileResult {
  return notImplemented('parseProfile');
}

/** Same camera key (the aspect may differ by ≤ 2 %). */
export function profileMatchesCamera(
  _profile: CalibrationProfile,
  _camera: CameraIdentity,
): boolean {
  return notImplemented('profileMatchesCamera');
}
