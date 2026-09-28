/**
 * [browser] Calibration wizard backend (owner: RUNTIME): 4 fps, objects at 2 Hz, one
 * `CalibrationRecorder` per situation, `buildProfile` at the end. DESIGN.md §8.5.
 *
 * Runs in the hidden analysis window like the study session, so MediaPipe lives in one
 * locked-down place; the visible wizard shows its own preview and no frame crosses IPC.
 *
 * The camera is on only while a situation is being recorded: `record()` opens it and the
 * track is stopped as soon as the recording finishes or is cancelled (the vision pipeline
 * stays loaded between recordings). Nothing films the user while they read the wizard's
 * instructions, and main can show «● Cámara activa» exactly from `calibration_record` until
 * `calibration_recorded` (or the cancel, close or error).
 *
 * Re-recording one situation replaces that clip and keeps the previous profile's other clips
 * and feedback rows. Recording all five before building is «Recalibrar»: a clean slate that
 * drops the feedback rows. After a successful build the new profile becomes the base for the
 * next one. A different camera between two recordings discards the clips of the first one.
 */
import { buildProfile, parseProfile, serializeProfile } from '../calibration/profile';
import { CalibrationRecorder, issue } from '../calibration/recorder';
import { STUDY_AI_CONSTANTS } from '../config';
import { CameraOpenError } from '../perception/camera';
import { CALIBRATION_CLASSES } from '../types';
import type {
  CalibrationBuildOutcome,
  CalibrationClass,
  CalibrationProfile,
  CalibrationProgress,
  CalibrationRecordingSummary,
  CalibrationSessionHandle,
  CalibrationSessionOptions,
  CameraIdentity,
  FrameSource,
  LoopPlan,
  MonoMs,
  SessionDeps,
  SituationRecording,
  StepCost,
  VisionPipeline,
} from '../types';
import { abortError, isCameraOpenError, isVisionContextLost } from './errors';
import { analyseNextFrame, FrameCadence, stepCost } from './frame-step';
import { CpuGovernor } from './governor';
import { AdaptiveLoop } from './loop';
import { createVisionWithin, openCameraWithin, resolveSessionDeps } from './session';

/** The one loop level of a recording: 4 fps, objects every 2nd frame (2 Hz). */
const CALIBRATION_LEVEL = Object.freeze({
  intervalMs: STUDY_AI_CONSTANTS.calibrationIntervalMs,
  objectEvery: STUDY_AI_CONSTANTS.calibrationObjectEvery,
});

/** Same camera: same key and an aspect within 2 % (as `profileMatchesCamera`). */
const ASPECT_TOLERANCE = 0.02;

export function startCalibration(
  options: CalibrationSessionOptions,
): Promise<CalibrationSessionHandle> {
  return CalibrationSession.open(options);
}

interface ActiveRecording {
  cls: CalibrationClass;
  /** The camera of this recording (`null` while it opens); stopped when the recording ends. */
  source: FrameSource | null;
  /** `null` until the camera is open (the 20 s start with the first possible frame). */
  recorder: CalibrationRecorder | null;
  loop: AdaptiveLoop | null;
  cadence: FrameCadence;
  resolve(summary: CalibrationRecordingSummary): void;
  reject(error: Error): void;
  done: boolean;
}

function sameCamera(a: CameraIdentity, b: CameraIdentity): boolean {
  return a.key === b.key && a.aspect > 0 && Math.abs(b.aspect / a.aspect - 1) <= ASPECT_TOLERANCE;
}

/** Anything that is not already a camera error becomes `CameraOpenError('unknown')`. */
function asCameraError(error: unknown): Error {
  if (isCameraOpenError(error) && error instanceof Error) return error;
  return new CameraOpenError('unknown', error instanceof Error ? error.message : String(error));
}

