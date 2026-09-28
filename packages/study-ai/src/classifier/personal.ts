/**
 * Classifier built from a calibration profile (owner: LEARNING). DESIGN.md §6.4–6.8.
 */
import type { AttentionClassifier, CalibrationProfile } from '../types';
import { notImplemented } from '../util/not-implemented';

export function createPersonalClassifier(_profile: CalibrationProfile): AttentionClassifier {
  return notImplemented('createPersonalClassifier');
}
