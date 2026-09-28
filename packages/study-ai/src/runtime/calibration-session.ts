/**
 * [browser] Calibration wizard backend (owner: RUNTIME): 4 fps, objects at 2 Hz, one
 * `CalibrationRecorder` per situation, `buildProfile` at the end. DESIGN.md §8.5.
 *
 * Runs in the hidden analysis window like the study session, so MediaPipe lives in one
 * locked-down place; the visible wizard shows its own preview and no frame crosses IPC.
 *
 * Re-recording one situation replaces that clip and keeps the previous profile's other clips
 * and feedback rows. Recording all five before building is «Recalibrar»: a clean slate that
 * drops the feedback rows. After a successful build the new profile becomes the base for the
 * next one.
 */
import { buildProfile, parseProfile, serializeProfile } from '../calibration/profile';
import { CalibrationRecorder } from '../calibration/recorder';
import { STUDY_AI_CONSTANTS } from '../config';
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
import { abortError } from './errors';
import { analyseNextFrame, FrameCadence, stepCost } from './frame-step';
import { CpuGovernor } from './governor';
import { AdaptiveLoop } from './loop';
import { resolveSessionDeps } from './session';

/** The one loop level of a recording: 4 fps, objects every 2nd frame (2 Hz). */
const CALIBRATION_LEVEL = Object.freeze({
  intervalMs: STUDY_AI_CONSTANTS.calibrationIntervalMs,
  objectEvery: STUDY_AI_CONSTANTS.calibrationObjectEvery,
});

export function startCalibration(
  options: CalibrationSessionOptions,
): Promise<CalibrationSessionHandle> {
  return CalibrationSession.open(options);
}

interface ActiveRecording {
  recorder: CalibrationRecorder;
  loop: AdaptiveLoop;
  cadence: FrameCadence;
  resolve(summary: CalibrationRecordingSummary): void;
  reject(error: Error): void;
  done: boolean;
}

class CalibrationSession implements CalibrationSessionHandle {
  private readonly options: CalibrationSessionOptions;
  private readonly deps: SessionDeps;
  private readonly source: FrameSource;
  private readonly vision: VisionPipeline;
  private readonly identity: CameraIdentity;
  private previous: CalibrationProfile | null;
  private recordings: Partial<Record<CalibrationClass, SituationRecording>> = {};
  private active: ActiveRecording | null = null;
  private closed = false;

  private constructor(
    options: CalibrationSessionOptions,
    deps: SessionDeps,
    source: FrameSource,
    vision: VisionPipeline,
    identity: CameraIdentity,
  ) {
    this.options = options;
    this.deps = deps;
    this.source = source;
    this.vision = vision;
    this.identity = identity;
    const parsed = options.profileJson !== null ? parseProfile(options.profileJson) : null;
    this.previous = parsed?.ok ? parsed.profile : null;
  }

  /** Opens camera and vision in parallel; rejects with the first failure, releasing both. */
  static async open(options: CalibrationSessionOptions): Promise<CalibrationSession> {
    const deps = resolveSessionDeps(options.deps);
    const [camera, vision] = await Promise.allSettled([
      deps.openCamera({ deviceId: options.cameraDeviceId ?? null }),
      deps.createVision(options.assets, {}),
    ]);
    if (camera.status === 'rejected' || vision.status === 'rejected') {
      if (camera.status === 'fulfilled') camera.value.stop();
      if (vision.status === 'fulfilled') vision.value.close();
      throw camera.status === 'rejected' ? camera.reason : (vision as PromiseRejectedResult).reason;
    }
    let identity: CameraIdentity;
    try {
      identity = await camera.value.identity();
    } catch (error) {
      camera.value.stop();
      vision.value.close();
      throw error;
    }
    return new CalibrationSession(options, deps, camera.value, vision.value, identity);
  }

  record(cls: CalibrationClass): Promise<CalibrationRecordingSummary> {
    if (this.closed) return Promise.reject(new Error('calibration closed'));
    if (this.active !== null) return Promise.reject(new Error('busy: a recording is running'));
    if (!CALIBRATION_CLASSES.includes(cls)) return Promise.reject(new RangeError('unknown class'));

    return new Promise<CalibrationRecordingSummary>((resolve, reject) => {
      const clock = this.deps.clock;
      const recorder = new CalibrationRecorder(cls, clock.now());
      const cadence = new FrameCadence();
      this.vision.reset();
      const governor = new CpuGovernor({}, [CALIBRATION_LEVEL]);
      const active: ActiveRecording = {
        recorder,
        cadence,
        resolve,
        reject,
        done: false,
        loop: new AdaptiveLoop(
          (now, plan) => this.step(active, now, plan),
          governor,
          clock,
          this.deps.timers,
        ),
      };
      this.active = active;
      active.loop.start();
    });
  }

  private async step(
    active: ActiveRecording,
    now: MonoMs,
    plan: LoopPlan,
  ): Promise<StepCost | null> {
    if (active.done) return null;
    const clock = this.deps.clock;
    const { recorder } = active;
    let cost: StepCost | null = null;
    let progress: CalibrationProgress;

    if (now - recorder.startedAt >= STUDY_AI_CONSTANTS.calibrationDurationMs) {
      this.finish(active, now);
      return null;
    }
    const outcome = await analyseNextFrame(
      this.source,
      this.vision,
      () => active.cadence.options(clock.now(), plan),
      () => !active.done && !this.closed,
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
    if (outcome.kind === 'failed') throw outcome.error;
    return cost;
  }

  private finish(active: ActiveRecording, now: MonoMs): void {
    if (active.done) return;
    active.done = true;
    active.loop.stop();
    if (this.active === active) this.active = null;
    const recording = active.recorder.finish(now);
    this.recordings = { ...this.recordings, [recording.cls]: recording };
    this.progress(active.recorder.progress(now));
    active.resolve({
      cls: recording.cls,
      rows: recording.rows.length,
      faceRatio: recording.faceRatio,
      issues: recording.issues,
    });
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
    active.done = true;
    active.loop.stop();
    this.active = null;
    active.reject(abortError('calibration recording cancelled'));
  }

  build(): CalibrationBuildOutcome {
    const allFive = CALIBRATION_CLASSES.every((c) => this.recordings[c] !== undefined);
    const result = buildProfile({
      recordings: this.recordings,
      previous: allFive ? null : this.previous,
      camera: this.identity,
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
    this.source.stop();
    this.vision.close();
  }
}
