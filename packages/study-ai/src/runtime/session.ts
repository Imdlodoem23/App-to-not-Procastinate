/**
 * [browser] Study session facade (owner: RUNTIME): camera + vision + classifier + engine +
 * loop + governor, or the no-camera observer; emits events at once and a report at 1 Hz.
 * Every dependency is injectable (`deps`) so tests run it in Node. DESIGN.md §8.3–8.5.
 *
 * Privacy: frames live only inside `analyseNextFrame` (closed in `finally`); the facade keeps
 * numbers only (features go to the engine, which keeps ≤ 90 s of them in memory for
 * «¡Estaba estudiando!»). Nothing here stores, copies or sends pixels.
 */
import { learnFromFeedback } from '../calibration/feedback';
import { parseProfile, profileMatchesCamera, serializeProfile } from '../calibration/profile';
import { createGenericClassifier } from '../classifier/generic';
import { createPersonalClassifier } from '../classifier/personal';
import { STUDY_AI_CONSTANTS, resolveStudyAiSettings } from '../config';
import { CameraOpenError, openCamera } from '../perception/camera';
import { createVisionPipeline, VisionLoadError } from '../perception/vision';
import { CameraObserver, type CameraObserverOptions } from '../score/camera-observer';
import { AttentionEngine } from '../state/engine';
import type {
  AttentionClassifier,
  AttentionEngineOptions,
  AttentionEvent,
  CalibrationProfile,
  CameraErrorCode,
  CameraIdentity,
  CameraStatus,
  ContextInput,
  FeedbackOutcome,
  FrameFeatures,
  FrameSource,
  LoopPlan,
  MonoMs,
  Observer,
  SessionDeps,
  SessionEvent,
  SessionLocalSummary,
  SessionReport,
  StepCost,
  StrikeAck,
  StudyAiSettings,
  StudyMode,
  StudySessionHandle,
  StudySessionOptions,
  VisionAssets,
  VisionPipeline,
} from '../types';
import { MONOTONIC_CLOCK, REAL_TIMERS } from '../util/time';
import { CAMERA_OPEN_TIMEOUT_MS, VISION_LOAD_TIMEOUT_MS, withDeadline } from './deadline';
import { cameraErrorCodeOf, isVisionContextLost } from './errors';
import { FacadeHints, mergeHints, type HintChange } from './hints';
import { analyseNextFrame, FrameCadence, stepCost } from './frame-step';
import { CpuGovernor } from './governor';
import { AdaptiveLoop } from './loop';
import { NoCameraObserver } from './no-camera';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

/** Context older than this reads as foreground `unknown` and idle `null` (phase kept). */
export const CONTEXT_STALE_MS = 5_000;
/** Consecutive `process` failures that switch the session to no-camera mode. */
export const VISION_FAILURES_TO_FALLBACK = 5;
/**
 * A lost WebGL context (GPU reset, resume from sleep) rebuilds the pipeline, which takes
 * 1–2 s. A rebuild that has not finished after this long gives up: well before the engine
 * would count 10 s without frames as absence (`cameraLostMs`).
 */
export const VISION_REBUILD_TIMEOUT_MS = 8_000;
/** A second context loss this soon after a rebuild is a broken GPU: no-camera mode. */
export const VISION_REBUILD_MIN_INTERVAL_MS = 60_000;
/** How often the optional process-CPU probe is read. */
export const CPU_PROBE_EVERY_MS = 2_000;

/**
 * Reason of the `mode{no-camera}` event when the camera cannot be opened at start. The
 * contract has no `camera_failed` reason yet (requested from the coordinator), so the start
 * fallback reuses `vision_failed` («the camera analysis is unavailable»); the `camera{error}`
 * event sent just before it carries the real cause.
 */
const CAMERA_FAILED_MODE_REASON: Extract<SessionEvent, { type: 'mode' }>['reason'] =
  'vision_failed';

/**
 * `deps.openCamera` limited to `CAMERA_OPEN_TIMEOUT_MS`: a camera that never answers rejects
 * with `CameraOpenError('unknown')`, and a stream that arrives later is stopped at once.
 */
