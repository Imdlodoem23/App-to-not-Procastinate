/**
 * [browser] MediaPipe loading and per-frame inference (owner: PERCEPTION). The only file that
 * imports `@mediapipe/tasks-vision` as a value, and only through a dynamic `import()`.
 * DESIGN.md §5.1–5.2.
 */
import type {
  VisionAssets,
  VisionErrorCode,
  VisionPipeline,
  VisionPipelineOptions,
} from '../types';
import { notImplemented } from '../util/not-implemented';

export class VisionLoadError extends Error {
  readonly code: VisionErrorCode;
  constructor(code: VisionErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'VisionLoadError';
    this.code = code;
  }
}

/** Loads the WASM and both models (sha256-checked, local URLs only). */
export function createVisionPipeline(
  _assets: VisionAssets,
  _options: VisionPipelineOptions = {},
): Promise<VisionPipeline> {
  return notImplemented('createVisionPipeline');
}
