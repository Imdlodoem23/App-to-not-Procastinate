/**
 * [browser] Camera access and frame source (owner: PERCEPTION). getUserMedia at 320×240,
 * ImageCapture.grabFrame() with a detached <video> fallback; independent of page visibility.
 * DESIGN.md §5.8.
 */
import type { CameraDeviceInfo, CameraErrorCode, FrameSource, OpenCameraOptions } from '../types';
import { notImplemented } from '../util/not-implemented';

export class CameraOpenError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CameraOpenError';
    this.code = code;
  }
}

export function openCamera(_options: OpenCameraOptions = {}): Promise<FrameSource> {
  return notImplemented('openCamera');
}

/** Video inputs (labels are only filled once permission was granted). */
export function listCameras(): Promise<CameraDeviceInfo[]> {
  return notImplemented('listCameras');
}