export function openCameraWithin(deps: SessionDeps, deviceId: string | null): Promise<FrameSource> {
  let opening: Promise<FrameSource>;
  try {
    opening = deps.openCamera({ deviceId });
  } catch (error) {
    opening = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return withDeadline(
    opening,
    CAMERA_OPEN_TIMEOUT_MS,
    deps.timers,
    () => new CameraOpenError('unknown', 'the camera did not answer in time'),
    (late) => late.stop(),
  );
}

/**
 * `deps.createVision` limited to `VISION_LOAD_TIMEOUT_MS`: a load that never settles rejects
 * with `VisionLoadError('load_failed')` (the session then runs without camera), and a
 * pipeline that arrives later is closed at once.
 */
export function createVisionWithin(
  deps: SessionDeps,
  assets: VisionAssets,
): Promise<VisionPipeline> {
  let loading: Promise<VisionPipeline>;
  try {
    loading = deps.createVision(assets, {});
  } catch (error) {
    loading = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  return withDeadline(
    loading,
    VISION_LOAD_TIMEOUT_MS,
    deps.timers,
    () => new VisionLoadError('load_failed', 'the vision pipeline did not load in time'),
    (late) => late.close(),
  );
}

/** A random run id (hex), from the platform CSPRNG (never `Math.random`). */
export function randomRunId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Real dependencies with any override from `partial`. */
export function resolveSessionDeps(partial: Partial<SessionDeps> = {}): SessionDeps {
  return {
    clock: partial.clock ?? MONOTONIC_CLOCK,
    timers: partial.timers ?? REAL_TIMERS,
    createVision: partial.createVision ?? createVisionPipeline,
    openCamera: partial.openCamera ?? openCamera,
    cpuProbe: partial.cpuProbe ?? null,
    nowIso: partial.nowIso ?? ((): string => new Date().toISOString()),
    randomId: partial.randomId ?? randomRunId,
  };
}

/** The engine surface the facade uses (the real `AttentionEngine`, or a test double). */
export type EnginePort = Pick<
  AttentionEngine,
  | 'tick'
  | 'strikeResult'
  | 'feedbackEpisode'
  | 'applyFeedback'
  | 'setSettings'
  | 'setObserver'
  | 'resume'
  | 'snapshot'
  | 'totals'
  | 'timeline'
>;

/** The camera observer surface the facade uses. */
export interface CameraObserverPort extends Observer {
  readonly classifier: AttentionClassifier;
  setClassifier(classifier: AttentionClassifier): void;
}

/** DECISION's parts, injectable so the facade's wiring is testable on its own. */
export interface SessionParts {
  createEngine(options: AttentionEngineOptions): EnginePort;
  createCameraObserver(options: CameraObserverOptions): CameraObserverPort;
}

const DEFAULT_PARTS: SessionParts = {
  createEngine: (options) => new AttentionEngine(options),
  createCameraObserver: (options) => new CameraObserver(options),
};

// ---------------------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------------------

export function startStudySession(options: StudySessionOptions): Promise<StudySessionHandle> {
  return startStudySessionWith(options, {});
}

/**
 * `startStudySession` with DECISION's parts replaceable (tests; not part of the public entry).
 *
 * Main starts the analysis only after the guardian accepted the session, so a start never
 * fails for a camera or vision problem: the session runs in no-camera mode instead and reports
 * keep flowing (heartbeats too). A camera that cannot be opened (or does not answer within
 * 15 s) emits `camera{error}` then `mode{no-camera}`; a vision load that fails (or takes over
 * 30 s) emits `mode{vision_failed}` and the `vision_failed` hint.
 */
export async function startStudySessionWith(
  options: StudySessionOptions,
  parts: Partial<SessionParts>,
): Promise<StudySessionHandle> {
  const deps = resolveSessionDeps(options.deps);
  const resolvedParts: SessionParts = { ...DEFAULT_PARTS, ...parts };
  const session = new StudySession(options, deps, resolvedParts);
  try {
    await session.init();
  } catch (error) {
    session.release();
    throw error;
  }
  session.start();
  return session;
}

// ---------------------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------------------

const DEFAULT_CONTEXT: ContextInput = Object.freeze({
  phase: 'work',
  foreground: 'unknown',
  idleMs: null,
});

class StudySession implements StudySessionHandle {
  private readonly options: StudySessionOptions;
  private readonly deps: SessionDeps;
  private readonly parts: SessionParts;
  private readonly runId: string;
  private readonly startedAt: MonoMs;

  private settingsInput: Partial<StudyAiSettings>;
  private settings: Readonly<StudyAiSettings>;
  private context: ContextInput;
  private contextAt: MonoMs;

  private mode: StudyMode;
  private profile: CalibrationProfile | null = null;
  private identity: CameraIdentity | null = null;
  private engine!: EnginePort;
  private cameraObserver: CameraObserverPort | null = null;

  // Camera and vision (camera mode only).
  private source: FrameSource | null = null;
  private vision: VisionPipeline | null = null;
  private opening = false;
  /** Bumped to cancel an open in flight (stop, no-camera switch). */
  private openGeneration = 0;
  private lastOpenAt: MonoMs | null = null;
  private stalledSince: MonoMs | null = null;
  private failingSince: MonoMs | null = null;
  private lastCameraError: CameraErrorCode | null = null;
  private offerSent = false;
  private nonWorkSince: MonoMs | null = null;
  private lastCameraEvent: CameraStatus | null = null;
  private visionFailures = 0;
  /** A vision rebuild after a lost WebGL context is in flight (bumped to cancel it). */
  private rebuildGeneration = 0;
  private rebuildTimer: unknown = null;
  private lastRebuildAt: MonoMs | null = null;

  private readonly governor = new CpuGovernor();
  private readonly cadence = new FrameCadence();
  private readonly loop: AdaptiveLoop;
  private readonly hints = new FacadeHints();
  private reportHandle: unknown = null;
  private lastCpuProbeAt: MonoMs = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private summary: SessionLocalSummary | null = null;

  constructor(options: StudySessionOptions, deps: SessionDeps, parts: SessionParts) {
    this.options = options;
    this.deps = deps;
    this.parts = parts;
    this.runId = deps.randomId();
    this.startedAt = deps.clock.now();
    this.settingsInput = { ...(options.settings ?? {}) };
    this.settings = resolveStudyAiSettings(this.settingsInput);
    this.context = { ...(options.initialContext ?? DEFAULT_CONTEXT) };
    this.contextAt = this.startedAt;
    this.mode = options.mode;
    this.loop = new AdaptiveLoop(
      (now, plan) => this.step(now, plan),
      this.governor,
      deps.clock,
      deps.timers,
    );
  }

  // -------------------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------------------

  async init(): Promise<void> {
    const events: SessionEvent[] = [];
    let recalibrate = false;
    if (this.options.profileJson !== null && this.options.profileJson !== undefined) {
      const parsed = parseProfile(this.options.profileJson);
      if (parsed.ok) {
        this.profile = parsed.profile;
        if (parsed.migrated) {
          events.push({
            type: 'profile_updated',
            at: this.now(),
            profileJson: serializeProfile(parsed.profile),
            reason: 'migrated',
          });
        }
      } else {
        recalibrate = true;
      }
    }

    let observer: Observer;
    if (this.mode === 'camera') {
      const opened = await this.openCameraAndVision();
      if (opened.kind === 'camera_failed') {
        observer = this.cameraFailedFallback(events, opened.error);
      } else if (opened.kind === 'vision_failed') {
        observer = this.noCameraFallback(events);
      } else {
        const classifier = this.classifierFor(opened.identity);
        if (this.profile !== null && classifier.kind === 'generic') recalibrate = true;
        this.cameraObserver = this.parts.createCameraObserver({
          classifier,
          fallback: classifier.kind === 'personal' ? createGenericClassifier() : null,
        });
        observer = this.cameraObserver;
      }
    } else {
      observer = new NoCameraObserver();
    }

    if (recalibrate) this.hints.setSticky('recalibrate');
    this.engine = this.parts.createEngine({
      settings: this.settings,
      observer,
      startedAt: this.startedAt,
    });
    if (recalibrate)
      events.push({ type: 'hint', at: this.now(), code: 'recalibrate', active: true });
    for (const event of events) this.emit(event);
  }

  /**
   * Opens both in parallel, each within its time limit. When one fails the other is released
   * and the session starts without camera (a camera failure wins: it is the actionable one).
   */
  private async openCameraAndVision(): Promise<
    | { kind: 'ok'; identity: CameraIdentity | null }
    | { kind: 'camera_failed'; error: CameraErrorCode }
    | { kind: 'vision_failed' }
  > {
    const assets = this.options.assets;
    if (assets === null)
      throw new TypeError('startStudySession: assets are required in camera mode');
    const deviceId = this.options.cameraDeviceId ?? null;
    const [camera, vision] = await Promise.allSettled([
      openCameraWithin(this.deps, deviceId),
      createVisionWithin(this.deps, assets),
    ]);
    if (camera.status === 'rejected') {
      if (vision.status === 'fulfilled') vision.value.close();
      return { kind: 'camera_failed', error: cameraErrorCodeOf(camera.reason) };
    }
    if (vision.status === 'rejected') {
      camera.value.stop();
      return { kind: 'vision_failed' };
    }
    this.source = camera.value;
    this.vision = vision.value;
    this.lastOpenAt = this.now();
    const identity = await camera.value.identity().catch(() => null);
    this.identity = identity;
    return { kind: 'ok', identity };
  }

  private classifierFor(identity: CameraIdentity | null): AttentionClassifier {
    if (
      this.profile !== null &&
      identity !== null &&
      profileMatchesCamera(this.profile, identity)
    ) {
      return createPersonalClassifier(this.profile);
    }
    return createGenericClassifier();
  }

  /**
   * The camera could not be opened at start (in use, blocked by the OS, unplugged, or no
   * answer within 15 s). The guardian session is already running, so the analysis goes on
   * without camera instead of failing: `camera{error}` tells the UI why (it offers «Seguir sin
   * cámara» or «Terminar»), and reports and heartbeats keep flowing. Choosing no-camera mode at
   * start is always allowed, so this opens no loophole; mid-session camera failures still fail
   * closed (absence) until the user picks «Continuar sin cámara».
   */
  private cameraFailedFallback(events: SessionEvent[], error: CameraErrorCode): Observer {
    this.mode = 'no-camera';
    this.lastCameraError = error;
    this.lastCameraEvent = 'error';
    const at = this.now();
    events.push({ type: 'camera', at, status: 'error', error });
    events.push({ type: 'mode', at, mode: 'no-camera', reason: CAMERA_FAILED_MODE_REASON });
    return new NoCameraObserver();
  }

  private noCameraFallback(events: SessionEvent[]): Observer {
    this.mode = 'no-camera';
    this.hints.setSticky('vision_failed');
    const at = this.now();
    events.push({ type: 'mode', at, mode: 'no-camera', reason: 'vision_failed' });
    events.push({ type: 'hint', at, code: 'vision_failed', active: true });
    return new NoCameraObserver();
  }

  start(): void {
    this.loop.start();
    this.scheduleReport();
  }

  /** Frees the camera and vision after a failed start. */
  release(): void {
    this.stopped = true;
    this.cancelRebuild();
    this.openGeneration += 1;
    this.dropSource();
    this.vision?.close();
    this.vision = null;
  }

  // -------------------------------------------------------------------------------------
  // Loop step
  // -------------------------------------------------------------------------------------

  private async step(now: MonoMs, plan: LoopPlan): Promise<StepCost | null> {
    if (this.stopped) return null;
    if (this.mode === 'no-camera') {
      this.tick(now, null);
      return null;
    }

    const phase = this.effectiveContext(now).phase;
    if (phase !== 'work') {
      if (this.nonWorkSince === null) this.nonWorkSince = now;
      if (now - this.nonWorkSince >= STUDY_AI_CONSTANTS.breakCameraOffMs) this.cameraOffForBreak();
      this.tick(now, null);
      return null;
    }
    this.nonWorkSince = null;
    this.superviseCamera(now);

    const source = this.source;
    const vision = this.vision;
    if (source === null || vision === null || source.status === 'error') {
      this.tick(now, null);
      return null;
    }

    const outcome = await analyseNextFrame(
      source,
      vision,
      () => this.cadence.options(this.now(), plan),
      () => !this.stopped && this.source === source && this.vision === vision,
    );
    if (this.stopped) return null;

    if (outcome.kind === 'failed') {
      const at = this.now();
      if (isVisionContextLost(outcome.error)) {
        // Not a failing frame: the pipeline lost its GPU context. Rebuild it (frames are
        // not analysed meanwhile, so nothing is counted as absent).
        this.rebuildVision(at);
        this.tick(at, null);
        return null;
      }
      this.visionFailures += 1;
      if (this.visionFailures >= VISION_FAILURES_TO_FALLBACK) {
        this.switchToNoCamera('vision_failed', at);
      }
      this.tick(at, null);
      throw outcome.error;
    }
    if (outcome.kind === 'none') {
      this.tick(this.now(), null);
      return null;
    }

    this.visionFailures = 0;
    const t0 = this.now();
    this.cadence.done(t0, outcome.options);
    this.tick(t0, outcome.result.features);
    return stepCost(now, outcome.result, outcome.options, this.now() - t0);
  }

  private tick(now: MonoMs, frame: FrameFeatures | null): void {
    const context = this.effectiveContext(now);
    const out = this.engine.tick({
      now,
      phase: context.phase,
      context: { foreground: context.foreground, idleMs: context.idleMs },
      camera: this.cameraStatus(),
      frame,
    });
    for (const event of out.events) this.emit(event);
    this.updateHints(now);
  }

  // -------------------------------------------------------------------------------------
  // Camera lifecycle
  // -------------------------------------------------------------------------------------

  /** What the engine sees: the track status, or why there is no track. */
  private cameraStatus(): CameraStatus {
    if (this.mode === 'no-camera') return 'off';
    if (this.source !== null) return this.source.status;
    if (this.opening) return 'starting';
    if (this.failingSince !== null) return 'error';
    return 'off';
  }

  private superviseCamera(now: MonoMs): void {
    const source = this.source;
    if (source !== null) {
      const status = source.status;
      if (status === 'ok') {
        this.stalledSince = null;
        this.failingSince = null;
        this.lastCameraError = null;
        this.offerSent = false;
        this.emitCamera('ok', null);
      } else if (status === 'error') {
        // Track ended (unplugged, access revoked): reopen now, then every 10 s.
        this.markFailing(now);
        this.dropSource();
        this.lastOpenAt = null;
      } else if (status === 'stalled') {
        this.markFailing(now);
        if (this.stalledSince === null) this.stalledSince = now;
        if (now - this.stalledSince >= STUDY_AI_CONSTANTS.cameraRetryMs) {
          this.dropSource();
          this.lastOpenAt = null;
        }
      }
    }

    if (this.source === null) {
      if (this.opening) {
        if (this.lastOpenAt !== null && now - this.lastOpenAt >= STUDY_AI_CONSTANTS.cameraRetryMs) {
          this.markFailing(now);
        }
      } else if (
        this.lastOpenAt === null ||
        now - this.lastOpenAt >= STUDY_AI_CONSTANTS.cameraRetryMs
      ) {
        this.reopenCamera(now);
      }
    }

    if (
      this.failingSince !== null &&
      !this.offerSent &&
      now - this.failingSince >= STUDY_AI_CONSTANTS.cameraOfferNoCameraMs
    ) {
      this.offerSent = true;
      this.lastCameraEvent = 'error';
      this.emit({ type: 'camera', at: now, status: 'error', error: this.lastCameraError });
    }
  }

  private markFailing(now: MonoMs): void {
    if (this.failingSince === null) this.failingSince = now;
  }

  private dropSource(): void {
    const source = this.source;
    this.source = null;
    this.stalledSince = null;
    source?.stop();
  }

  private reopenCamera(now: MonoMs): void {
    this.opening = true;
    this.lastOpenAt = now;
    const generation = ++this.openGeneration;
    const deviceId = this.options.cameraDeviceId ?? null;
    // Limited to 15 s: a hung `getUserMedia` must not leave `opening` set for good (the 10 s
    // retries would stop); the stream of an open that answers too late is stopped.
    openCameraWithin(this.deps, deviceId).then(
      (source) => {
        if (this.stopped || generation !== this.openGeneration || this.mode !== 'camera') {
          source.stop();
          return;
        }
        this.opening = false;
        this.source = source;
        this.stalledSince = null;
        this.vision?.reset();
        this.cadence.reset();
        void this.checkIdentity(source);
      },
      (error: unknown) => {
        if (generation !== this.openGeneration) return;
        this.opening = false;
        this.lastCameraError = cameraErrorCodeOf(error);
        this.markFailing(this.now());
      },
    );
  }

  /** Another camera after a reopen (unplugged, a different one plugged): re-pick the classifier. */
  private async checkIdentity(source: FrameSource): Promise<void> {
    const identity = await source.identity().catch(() => null);
    if (this.stopped || this.source !== source || this.cameraObserver === null) return;
    const same =
      identity !== null &&
      this.identity !== null &&
      identity.key === this.identity.key &&
      Math.abs(identity.aspect / this.identity.aspect - 1) <= 0.02;
    if (same) return;
    this.identity = identity;
    const classifier = this.classifierFor(identity);
    this.cameraObserver.setClassifier(classifier);
    if (
      this.profile !== null &&
      classifier.kind === 'generic' &&
      this.hints.setSticky('recalibrate')
    ) {
      this.emit({ type: 'hint', at: this.now(), code: 'recalibrate', active: true });
    }
  }

  /** «La cámara no vigila»: the track is stopped after 10 s outside the work phase. */
  private cameraOffForBreak(): void {
    this.openGeneration += 1;
    this.opening = false;
    this.dropSource();
    this.lastOpenAt = null;
    this.failingSince = null;
    this.offerSent = false;
    this.lastCameraError = null;
    this.emitCamera('off', null);
    this.announce(this.hints.clear('camera_lost'));
  }

  private emitCamera(status: CameraStatus, error: CameraErrorCode | null): void {
    if (this.lastCameraEvent === status) return;
    this.lastCameraEvent = status;
    this.emit({ type: 'camera', at: this.now(), status, error });
  }

  /**
   * Replaces a pipeline whose WebGL context was lost (`deps.createVision`, 1–2 s). Until it
   * is back the loop ticks without frames (the engine keeps the last presence). A rebuild
   * that fails or takes over 8 s, or a second loss within 60 s, switches to no-camera mode
   * at once instead of analysing empty pixels.
   */
  private rebuildVision(now: MonoMs): void {
    if (this.stopped || this.mode !== 'camera' || this.rebuildTimer !== null) return;
    const old = this.vision;
    this.vision = null;
    try {
      old?.close();
    } catch {
      // A pipeline on a lost context may fail to close; it holds nothing else.
    }
    const assets = this.options.assets;
    const tooSoon =
      this.lastRebuildAt !== null && now - this.lastRebuildAt < VISION_REBUILD_MIN_INTERVAL_MS;
    if (assets === null || tooSoon) {
      this.switchToNoCamera('vision_failed', now);
      return;
    }
    this.lastRebuildAt = now;
    const generation = ++this.rebuildGeneration;
    const done = (): boolean => {
      if (generation !== this.rebuildGeneration) return false;
      this.rebuildGeneration += 1;
      if (this.rebuildTimer !== null) this.deps.timers.clear(this.rebuildTimer);
      this.rebuildTimer = null;
      return true;
    };
    this.rebuildTimer = this.deps.timers.set(() => {
      if (done() && !this.stopped) this.switchToNoCamera('vision_failed', this.now());
    }, VISION_REBUILD_TIMEOUT_MS);
    this.deps.createVision(assets, {}).then(
      (vision) => {
        if (!done() || this.stopped || this.mode !== 'camera') {
          vision.close();
          return;
        }
        this.vision = vision;
        this.visionFailures = 0;
        this.cadence.reset();
      },
      () => {
        if (done() && !this.stopped) this.switchToNoCamera('vision_failed', this.now());
      },
    );
  }

  private cancelRebuild(): void {
    this.rebuildGeneration += 1;
    if (this.rebuildTimer !== null) this.deps.timers.clear(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  private switchToNoCamera(reason: 'user' | 'vision_failed', now: MonoMs): void {
    if (this.mode === 'no-camera') return;
    this.mode = 'no-camera';
    this.cancelRebuild();
    this.openGeneration += 1;
    this.opening = false;
    this.dropSource();
    this.vision?.close();
    this.vision = null;
    this.failingSince = null;
    this.cameraObserver = null;
    this.engine.setObserver(new NoCameraObserver(), now);
    this.emitCamera('off', null);
    this.announce(this.hints.clear('camera_lost'));
    this.announce(this.hints.clear('over_budget'));
    if (reason === 'vision_failed' && this.hints.setSticky('vision_failed')) {
      this.emit({ type: 'hint', at: now, code: 'vision_failed', active: true });
    }
    this.emit({ type: 'mode', at: now, mode: 'no-camera', reason });
  }

  // -------------------------------------------------------------------------------------
  // Context, hints, reports
  // -------------------------------------------------------------------------------------

  private effectiveContext(now: MonoMs): ContextInput {
    if (now - this.contextAt <= CONTEXT_STALE_MS) return this.context;
    return { phase: this.context.phase, foreground: 'unknown', idleMs: null };
  }

  private updateHints(now: MonoMs): void {
    const camera = this.mode === 'camera';
    const work = this.effectiveContext(now).phase === 'work';
    const lost = camera && work && this.cameraStatus() !== 'ok';
    this.announce(this.hints.update('camera_lost', lost, now));
    const stats = this.loop.stats;
    this.announce(this.hints.update('over_budget', camera && stats.overBudget, now));
    this.announce(this.hints.update('throttled', stats.throttled, now));
  }

  private announce(change: HintChange | null): void {
    if (change !== null) {
      this.emit({ type: 'hint', at: this.now(), code: change.code, active: change.active });
    }
  }

  private scheduleReport(): void {
    if (this.stopped) return;
    this.reportHandle = this.deps.timers.set(() => {
      this.reportHandle = null;
      if (this.stopped) return;
      const now = this.now();
      this.probeCpu(now);
      this.updateHints(now);
      this.sendReport();
      this.scheduleReport();
    }, STUDY_AI_CONSTANTS.reportEveryMs);
  }

  private probeCpu(now: MonoMs): void {
    const probe = this.deps.cpuProbe;
    if (probe === null || now - this.lastCpuProbeAt < CPU_PROBE_EVERY_MS) return;
    this.lastCpuProbeAt = now;
    let pct: number | null;
    try {
      pct = probe();
    } catch {
      pct = null;
    }
    if (typeof pct === 'number' && Number.isFinite(pct)) this.governor.reportProcessCpu(pct, now);
  }

  private sendReport(): void {
    let report: SessionReport;
    try {
      report = this.report();
    } catch {
      return; // The engine could not snapshot (it will on the next tick).
    }
    try {
      this.options.onReport(report);
    } catch {
      // A throwing listener must not stop the loop.
    }
  }

  private emit(event: SessionEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // A throwing listener must not stop the loop.
    }
  }

  private now(): MonoMs {
    return this.deps.clock.now();
  }

  // -------------------------------------------------------------------------------------
  // StudySessionHandle
  // -------------------------------------------------------------------------------------

  setContext(context: ContextInput): void {
    this.context = { phase: context.phase, foreground: context.foreground, idleMs: context.idleMs };
    this.contextAt = this.now();
  }

  setSettings(settings: Partial<StudyAiSettings>): void {
    this.settingsInput = { ...this.settingsInput, ...settings };
    this.settings = resolveStudyAiSettings(this.settingsInput);
    this.engine.setSettings(this.settings);
  }

  strikeResult(ack: StrikeAck): void {
    this.engine.strikeResult(ack, this.now());
  }

  studyingFeedback(): FeedbackOutcome {
    if (this.stopped || this.mode !== 'camera' || this.cameraObserver === null) {
      return { ok: false, reason: 'no_camera' };
    }
    const profile = this.profile;
    if (profile === null || this.cameraObserver.classifier.kind !== 'personal') {
      return { ok: false, reason: 'not_calibrated' };
    }
    const now = this.now();
    const episode = this.engine.feedbackEpisode(now);
    if (!episode.ok) return { ok: false, reason: episode.reason };
    let learned: ReturnType<typeof learnFromFeedback>;
    try {
      learned = learnFromFeedback(profile, episode, {
        nowIso: this.deps.nowIso(),
        clock: this.deps.clock,
      });
    } catch {
      // A retrain that cannot run changes nothing (and never touches strikes).
      return { ok: false, reason: 'no_usable_frames' };
    }
    if (!learned.ok) return { ok: false, reason: learned.reason };

    this.profile = learned.profile;
    this.cameraObserver.setClassifier(createPersonalClassifier(learned.profile));
    const events: readonly AttentionEvent[] = this.engine.applyFeedback(now, episode.episodeId);
    for (const event of events) this.emit(event);
    this.emit({
      type: 'profile_updated',
      at: now,
      profileJson: serializeProfile(learned.profile),
      reason: 'feedback',
    });
    const doubtCleared = events.some((e) => e.type === 'doubt_cleared' && e.by === 'feedback');
    return { ok: true, added: learned.added, doubtCleared };
  }

  continueWithoutCamera(): boolean {
    if (this.stopped || this.mode !== 'camera') return false;
    // Only while the camera is failing: covering the lens (frames still arrive) never
    // qualifies, so switching modes cannot dodge a `no_face` strike.
    if (this.failingSince === null || this.cameraStatus() === 'ok') return false;
    this.switchToNoCamera('user', this.now());
    return true;
  }

  resume(): void {
    if (this.stopped) return;
    const now = this.now();
    this.engine.resume(now);
    // A suspend often resets the GPU: a pipeline whose context was lost is rebuilt now,
    // not on its next frame.
    if (this.vision?.contextLost === true) this.rebuildVision(now);
    else this.vision?.reset();
    this.cadence.reset();
    // After a suspend the track often ended or froze: restart it unless it is healthy.
    if (this.mode === 'camera' && this.source !== null && this.source.status !== 'ok') {
      this.dropSource();
      this.lastOpenAt = null;
    }
  }

  report(): SessionReport {
    const snapshot = this.engine.snapshot();
    const camera = this.cameraStatus();
    return {
      runId: this.runId,
      at: this.now(),
      mode: this.mode,
      camera,
      cameraOn: this.mode === 'camera' && this.source !== null && camera !== 'error',
      snapshot: { ...snapshot, hints: mergeHints(snapshot.hints, this.hints.active()) },
      totals: this.engine.totals(),
      loop: this.mode === 'camera' ? { ...this.loop.stats } : null,
    };
  }

  async stop(): Promise<SessionLocalSummary> {
    if (this.summary !== null) return this.summary;
    this.stopped = true;
    this.loop.stop();
    if (this.reportHandle !== null) {
      this.deps.timers.clear(this.reportHandle);
      this.reportHandle = null;
    }
    this.openGeneration += 1;
    this.opening = false;
    this.cancelRebuild();
    this.dropSource();
    this.vision?.close();
    this.vision = null;
    this.sendReport(); // Final totals, so main can close the last heartbeat interval.
    this.summary = { totals: this.engine.totals(), timeline: this.engine.timeline() };
    return this.summary;
  }
}
