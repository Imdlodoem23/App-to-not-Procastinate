/**
 * Stored row layout, schema 1 (owner: LEARNING). DESIGN.md §6.3.
 */
import type { FeatureRow, FrameFeatures } from '../types';
import { notImplemented } from '../util/not-implemented';

/** Absolute, quantised row in `FEATURE_ROW_COLUMNS` order. */
export function frameToRow(_frame: FrameFeatures): FeatureRow {
  return notImplemented('frameToRow');
}
