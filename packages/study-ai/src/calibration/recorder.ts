/**
 * Records one calibration situation (owner: LEARNING). DESIGN.md §6.1–6.2.
 */
import type {
  CalibrationClass,
  CalibrationProgress,
  CalibrationRecorderOptions,
  FrameFeatures,
  MonoMs,
  SituationRecording,
} from '../types';
import { notImplemented } from '../util/not-implemented';

export class CalibrationRecorder {
  constructor(
    _cls: CalibrationClass,
    _startedAt: MonoMs,
    _options: CalibrationRecorderOptions = {},
  ) {}

  /** Adds a frame (ignored while settling or after the end). */
  push(_frame: FrameFeatures): CalibrationProgress {
    return notImplemented('CalibrationRecorder.push');
  }

  progress(_now: MonoMs): CalibrationProgress {
    return notImplemented('CalibrationRecorder.progress');
  }

  /** Trims the tail, runs the per-clip checks and returns the rows. */
  finish(_now: MonoMs): SituationRecording {
    return notImplemented('CalibrationRecorder.finish');
  }
}
