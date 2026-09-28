/**
 * [browser] Entry point of the hidden analysis window (owner: RUNTIME): validates
 * `AnalysisInbound` messages from main, runs one study or calibration session at a time and
 * posts `AnalysisOutbound` messages back. DESIGN.md §8.6.
 *
 * - Invalid messages → `error{invalid_message}`; nothing else happens.
 * - One job at a time: a second `session_start` / `calibration_start` → `error{busy}`.
 * - Messages for a job that is still starting are queued and replayed once it runs (or
 *   answered with `error{not_running}` if it fails to start).
 * - Messages for no job → `error{not_running}`.
 * - Only numbers, enums and the profile JSON cross IPC; never a frame.
 */
import type {
  AnalysisHost,
  AnalysisHostOptions,
  AnalysisInbound,
  AnalysisOutbound,
  CalibrationSessionHandle,
  StudySessionHandle,
} from '../types';
import { startCalibration } from './calibration-session';
import { cameraErrorCodeOf, isAbortError, isCameraOpenError, isVisionLoadError } from './errors';
import { isAnalysisInbound } from './ipc';
import { startStudySession } from './session';

type Job =
  | { kind: 'idle' }
  | { kind: 'session_starting'; queue: AnalysisInbound[] }
  | { kind: 'session'; handle: StudySessionHandle }
  | { kind: 'calibration_starting'; queue: AnalysisInbound[] }
  | { kind: 'calibration'; handle: CalibrationSessionHandle };

const SESSION_MESSAGES: ReadonlySet<AnalysisInbound['type']> = new Set([
  'context',
  'settings',
  'strike_result',
  'studying_feedback',
  'continue_without_camera',
  'resume',
  'session_stop',
]);

const CALIBRATION_MESSAGES: ReadonlySet<AnalysisInbound['type']> = new Set([
  'calibration_record',
  'calibration_cancel',
  'calibration_build',
  'calibration_close',
]);

/** Starting jobs queue at most this many messages (main sends context at 1 Hz). */
const MAX_QUEUE = 64;

export function createAnalysisHost(options: AnalysisHostOptions): AnalysisHost {
  return new Host(options);
}

class Host implements AnalysisHost {
  private readonly options: AnalysisHostOptions;
  private job: Job = { kind: 'idle' };
  private disposed = false;
  /** Settles when the job in progress has fully stopped (dispose waits for it). */
  private stopping: Promise<void> = Promise.resolve();

  constructor(options: AnalysisHostOptions) {
    this.options = options;
  }

  handle(message: unknown): void {
    if (this.disposed) return;
    if (!isAnalysisInbound(message)) {
      this.error('invalid_message');
      return;
    }
    this.dispatch(message);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.stopping;
    this.disposed = true;
    const job = this.job;
    this.job = { kind: 'idle' };
    if (job.kind === 'session') {
      this.stopping = job.handle.stop().then(
        () => undefined,
        () => undefined,
      );
    } else if (job.kind === 'calibration') {
      job.handle.close();
    }
    return this.stopping;
  }

  private post(message: AnalysisOutbound): void {
    if (this.disposed && message.type !== 'session_stopped') return;
    try {
      this.options.post(message);
    } catch {
      // The channel to main is gone; main will notice the missing heartbeats.
    }
  }

  private error(
    code: Extract<AnalysisOutbound, { type: 'error' }>['code'],
    camera: Extract<AnalysisOutbound, { type: 'error' }>['camera'] = null,
  ): void {
    this.post({ type: 'error', code, camera });
  }

  private dispatch(message: AnalysisInbound): void {
    const job = this.job;
    if (message.type === 'session_start') {
      if (job.kind !== 'idle') return this.error('busy');
      this.startSession(message);
      return;
    }
    if (message.type === 'calibration_start') {
      if (job.kind !== 'idle') return this.error('busy');
      this.startCalibration(message);
      return;
    }
    if (SESSION_MESSAGES.has(message.type)) {
      if (job.kind === 'session_starting') return this.enqueue(job.queue, message);
      if (job.kind !== 'session') return this.error('not_running');
      this.sessionMessage(job.handle, message);
      return;
    }
    if (CALIBRATION_MESSAGES.has(message.type)) {
      if (job.kind === 'calibration_starting') return this.enqueue(job.queue, message);
      if (job.kind !== 'calibration') return this.error('not_running');
      this.calibrationMessage(job.handle, message);
    }
  }

