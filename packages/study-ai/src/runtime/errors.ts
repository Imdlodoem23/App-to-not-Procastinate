/**
 * Error classification for the facades and the analysis host (owner: RUNTIME). Pure and
 * DOM-free: it duck-types `CameraOpenError` / `VisionLoadError` (both carry a `code`) so it
 * also works with test fakes and across realms.
 */
import type { CameraErrorCode, VisionErrorCode } from '../types';

const CAMERA_CODES: ReadonlySet<string> = new Set<CameraErrorCode>([
  'permission_denied',
  'blocked_by_system',
  'not_found',
  'in_use',
  'unsupported',
  'unknown',
]);

const VISION_CODES: ReadonlySet<string> = new Set<VisionErrorCode>([
  'simd_unsupported',
  'asset_rejected',
  'hash_mismatch',
  'load_failed',
  'process_failed',
]);

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
}

function nameOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
}

/** A `CameraOpenError` (by name or by a known camera code). */
export function isCameraOpenError(error: unknown): boolean {
  const code = codeOf(error);
  return (
    nameOf(error) === 'CameraOpenError' || (typeof code === 'string' && CAMERA_CODES.has(code))
  );
}

/** A `VisionLoadError` (by name or by a known vision code). */
export function isVisionLoadError(error: unknown): boolean {
  const code = codeOf(error);
  return (
    nameOf(error) === 'VisionLoadError' || (typeof code === 'string' && VISION_CODES.has(code))
  );
}

/**
 * A `VisionLoadError` raised because the WebGL context MediaPipe runs through was lost (GPU
 * reset, resume from sleep): the pipeline must be rebuilt, the frames were not analysed.
 */
export function isVisionContextLost(error: unknown): boolean {
  return (
    isVisionLoadError(error) &&
    typeof error === 'object' &&
    error !== null &&
    (error as { contextLost?: unknown }).contextLost === true
  );
}

/** The camera error code of any error (`unknown` when it has none). */
export function cameraErrorCodeOf(error: unknown): CameraErrorCode {
  const code = codeOf(error);
  return typeof code === 'string' && CAMERA_CODES.has(code) ? (code as CameraErrorCode) : 'unknown';
}

/** An `AbortError` (a cancelled calibration recording). */
export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return nameOf(error) === 'AbortError';
}

/**
 * A vision failure worth retrying later: a load that failed or timed out, a lost WebGL context,
 * failing frames, anything unexpected. Not SIMD missing, a rejected asset or a hash mismatch:
 * those fail the same way every time.
 */
export function isRetryableVisionError(error: unknown): boolean {
  if (!isVisionLoadError(error)) return true;
  const code = codeOf(error);
  return code !== 'simd_unsupported' && code !== 'asset_rejected' && code !== 'hash_mismatch';
}

/**
 * A camera failure that may go away by itself: another app holds the camera, it is unplugged,
 * or it did not answer. Not a denied permission, an OS privacy block or a missing API.
 */
export function isRetryableCameraError(code: CameraErrorCode): boolean {
  return code === 'in_use' || code === 'not_found' || code === 'unknown';
}
