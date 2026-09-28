/**
 * MediaPipe results → `FrameFeatures` (owner: PERCEPTION). Pure and stateful: it chooses the
 * user's face, tracks the phone box between detector runs, holds object (4 s) and luma (2 s)
 * values and computes the frame quality. DESIGN.md §5.
 */
import type { FrameFeatures, RawVisionInput } from '../types';
import { notImplemented } from '../util/not-implemented';

export interface FeatureExtractorOptions {
  /** Detector score threshold before any rule (0.3). */
  objectScoreThreshold?: number;
}

export class FeatureExtractor {
  constructor(_options: FeatureExtractorOptions = {}) {}

  extract(_input: RawVisionInput): FrameFeatures {
    return notImplemented('FeatureExtractor.extract');
  }

  /** Forgets the tracked face, phone box and held values. */
  reset(): void {
    notImplemented('FeatureExtractor.reset');
  }
}