class CalibrationSession implements CalibrationSessionHandle {
  private readonly options: CalibrationSessionOptions;
  private readonly deps: SessionDeps;
  /** `null` while a pipeline that lost its WebGL context is being rebuilt. */
  private vision: VisionPipeline | null;
  private rebuilding = false;
  /** The camera the current recordings were made with (`null` before the first one). */
  private identity: CameraIdentity | null = null;
  private previous: CalibrationProfile | null;
  private recordings: Partial<Record<CalibrationClass, SituationRecording>> = {};
  private active: ActiveRecording | null = null;
  private closed = false;

  private constructor(
    options: CalibrationSessionOptions,
    deps: SessionDeps,
    vision: VisionPipeline,
  ) {
    this.options = options;
    this.deps = deps;
    this.vision = vision;
    const parsed = options.profileJson !== null ? parseProfile(options.profileJson) : null;
    this.previous = parsed?.ok ? parsed.profile : null;
  }

  /**
   * Loads the vision pipeline (within 30 s, else `VisionLoadError`). The camera is not opened
   * here: each `record()` opens it and a camera problem surfaces as that recording's error.
   */
  static async open(options: CalibrationSessionOptions): Promise<CalibrationSession> {
    const deps = resolveSessionDeps(options.deps);
    const vision = await createVisionWithin(deps, options.assets);
    return new CalibrationSession(options, deps, vision);
  }

  record(cls: CalibrationClass): Promise<CalibrationRecordingSummary> {
    if (this.closed) return Promise.reject(new Error('calibration closed'));
    if (this.active !== null) return Promise.reject(new Error('busy: a recording is running'));
    if (!CALIBRATION_CLASSES.includes(cls)) return Promise.reject(new RangeError('unknown class'));

    return new Promise<CalibrationRecordingSummary>((resolve, reject) => {
      const active: ActiveRecording = {
        cls,
        source: null,
        recorder: null,
        loop: null,
        cadence: new FrameCadence(),
        resolve,
        reject,
        done: false,
      };
      this.active = active;
      openCameraWithin(this.deps, this.options.cameraDeviceId ?? null).then(
        (source) => void this.cameraReady(active, source),
        (error: unknown) => this.fail(active, asCameraError(error)),
      );
    });
  }

  /** The camera of a recording is open: check which camera it is, then start the clip. */
  private async cameraReady(active: ActiveRecording, source: FrameSource): Promise<void> {
    if (active.done || this.closed) {
      source.stop();
      return;
    }
    active.source = source;
    let identity: CameraIdentity;
    try {
      identity = await source.identity();
    } catch (error) {
      this.fail(active, asCameraError(error));
      return;
    }
    if (active.done || this.closed) return;
    if (this.identity !== null && !sameCamera(this.identity, identity)) {
      // Another camera: the clips recorded so far describe a different view.
      this.recordings = {};
    }
    this.identity = identity;
    this.begin(active);
  }

  private begin(active: ActiveRecording): void {
    const clock = this.deps.clock;
    active.recorder = new CalibrationRecorder(active.cls, clock.now());
    if (this.vision?.contextLost === true) this.rebuildVision();
    else this.vision?.reset();
    const governor = new CpuGovernor({}, [CALIBRATION_LEVEL]);
    active.loop = new AdaptiveLoop(
      (now, plan) => this.step(active, now, plan),
      governor,
      clock,
      this.deps.timers,
    );
    active.loop.start();
  }

