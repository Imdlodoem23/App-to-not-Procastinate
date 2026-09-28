/**
 * Rule-based scorer for an uncalibrated user, an unknown camera or a stale profile
 * (owner: LEARNING). Learns its baseline in the first ~20 s. DESIGN.md §6.9.
 */
import type { AttentionClassifier } from '../types';
import { notImplemented } from '../util/not-implemented';

export interface GenericClassifierOptions {
  /** Face time needed for the session baseline (20 000). */
  baselineMs?: number;
}

export function createGenericClassifier(
  _options: GenericClassifierOptions = {},
): AttentionClassifier {
  return notImplemented('createGenericClassifier');
}
