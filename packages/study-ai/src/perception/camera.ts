/**
 * [browser] Camera access and frame source (owner: PERCEPTION). getUserMedia at 320×240,
 * ImageCapture.grabFrame() with a detached <video> fallback; independent of page visibility.
 * DESIGN.md §5.8.
 *
 * Frames are pulled, never pushed: `next()` grabs the newest frame when the loop asks, so
 * nothing depends on rendering (no requestAnimationFrame, no requestVideoFrameCallback) and
 * the hidden analysis window keeps working. A frame lives until the loop calls `close()`.
 */
import type {
  AnalysisFrame,
  CameraDeviceInfo,
  CameraErrorCode,
  CameraIdentity,
  CameraStatus,
  FrameSource,
  OpenCameraOptions,
  TimerApi,
} from '../types';
import { REAL_TIMERS } from '../util/time';
import { sha256Hex } from './browser/hash';
import {
  CAMERA_DEFAULT_FPS,
  CAMERA_DEFAULT_HEIGHT,
  CAMERA_DEFAULT_WIDTH,
  CAMERA_MAX_FPS,
  DOWNSCALE_OVER,
  FIRST_FRAME_TIMEOUT_MS,
  FRAME_TIMEOUT_MS,
  STALL_AFTER_MS,
} from './constants';

export class CameraOpenError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CameraOpenError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------
// Browser surface (injectable for tests)
// ---------------------------------------------------------------------------------------

interface FrameGrabber {
  grabFrame(): Promise<ImageBitmap>;
}

/** What the camera needs from the browser; tests pass fakes. */
export interface CameraEnv {
  mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> | null;
  /** `ImageCapture`, or `null` to use the <video> fallback. */
  createGrabber: ((track: MediaStreamTrack) => FrameGrabber) | null;
  /** Downscales a bitmap; `null` when `createImageBitmap` is missing. */
  resize: ((bitmap: ImageBitmap, width: number, height: number) => Promise<ImageBitmap>) | null;
  createVideo: (() => HTMLVideoElement) | null;
  now(): number;
  timers: TimerApi;
  sha256Hex(text: string): Promise<string>;
}

function browserEnv(): CameraEnv {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const mediaDevices = nav?.mediaDevices?.getUserMedia ? nav.mediaDevices : null;
  return {
    mediaDevices,
    createGrabber: typeof ImageCapture === 'undefined' ? null : (track) => new ImageCapture(track),
    resize:
      typeof createImageBitmap === 'undefined'
        ? null
        : (bitmap, width, height) =>
            createImageBitmap(bitmap, {
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: 'low',
            }),
    createVideo: typeof document === 'undefined' ? null : () => document.createElement('video'),
    now: () => performance.now(),
    timers: REAL_TIMERS,
    sha256Hex: (text) => sha256Hex(text),
  };
}

// ---------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------

