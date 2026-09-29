/**
 * MediaPipe results → `FrameFeatures` (owner: PERCEPTION). Pure and stateful: it chooses the
 * user's face, tracks the phone box between detector runs, holds object (4 s) and luma (2 s)
 * values and computes the frame quality. DESIGN.md §5.
 *
 * Every number it returns is finite and clamped, whatever the input (NaN, Infinity, missing
 * fields): the rest of the package never has to re-check.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { Box, FrameFeatures, RawVisionInput } from '../types';
import { clamp, finiteOr } from '../util/math';
import { FACE_MEMORY_MS, MAX_FRAME_SIDE, OBJECT_DETECTOR_OPTIONS } from './constants';
import { FaceTracker } from './face';
import { isValidThumbnail, LumaTracker } from './luma';
import { ObjectHold, PhoneTracker, selectObjects } from './objects';
import { frameQuality } from './quality';

export interface FeatureExtractorOptions {
  /** Detector score threshold before any rule (0.3). */
  objectScoreThreshold?: number;
}

/** Frame sides are whole pixels in 1…16 384 (anything else is a broken input). */
function frameSide(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.min(MAX_FRAME_SIDE, Math.round(value)) : 1;
}

export class FeatureExtractor {
  private readonly threshold: number;
  private readonly face = new FaceTracker();
  private readonly phone = new PhoneTracker();
  private readonly objects = new ObjectHold();
  private readonly luma = new LumaTracker();
  private lastT = 0;

  constructor(options: FeatureExtractorOptions = {}) {
    this.threshold = clamp(
      finiteOr(options.objectScoreThreshold ?? Number.NaN, OBJECT_DETECTOR_OPTIONS.scoreThreshold),
      0,
      1,
    );
  }

  /**
   * Brightness gain the vision pipeline applies to detector inputs: 1, or up to 3 once low
   * light has lasted 5 s (DESIGN.md §5.5). Updated on every luma sample.
   */
  get lowLightGain(): number {
    return this.luma.gain;
  }

  extract(input: RawVisionInput): FrameFeatures {
    const t = Number.isFinite(input.t) ? input.t : this.lastT;
    this.lastT = t;
    const width = frameSide(input.width);
    const height = frameSide(input.height);

    const face = this.face.extract(input.face, t, width, height, FACE_MEMORY_MS);
    const faceBox = this.recentFaceBox(t);

    let objects = this.objects.at(t, STUDY_AI_CONSTANTS.objectHoldMs);
    if (input.objects !== null && input.objects !== undefined) {
      const run = selectObjects(input.objects, width, height, this.threshold);
      const phone = this.phone.update(run.phones, t, faceBox, width, height);
      objects = this.objects.ran(t, { phone, book: run.book, person: run.person });
    }

    let luma = this.luma.at(t, STUDY_AI_CONSTANTS.lumaHoldMs);
    if (isValidThumbnail(input.gray)) luma = this.luma.sample(t, input.gray, faceBox);

    return {
      t,
      width,
      height,
      face,
      objects,
      luma,
      quality: frameQuality(face, objects, luma),
    };
  }

  /** Forgets the tracked face, phone box and held values. */
  reset(): void {
    this.face.reset();
    this.phone.reset();
    this.objects.reset();
    this.luma.reset();
  }

  /** The user's face box of this frame, or the last one seen ≤ 10 s ago. */
  private recentFaceBox(t: number): Box | null {
    const box = this.face.lastBox;
    return box !== null && t - this.face.lastBoxAt <= FACE_MEMORY_MS ? box : null;
  }
}