  private enqueue(queue: AnalysisInbound[], message: AnalysisInbound): void {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(message);
  }

  /** Replays what arrived while starting, or answers it when the start failed. */
  private replay(queue: readonly AnalysisInbound[], started: boolean): void {
    for (const message of queue) {
      if (started) this.dispatch(message);
      else if (message.type !== 'context' && message.type !== 'settings') {
        this.error('not_running');
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // Study session
  // -------------------------------------------------------------------------------------

  private startSession(message: Extract<AnalysisInbound, { type: 'session_start' }>): void {
    const queue: AnalysisInbound[] = [];
    this.job = { kind: 'session_starting', queue };
    startStudySession({
      mode: message.mode,
      settings: message.settings,
      profileJson: message.profileJson,
      assets: message.mode === 'camera' ? this.options.assets : null,
      cameraDeviceId: message.cameraDeviceId,
      initialContext: message.context,
      onEvent: (event) => this.post({ type: 'event', event }),
      onReport: (report) => this.post({ type: 'report', report }),
      ...(this.options.deps ? { deps: this.options.deps } : {}),
    }).then(
      (handle) => {
        if (this.disposed) {
          void handle.stop();
          return;
        }
        this.job = { kind: 'session', handle };
        this.replay(queue, true);
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.job = { kind: 'idle' };
        if (isVisionLoadError(error) && !isCameraOpenError(error)) {
          this.error('vision_failed');
        } else {
          this.error('camera_failed', cameraErrorCodeOf(error));
        }
        this.replay(queue, false);
      },
    );
  }

  private sessionMessage(handle: StudySessionHandle, message: AnalysisInbound): void {
    switch (message.type) {
      case 'context':
        handle.setContext(message.context);
        return;
      case 'settings':
        handle.setSettings(message.settings);
        return;
      case 'strike_result':
        handle.strikeResult(message.ack);
        return;
      case 'studying_feedback':
        this.post({ type: 'feedback_result', outcome: handle.studyingFeedback() });
        return;
      case 'continue_without_camera':
        // Success is announced by the session's `mode{user}` event; a refusal changes nothing.
        handle.continueWithoutCamera();
        return;
      case 'resume':
        handle.resume();
        return;
      case 'session_stop': {
        this.job = { kind: 'idle' };
        const done = handle.stop().then(
          (summary) => this.post({ type: 'session_stopped', summary }),
          () => this.error('not_running'),
        );
        this.stopping = done;
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------------------

  private startCalibration(message: Extract<AnalysisInbound, { type: 'calibration_start' }>): void {
    const queue: AnalysisInbound[] = [];
    this.job = { kind: 'calibration_starting', queue };
    startCalibration({
      assets: this.options.assets,
      profileJson: message.profileJson,
      cameraDeviceId: message.cameraDeviceId,
      onProgress: (progress) => this.post({ type: 'calibration_progress', progress }),
      ...(this.options.deps ? { deps: this.options.deps } : {}),
    }).then(
      (handle) => {
        if (this.disposed) {
          handle.close();
          return;
        }
        this.job = { kind: 'calibration', handle };
        this.replay(queue, true);
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.job = { kind: 'idle' };
        if (isCameraOpenError(error)) this.error('camera_failed', cameraErrorCodeOf(error));
        else this.error('vision_failed');
        this.replay(queue, false);
      },
    );
  }

  private calibrationMessage(handle: CalibrationSessionHandle, message: AnalysisInbound): void {
    switch (message.type) {
      case 'calibration_record':
        handle.record(message.cls).then(
          (summary) => this.post({ type: 'calibration_recorded', summary }),
          (error: unknown) => {
            // A cancelled recording is the caller's own doing; anything else is a clash.
            if (!isAbortError(error)) this.error('busy');
          },
        );
        return;
      case 'calibration_cancel':
        handle.cancel();
        return;
      case 'calibration_build':
        this.post({ type: 'calibration_built', outcome: handle.build() });
        return;
      case 'calibration_close':
        handle.close();
        this.job = { kind: 'idle' };
        return;
      default:
        return;
    }
  }
}