  private async step(
    active: ActiveRecording,
    now: MonoMs,
    plan: LoopPlan,
  ): Promise<StepCost | null> {
    const { recorder, source } = active;
    if (active.done || recorder === null || source === null) return null;
    const clock = this.deps.clock;
    let cost: StepCost | null = null;
    let progress: CalibrationProgress;

    if (now - recorder.startedAt >= STUDY_AI_CONSTANTS.calibrationDurationMs) {
      this.finish(active, now);
      return null;
    }
    const vision = this.vision;
    const outcome =
      vision === null
        ? ({ kind: 'none' } as const)
        : await analyseNextFrame(
            source,
            vision,
            () => active.cadence.options(clock.now(), plan),
            () => !active.done && !this.closed && this.vision === vision,
          );
    if (active.done) return null;
    if (outcome.kind === 'ok') {
      const t0 = clock.now();
      active.cadence.done(t0, outcome.options);
      progress = recorder.push(outcome.result.features);
      cost = stepCost(now, outcome.result, outcome.options, clock.now() - t0);
    } else {
      progress = recorder.progress(clock.now());
    }
    this.progress(progress);
    const end = clock.now();
    if (end - recorder.startedAt >= STUDY_AI_CONSTANTS.calibrationDurationMs)
      this.finish(active, end);
    if (outcome.kind === 'failed') {
      // A lost WebGL context (GPU reset): rebuild the pipeline instead of failing every
      // frame; the recording goes on without frames for the second it takes.
      if (isVisionContextLost(outcome.error)) {
        this.rebuildVision();
        return null;
      }
      throw outcome.error;
    }
    return cost;
  }

  /** Replaces a pipeline whose WebGL context was lost (a failed rebuild leaves no frames). */
  private rebuildVision(): void {
    if (this.rebuilding || this.closed) return;
    this.rebuilding = true;
    const old = this.vision;
    this.vision = null;
    try {
      old?.close();
    } catch {
      // A pipeline on a lost context may fail to close; it holds nothing else.
    }
    createVisionWithin(this.deps, this.options.assets).then(
      (vision) => {
        this.rebuilding = false;
        if (this.closed) vision.close();
        else this.vision = vision;
      },
      () => {
        // No frames any more: the recording ends with `too_short` and the wizard says so.
        this.rebuilding = false;
      },
    );
  }

  /** Ends a recording: stops its loop and its camera. */
  private end(active: ActiveRecording): void {
    active.done = true;
    active.loop?.stop();
    if (this.active === active) this.active = null;
    const source = active.source;
    active.source = null;
    source?.stop();
  }

  private finish(active: ActiveRecording, now: MonoMs): void {
    const recorder = active.recorder;
    if (active.done || recorder === null) return;
    this.end(active);
    const recording = recorder.finish(now);
    this.recordings = { ...this.recordings, [recording.cls]: recording };
    this.progress(recorder.progress(now));
    active.resolve({
      cls: recording.cls,
      rows: recording.rows.length,
      faceRatio: recording.faceRatio,
      issues: recording.issues,
    });
  }

  /** The camera of a recording could not be opened: it rejects (the host says `camera_failed`). */
  private fail(active: ActiveRecording, error: Error): void {
    if (active.done) return;
    this.end(active);
    active.reject(error);
  }

  private progress(progress: CalibrationProgress): void {
    try {
      this.options.onProgress(progress);
    } catch {
      // A throwing listener must not stop the recording.
    }
  }

  /** Aborts the recording in progress (its promise rejects with `AbortError`). */
  cancel(): void {
    const active = this.active;
    if (active === null || active.done) return;
    this.end(active);
    active.reject(abortError('calibration recording cancelled'));
  }

  build(): CalibrationBuildOutcome {
    const identity = this.identity;
    if (identity === null) {
      // Nothing recorded in this wizard: there is no camera to build for.
      return { ok: false, issues: CALIBRATION_CLASSES.map((cls) => issue('missing', cls)) };
    }
    const allFive = CALIBRATION_CLASSES.every((c) => this.recordings[c] !== undefined);
    const result = buildProfile({
      recordings: this.recordings,
      previous: allFive ? null : this.previous,
      camera: identity,
      nowIso: this.deps.nowIso(),
    });
    if (!result.ok) return { ok: false, issues: result.issues };
    this.previous = result.profile;
    this.recordings = {};
    return {
      ok: true,
      profileJson: serializeProfile(result.profile),
      report: result.report,
      issues: result.issues,
    };
  }

  close(): void {
    if (this.closed) return;
    this.cancel();
    this.closed = true;
    this.vision?.close();
    this.vision = null;
  }
}
