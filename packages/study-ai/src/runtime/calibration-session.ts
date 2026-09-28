/**
 * [browser] Calibration wizard backend (owner: RUNTIME): 4 fps, objects at 2 Hz, one
 * `CalibrationRecorder` per situation, `buildProfile` at the end. DESIGN.md §8.5.
 */
import type { CalibrationSessionHandle, CalibrationSessionOptions } from '../types';
import { notImplemented } from '../util/not-implemented';

export function startCalibration(
  _options: CalibrationSessionOptions,
): Promise<CalibrationSessionHandle> {
  return notImplemented('startCalibration');
}