/** getUserMedia error → `CameraErrorCode`. OS privacy blocks surface as `in_use`/`permission_denied`; main refines them. */
export function cameraErrorCode(error: unknown): CameraErrorCode {
  const name =
    error instanceof Error || (error && typeof error === 'object' && 'name' in error)
      ? String((error as { name: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission_denied';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in_use';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'not_found';
    default:
      return 'unknown';
  }
}

type VideoConstraints = MediaTrackConstraints & { resizeMode?: ConstrainDOMString };

export function openCamera(options: OpenCameraOptions = {}): Promise<FrameSource> {
  return openCameraWith(options, browserEnv());
}

/** `openCamera` with an explicit browser surface (tests; not part of the public entry). */
export async function openCameraWith(
  options: OpenCameraOptions,
  env: CameraEnv,
): Promise<FrameSource> {
  if (env.mediaDevices === null) throw new CameraOpenError('unsupported');
  const width = positive(options.width, CAMERA_DEFAULT_WIDTH);
  const height = positive(options.height, CAMERA_DEFAULT_HEIGHT);
  const frameRate = positive(options.frameRate, CAMERA_DEFAULT_FPS);
  const video: VideoConstraints = {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: frameRate, max: Math.max(frameRate, CAMERA_MAX_FPS) },
    resizeMode: 'crop-and-scale',
  };
  if (options.deviceId) video.deviceId = { exact: options.deviceId };

  let stream: MediaStream;
  try {
    stream = await env.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    throw new CameraOpenError(cameraErrorCode(error), errorText(error));
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new CameraOpenError('not_found', 'no video track');
  }

  const source = new CameraSource(stream, track, { width, height }, env);
  try {
    await source.start();
  } catch (error) {
    source.stop();
    throw error instanceof CameraOpenError
      ? error
      : new CameraOpenError('unknown', errorText(error));
  }
  return source;
}

/** Video inputs (labels are only filled once permission was granted). */
export function listCameras(): Promise<CameraDeviceInfo[]> {
  return listCamerasWith(browserEnv());
}

export async function listCamerasWith(env: CameraEnv): Promise<CameraDeviceInfo[]> {
  if (env.mediaDevices === null) return [];
  try {
    const devices = await env.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

// ---------------------------------------------------------------------------------------
// The frame source
// ---------------------------------------------------------------------------------------

/** Resolves with the value, or `null` after `ms`; a late value is handed to `late`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timers: TimerApi,
  late: (value: T) => void,
): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const handle = timers.set(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        if (settled) {
          late(value);
          return;
        }
        settled = true;
        timers.clear(handle);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        timers.clear(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

class CameraSource implements FrameSource {
  readonly width: number;
  readonly height: number;
  private readonly grabber: FrameGrabber | null;
  private video: HTMLVideoElement | null = null;
  private readonly openedAt: number;
  private lastFrameAt: number | null = null;
  private lastVideoTime = -1;
  private stopped = false;
  private ended = false;
  private busy = false;
  private readonly onEnded = (): void => {
    this.ended = true;
  };

  constructor(
    private readonly stream: MediaStream,
    private readonly track: MediaStreamTrack,
    private readonly target: { width: number; height: number },
    private readonly env: CameraEnv,
  ) {
    this.openedAt = env.now();
    const settings = track.getSettings();
    const sw = positive(settings.width, target.width);
    const sh = positive(settings.height, target.height);
    const scale =
      sw > target.width * DOWNSCALE_OVER && env.createGrabber !== null && env.resize !== null;
    this.width = scale ? Math.round(target.width) : Math.round(sw);
    this.height = scale ? Math.max(1, Math.round((target.width * sh) / sw)) : Math.round(sh);
    this.grabber = env.createGrabber ? env.createGrabber(track) : null;
    track.addEventListener('ended', this.onEnded);
  }

  /** Starts the <video> fallback when ImageCapture is missing. */
  async start(): Promise<void> {
    if (this.grabber !== null) return;
    if (this.env.createVideo === null) throw new CameraOpenError('unsupported', 'no frame API');
    const video = this.env.createVideo();
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    this.video = video;
    await video.play();
  }

  get status(): CameraStatus {
    if (this.stopped) return 'off';
    if (this.ended || this.track.readyState === 'ended') return 'error';
    if (this.track.muted) return 'stalled';
    const now = this.env.now();
    if (this.lastFrameAt === null) {
      return now - this.openedAt > FIRST_FRAME_TIMEOUT_MS ? 'stalled' : 'starting';
    }
    return now - this.lastFrameAt > STALL_AFTER_MS ? 'stalled' : 'ok';
  }

  async next(): Promise<AnalysisFrame | null> {
    if (this.stopped || this.ended || this.busy) return null;
    this.busy = true;
    try {
      return this.grabber !== null ? await this.nextBitmap(this.grabber) : await this.nextVideo();
    } catch {
      // Muted or ending tracks reject grabFrame(); the status tells the rest.
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async nextBitmap(grabber: FrameGrabber): Promise<AnalysisFrame | null> {
    let bitmap = await withTimeout(grabber.grabFrame(), FRAME_TIMEOUT_MS, this.env.timers, (b) =>
      b.close(),
    );
    if (bitmap === null) return null;
    if (this.stopped) {
      bitmap.close();
      return null;
    }
    if (bitmap.width > this.target.width * DOWNSCALE_OVER && this.env.resize !== null) {
      const big = bitmap;
      try {
        bitmap = await this.env.resize(big, this.width, this.height);
      } finally {
        big.close();
      }
      if (this.stopped) {
        bitmap.close();
        return null;
      }
    }
    const t = this.env.now();
    this.lastFrameAt = t;
    const frameBitmap = bitmap;
    let closed = false;
    return {
      t,
      width: frameBitmap.width,
      height: frameBitmap.height,
      source: frameBitmap,
      close: () => {
        if (closed) return;
        closed = true;
        frameBitmap.close();
      },
    };
  }

  /** Fallback: the detached <video> itself is the frame (nothing to close). */
  private async nextVideo(): Promise<AnalysisFrame | null> {
    const video = this.video;
    if (video === null) return null;
    const deadline = this.env.now() + FRAME_TIMEOUT_MS;
    const POLL_MS = 40;
    while (
      !this.stopped &&
      (video.readyState < 2 || video.videoWidth === 0 || video.currentTime === this.lastVideoTime)
    ) {
      if (this.env.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        this.env.timers.set(resolve, POLL_MS);
      });
    }
    if (this.stopped) return null;
    this.lastVideoTime = video.currentTime;
    const t = this.env.now();
    this.lastFrameAt = t;
    return {
      t,
      width: video.videoWidth,
      height: video.videoHeight,
      source: video,
      close: () => {},
    };
  }

  async identity(): Promise<CameraIdentity> {
    const label = typeof this.track.label === 'string' ? this.track.label : '';
    const hex = await this.env.sha256Hex(`${label}|${this.width}x${this.height}`);
    return { key: `sha256:${hex}`, aspect: this.width / this.height };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.track.removeEventListener('ended', this.onEnded);
    stopStream(this.stream);
    if (this.video !== null) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
