/**
 * [browser] Study session facade (owner: RUNTIME): camera + vision + classifier + engine +
 * loop + governor, or the no-camera observer; emits events at once and a report at 1 Hz.
 * Every dependency is injectable (`deps`) so tests run it in Node. DESIGN.md §8.3–8.5.
 *
 * Privacy: frames live only inside `analyseNextFrame` (closed in `finally`); the facade keeps
 * numbers only (features go to the engine, which keeps ≤ 90 s of them in memory for
 * «¡Estaba estudiando!»). Nothing here stores, copies or sends pixels.
 *
 * - **Start order:** the vision pipeline loads first and the camera opens only once it is
 *   ready, so the camera is never on while MediaPipe loads (or fails to). `camera{starting}` is
 *   sent the moment the stream opens, before the first report, so main can show «● Cámara
 *   activa» at once. A session started outside `work` (a window recreated during a break or
 *   «Pausa») loads the pipeline but opens no camera until work resumes; background recoveries
 *   wait for work too: the camera is never opened outside `work`.
 * - **Which camera:** main names it by label (`cameraLabel`); it is resolved here with
 *   `enumerateDevices()` on every open, since `deviceId`s are salted per partition and run. A
 *   chosen camera that is missing falls back to the default one with the `camera_default`
 *   hint. While on the default camera the list is checked every 10 s; when the chosen camera
 *   is back it is opened and, once it works, replaces the default one (hint cleared). A chosen
 *   camera whose track ends mid-session (unplugged, a USB hub glitch, docking) is retried on
 *   its own every 2 s for 15 s before the default one is used: USB re-enumeration takes
 *   1–3 s.
 * - **Recovery:** a camera that fails at start for a reason that may pass (in use, unplugged,
 *   no answer) or a vision pipeline that fails (at start, or mid-session after one rebuild) is
 *   retried in the background after 30 s, 60 s, 2 min, then every 5 min. When it works the
 *   session goes back to camera mode with `mode{camera, recovered}`: stricter for the user, so
 *   no loophole. «Continuar sin cámara» (`continueWithoutCamera`) stops the retries.
 */
import { learnFromFeedback } from '../calibration/feedback';
import { parseProfile, profileMatchesCamera, serializeProfile } from '../calibration/profile';
import { createGenericClassifier } from '../classifier/generic';
import { createPersonalClassifier } from '../classifier/personal';
import { STUDY_AI_CONSTANTS, resolveStudyAiSettings } from '../config';
import { CameraOpenError, listCameras, openCamera } from '../perception/camera';
import { STALL_AFTER_MS } from '../perception/constants';
import { isResting } from '../perception/objects';
import { createVisionPipeline, VisionLoadError } from '../perception/vision';
import { CameraObserver, type CameraObserverOptions } from '../score/camera-observer';
import { AttentionEngine } from '../state/engine';
import type {
  AttentionClassifier,
  AttentionEngineOptions,
  AttentionEvent,
  CalibrationProfile,
  CameraDeviceInfo,
  CameraErrorCode,
  CameraIdentity,
  CameraStatus,
  ContextInput,
  ContextSignals,
  FeedbackOutcome,
  FrameFeatures,
  FrameSource,
  HintCode,
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
import {
  cameraErrorCodeOf,
  isRetryableCameraError,
  isRetryableVisionError,
  isVisionContextLost,
} from './errors';
import { FacadeHints, mergeHints, type HintChange } from './hints';
import { analyseNextFrame, discardNextFrame, FrameCadence, stepCost } from './frame-step';
import { CpuGovernor } from './governor';
import { AdaptiveLoop, type StepPlan } from './loop';
import { NoCameraObserver } from './no-camera';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

/** Context older than this reads as foreground `unknown` and idle `null` (phase kept). */
export const CONTEXT_STALE_MS = 5_000;
/**
 * Consecutive `process` failures (a WASM abort, say) that rebuild the pipeline once; the same
 * streak again without a good frame in between switches the session to no-camera mode.
 */
export const VISION_FAILURES_TO_FALLBACK = 5;
/**
 * A rebuild (lost WebGL context, failing frames) has the first load's budget: the camera keeps
 * delivering meanwhile (frames are taken and closed), so nothing reads as stalled or absent.
 */
export const VISION_REBUILD_TIMEOUT_MS = VISION_LOAD_TIMEOUT_MS;
/** A second context loss this soon after a rebuild is a broken GPU: no-camera mode (retried). */
export const VISION_REBUILD_MIN_INTERVAL_MS = 60_000;
/** How often the optional process-CPU probe is read. */
export const CPU_PROBE_EVERY_MS = 2_000;
/** A phone (not at rest) seen this recently keeps the detector at ≥ 1 Hz (the alert). */
export const PHONE_ALERT_MS = 20_000;
/** Background retries of the camera analysis; the last delay repeats until the session ends. */
export const RECOVERY_DELAYS_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000,
]);
/**
 * A chosen camera whose track ended mid-session is retried on its own (no default camera) for
 * this long: a replug or a USB hub reset re-enumerates it within 1–3 s.
 */
export const CHOSEN_CAMERA_GRACE_MS = 15_000;
/** How often the chosen camera is retried during that grace. */
export const CHOSEN_CAMERA_RETRY_MS = 2_000;
/**
 * A catalog service playing on another display (`visibleDistraction`) counts as a distraction
 * in the foreground once the keyboard and mouse have been idle this long.
 */
export const VISIBLE_DISTRACTION_IDLE_MS = 10_000;

/**
 * Reason of the `mode{no-camera}` event when the camera cannot be opened at start. The
 * contract has no `camera_failed` reason yet (requested from the coordinator), so the start
 * fallback reuses `vision_failed` («the camera analysis is unavailable»); the `camera{error}`
 * event sent just before it carries the real cause.
 */
const CAMERA_FAILED_MODE_REASON: Extract<SessionEvent, { type: 'mode' }>['reason'] =
  'vision_failed';

/** Dependencies with every optional one filled in. */
export type ResolvedSessionDeps = SessionDeps & {
  listCameras: () => Promise<readonly CameraDeviceInfo[]>;
};

/** The camera a session or calibration asked for. */
export interface CameraRequest {
  /** `CameraChoice.label` from main, or `null`. */
  label: string | null;
  /** A raw `deviceId` of this window (demo), or `null`. */
  deviceId: string | null;
}

export interface OpenedCamera {
  source: FrameSource;
  /** The chosen camera is missing: this is the default one. */
  fallback: boolean;
}

const NO_CAMERA_REQUEST: CameraRequest = Object.freeze({ label: null, deviceId: null });

function tryOpen(deps: ResolvedSessionDeps, deviceId: string | null): Promise<FrameSource> {
  try {
    return deps.openCamera({ deviceId });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

const isNotFound = (error: unknown): boolean => cameraErrorCodeOf(error) === 'not_found';

/**
 * Opens the requested camera: a raw `deviceId` first (a stale one is `not_found`), then the
 * device whose label matches, then (unless `strict`) the default camera with `fallback: true`.
 */
async function openRequested(
  deps: ResolvedSessionDeps,
  request: CameraRequest,
  strict: boolean,
): Promise<OpenedCamera> {
  if (request.deviceId) {
    try {
      return { source: await tryOpen(deps, request.deviceId), fallback: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (request.label) {
    const devices = await deps.listCameras().catch((): readonly CameraDeviceInfo[] => []);
    const match = devices.find((d) => d.label === request.label && d.deviceId !== '');
    if (match) {
      try {
        return { source: await tryOpen(deps, match.deviceId), fallback: false };
      } catch (error) {
        if (!isNotFound(error)) throw error; // unplugged between the listing and the open
      }
    }
  }
  const chosen = request.label !== null || request.deviceId !== null;
  if (chosen && strict) throw new CameraOpenError('not_found', 'the chosen camera is missing');
  return { source: await tryOpen(deps, null), fallback: chosen };
}

/**
 * Opens the requested camera within `CAMERA_OPEN_TIMEOUT_MS`: a camera that never answers
 * rejects with `CameraOpenError('unknown')`, and a stream that arrives later is stopped at
 * once. `strict` (calibration): a chosen camera that is missing rejects with `not_found`
 * instead of opening the default one.
 */
export function openCameraWithin(
  deps: ResolvedSessionDeps,
  request: CameraRequest = NO_CAMERA_REQUEST,
  strict = false,
): Promise<OpenedCamera> {
  return withDeadline(
    openRequested(deps, request, strict),
    CAMERA_OPEN_TIMEOUT_MS,
    deps.timers,
    () => new CameraOpenError('unknown', 'the camera did not answer in time'),
    (late) => late.source.stop(),
  );
}

/**
 * `deps.createVision` limited to `VISION_LOAD_TIMEOUT_MS`: a load that never settles rejects
 * with `VisionLoadError('load_failed')`. A pipeline that arrives later goes to `late` (the
 * session adopts it to recover), or is closed.
 */
export function createVisionWithin(
  deps: SessionDeps,
  assets: VisionAssets,
  late: (vision: VisionPipeline) => void = (vision) => vision.close(),
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
    late,
  );
}

/** A random run id (hex), from the platform CSPRNG (never `Math.random`). */
export function randomRunId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Real dependencies with any override from `partial`. */
export function resolveSessionDeps(partial: Partial<SessionDeps> = {}): ResolvedSessionDeps {
  return {
    clock: partial.clock ?? MONOTONIC_CLOCK,
    timers: partial.timers ?? REAL_TIMERS,
    createVision: partial.createVision ?? createVisionPipeline,
    openCamera: partial.openCamera ?? openCamera,
    cpuProbe: partial.cpuProbe ?? null,
    nowIso: partial.nowIso ?? ((): string => new Date().toISOString()),
    randomId: partial.randomId ?? randomRunId,
    listCameras: partial.listCameras ?? listCameras,
  };
}

/**
 * What the engine sees of main's context. A catalog service playing on another display while
 * the keyboard and mouse are idle for 10 s is a distraction in the foreground: the user is
 * watching it, whatever window has the focus. Typing or scrolling ends it at once.
 */
export function engineContext(context: ContextInput): ContextSignals {
  const idle = context.idleMs;
  const watching =
    context.visibleDistraction === true &&
    typeof idle === 'number' &&
    Number.isFinite(idle) &&
    idle >= VISIBLE_DISTRACTION_IDLE_MS;
  return { foreground: watching ? 'distraction' : context.foreground, idleMs: idle };
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
 * 30 s) emits `mode{vision_failed}` and the `vision_failed` hint. Both are retried in the
 * background when the cause may pass.
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

type StartOutcome =
  | { kind: 'ok'; identity: CameraIdentity | null }
  /** Started in a break or «Pausa»: the pipeline is ready, the camera opens when work resumes. */
  | { kind: 'deferred' }
  | { kind: 'camera_failed'; error: CameraErrorCode }
  | { kind: 'vision_failed'; retryable: boolean };

class StudySession implements StudySessionHandle {
  private readonly options: StudySessionOptions;
  private readonly deps: ResolvedSessionDeps;
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
  private started = false;

  // Camera and vision (camera mode; a vision pipeline may also wait for a camera to recover).
  private source: FrameSource | null = null;
  private vision: VisionPipeline | null = null;
  private opening = false;
  /** Bumped to cancel an open in flight (stop, no-camera switch). */
  private openGeneration = 0;
  private lastOpenAt: MonoMs | null = null;
  /** When the loop last asked the camera for a frame (`null`: not yet). */
  private lastGrabAt: MonoMs | null = null;
  /** The source is the default camera because the chosen one was missing. */
  private onFallback = false;
  /** While on the default camera: when the device list was last checked for the chosen one. */
  private lastProbeAt: MonoMs | null = null;
  private probing = false;
  /** Until then a reopen tries only the chosen camera (its track just ended). */
  private chosenOnlyUntil: MonoMs | null = null;
  private stalledSince: MonoMs | null = null;
  private failingSince: MonoMs | null = null;
  private lastCameraError: CameraErrorCode | null = null;
  private offerSent = false;
  private nonWorkSince: MonoMs | null = null;
  private lastCameraEvent: CameraStatus | null = null;
  private visionFailures = 0;
  /** The current failure streak already had its rebuild. */
  private streakRebuilt = false;
  /** A vision rebuild is in flight (bumped to cancel it). */
  private rebuildGeneration = 0;
  private rebuilding = false;
  private lastRebuildAt: MonoMs | null = null;

  // Background recovery of the camera analysis (no-camera mode after a failure).
  private recoverable = false;
  private recovering = false;
  private recoveryAttempts = 0;
  private recoveryTimer: unknown = null;
  private recoveryGeneration = 0;
  /** A recovery attempt is waiting for the work phase (the camera never opens in a break). */
  private recoveryWaitsForWork = false;

  // The governor's alert: a phone seen lately, or the engine in doubt.
  private phoneSeenAt: MonoMs | null = null;
  private inDoubt = false;

  private readonly governor = new CpuGovernor();
  private readonly cadence = new FrameCadence();
  private readonly loop: AdaptiveLoop;
  private readonly hints = new FacadeHints();
  private reportHandle: unknown = null;
  private lastCpuProbeAt: MonoMs = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private summary: SessionLocalSummary | null = null;

  constructor(options: StudySessionOptions, deps: ResolvedSessionDeps, parts: SessionParts) {
    this.options = options;
    this.deps = deps;
    this.parts = parts;
    this.runId = deps.randomId();
    this.startedAt = deps.clock.now();
    this.settingsInput = { ...(options.settings ?? {}) };
    this.settings = resolveStudyAiSettings(this.settingsInput);
    this.context = copyContext(options.initialContext ?? DEFAULT_CONTEXT);
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
      const opened = await this.openVisionThenCamera();
      if (opened.kind === 'camera_failed') {
        observer = this.cameraFailedFallback(events, opened.error);
        if (isRetryableCameraError(opened.error)) this.recoverable = true;
        else this.closeVision();
      } else if (opened.kind === 'vision_failed') {
        observer = this.noCameraFallback(events);
        this.recoverable = opened.retryable;
      } else if (opened.kind === 'deferred') {
        // No camera yet, so no identity: the classifier is picked when the camera opens
        // (`checkIdentity`), and `recalibrate` is decided then, not now.
        this.cameraObserver = this.createCameraObserver(createGenericClassifier());
        observer = this.cameraObserver;
      } else {
        const classifier = this.classifierFor(opened.identity);
        if (this.profile !== null && classifier.kind === 'generic') recalibrate = true;
        this.cameraObserver = this.createCameraObserver(classifier);
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
   * Loads the vision pipeline (within 30 s), then opens the camera (within 15 s): the camera
   * is never on while MediaPipe loads, or when it cannot. A camera failure keeps the pipeline
   * for the background retries; the caller closes it when there will be none.
   */
  private async openVisionThenCamera(): Promise<StartOutcome> {
    const assets = this.options.assets;
    if (assets === null)
      throw new TypeError('startStudySession: assets are required in camera mode');
    try {
      this.vision = await createVisionWithin(this.deps, assets, (late) =>
        this.adoptLateVision(late),
      );
    } catch (error) {
      return { kind: 'vision_failed', retryable: isRetryableVisionError(error) };
    }
    // Recreated or re-attached during a break or «Pausa»: «la cámara no vigila» holds.
    if (this.effectiveContext(this.now()).phase !== 'work') return { kind: 'deferred' };
    let opened: OpenedCamera;
    try {
      opened = await openCameraWithin(this.deps, this.cameraRequest());
    } catch (error) {
      return { kind: 'camera_failed', error: cameraErrorCodeOf(error) };
    }
    return { kind: 'ok', identity: await this.useCamera(opened, this.now()) };
  }

  /** Takes an opened stream: says so at once (`camera{starting}`), then identifies it. */
  private async useCamera(opened: OpenedCamera, now: MonoMs): Promise<CameraIdentity | null> {
    this.source = opened.source;
    this.lastOpenAt = now;
    this.stalledSince = null;
    this.emitCamera('starting', null);
    this.setFallbackCamera(opened.fallback);
    const identity = await opened.source.identity().catch(() => null);
    this.identity = identity;
    return identity;
  }

  private cameraRequest(): CameraRequest {
    return {
      label: this.options.cameraLabel ?? null,
      deviceId: this.options.cameraDeviceId ?? null,
    };
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

  private createCameraObserver(classifier: AttentionClassifier): CameraObserverPort {
    return this.parts.createCameraObserver({
      classifier,
      fallback: classifier.kind === 'personal' ? createGenericClassifier() : null,
    });
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
    this.started = true;
    this.loop.start();
    this.scheduleReport();
    this.scheduleRecovery();
  }

  /** Frees the camera and vision after a failed start. */
  release(): void {
    this.stopped = true;
    this.stopRecovery();
    this.cancelRebuild();
    this.openGeneration += 1;
    this.dropSource();
    this.closeVision();
  }

  // -------------------------------------------------------------------------------------
  // Loop step
  // -------------------------------------------------------------------------------------

  private async step(now: MonoMs, plan: StepPlan): Promise<StepCost | null> {
    if (this.stopped) return null;
    if (this.mode === 'no-camera') {
      if (this.recoveryWaitsForWork && this.effectiveContext(now).phase === 'work') {
        this.recoveryWaitsForWork = false;
        void this.attemptRecovery();
      }
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
    // The camera's `stalled` means «no frame for 3 s». When the loop itself did not ask for
    // one in that time (a slow step, a busy renderer), that says nothing about the camera:
    // judge it after this step's grab instead.
    const loopAway = this.lastGrabAt !== null && now - this.lastGrabAt > STALL_AFTER_MS;
    this.superviseCamera(now, loopAway);

    const source = this.source;
    const vision = this.vision;
    if (source === null || source.status === 'error') {
      this.tick(now, null);
      return null;
    }
    this.lastGrabAt = now;
    if (vision === null || !plan.analyse) {
      // The pipeline is being rebuilt, or the loop is repaying its duty cap (a hold tick).
      // Keep taking (and closing) frames so a healthy camera never reads as stalled; the
      // engine sees the camera ok and no frame, so it keeps the last presence (an absence
      // keeps counting, a present user is not counted absent).
      await discardNextFrame(source).catch(() => undefined);
      if (this.stopped) return null;
      if (loopAway) this.superviseCamera(this.now());
      this.tick(this.now(), null);
      return null;
    }

    const outcome = await analyseNextFrame(
      source,
      vision,
      () => this.cadence.options(this.now(), plan),
      () => !this.stopped && this.source === source && this.vision === vision,
    );
    if (this.stopped) return null;
    if (loopAway) this.superviseCamera(this.now());

    if (outcome.kind === 'failed') {
      const at = this.now();
      if (isVisionContextLost(outcome.error)) {
        // Not a failing frame: the pipeline lost its GPU context. Rebuild it (frames are
        // not analysed meanwhile, so nothing is counted as absent).
        this.rebuildVision(at, 'context_lost');
        this.tick(at, null);
        return null;
      }
      this.visionFailures += 1;
      if (this.visionFailures >= VISION_FAILURES_TO_FALLBACK) {
        // Often a WASM abort after which the module is dead: one rebuild first; the same
        // streak again means the pipeline cannot work here (retried in the background).
        if (this.streakRebuilt) {
          this.switchToNoCamera('vision_failed', at);
        } else {
          this.streakRebuilt = true;
          this.rebuildVision(at, 'failures');
        }
      }
      this.tick(at, null);
      throw outcome.error;
    }
    if (outcome.kind === 'none') {
      this.tick(this.now(), null);
      return null;
    }

    this.visionFailures = 0;
    this.streakRebuilt = false;
    const t0 = this.now();
    this.cadence.done(t0, outcome.options);
    const features = outcome.result.features;
    this.notePhone(t0, features);
    this.tick(t0, features);
    const end = this.now();
    return { ...stepCost(now, outcome.result, outcome.options, end - t0), alert: this.alert(end) };
  }

  private tick(now: MonoMs, frame: FrameFeatures | null): void {
    const context = this.effectiveContext(now);
    const out = this.engine.tick({
      now,
      phase: context.phase,
      context: engineContext(context),
      camera: this.cameraStatus(),
      frame,
    });
    this.inDoubt = out.snapshot.state === 'doubt';
    for (const event of out.events) this.emit(event);
    this.updateHints(now);
  }

  /** A fresh detector run saw a phone that is not lying still: the alert starts. */
  private notePhone(now: MonoMs, features: FrameFeatures): void {
    const objects = features.objects;
    if (objects?.fresh && objects.phone && !isResting(objects.phone)) this.phoneSeenAt = now;
  }

  /** The detector stays at ≥ 1 Hz: a phone seen in the last 20 s, or the engine in doubt. */
  private alert(now: MonoMs): boolean {
    const phone = this.phoneSeenAt !== null && now - this.phoneSeenAt <= PHONE_ALERT_MS;
    return phone || this.inDoubt;
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

  /** `ignoreStall`: the loop has not asked for a frame lately, so `stalled` is no evidence. */
  private superviseCamera(now: MonoMs, ignoreStall = false): void {
    const source = this.source;
    if (source !== null) {
      const status = source.status;
      if (status === 'ok') {
        this.stalledSince = null;
        this.failingSince = null;
        this.lastCameraError = null;
        this.offerSent = false;
        this.emitCamera('ok', null);
        if (this.onFallback) this.probeChosenCamera(now);
      } else if (status === 'error') {
        // Track ended (unplugged, access revoked): reopen now, then every 10 s. The chosen
        // camera gets 15 s to come back on its own before the default one is used.
        this.markFailing(now);
        if (!this.onFallback && this.hasChosenCamera()) {
          this.chosenOnlyUntil = now + CHOSEN_CAMERA_GRACE_MS;
        }
        this.dropSource();
        this.lastOpenAt = null;
      } else if (status === 'stalled' && !ignoreStall) {
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
      } else if (this.lastOpenAt === null || now - this.lastOpenAt >= this.reopenEveryMs(now)) {
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

  /** Main named a camera (by label or raw id). */
  private hasChosenCamera(): boolean {
    const request = this.cameraRequest();
    return request.label !== null || request.deviceId !== null;
  }

  /** Only the chosen camera may be opened now (its track ended less than 15 s ago). */
  private chosenOnly(now: MonoMs): boolean {
    return this.chosenOnlyUntil !== null && now < this.chosenOnlyUntil;
  }

  /** Retry interval of the reopen; 0 right after the chosen camera's grace ran out. */
  private reopenEveryMs(now: MonoMs): number {
    if (this.chosenOnlyUntil === null) return STUDY_AI_CONSTANTS.cameraRetryMs;
    return this.chosenOnly(now) ? CHOSEN_CAMERA_RETRY_MS : 0;
  }

  /**
   * On the default camera: every 10 s, looks for the chosen one in the device list. When it
   * is listed it is opened on its own; only once it opened does it replace the default camera
   * (a chosen camera that is busy or fails keeps the working default one).
   */
  private probeChosenCamera(now: MonoMs): void {
    if (this.probing || this.opening) return;
    if (this.lastProbeAt !== null && now - this.lastProbeAt < STUDY_AI_CONSTANTS.cameraRetryMs) {
      return;
    }
    this.lastProbeAt = now;
    const request = this.cameraRequest();
    const fallback = this.source;
    const generation = this.openGeneration;
    const current = (): boolean =>
      !this.stopped &&
      this.mode === 'camera' &&
      this.onFallback &&
      this.source === fallback &&
      generation === this.openGeneration;
    this.probing = true;
    void (async (): Promise<void> => {
      try {
        const devices = await this.deps.listCameras().catch((): readonly CameraDeviceInfo[] => []);
        const listed = devices.some(
          (d) =>
            d.deviceId !== '' &&
            ((request.label !== null && d.label === request.label) ||
              (request.deviceId !== null && d.deviceId === request.deviceId)),
        );
        if (!listed || !current()) return;
        let opened: OpenedCamera;
        try {
          opened = await openCameraWithin(this.deps, request, true);
        } catch {
          return; // busy or gone again: keep the default camera, look again in 10 s
        }
        if (!current() || opened.fallback) {
          opened.source.stop();
          return;
        }
        this.openGeneration += 1;
        this.dropSource();
        this.lastOpenAt = this.now();
        this.adoptSource(opened);
      } finally {
        this.probing = false;
      }
    })();
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

  private closeVision(): void {
    const vision = this.vision;
    this.vision = null;
    try {
      vision?.close();
    } catch {
      // A pipeline on a lost context may fail to close; it holds nothing else.
    }
  }

  private reopenCamera(now: MonoMs): void {
    this.opening = true;
    this.lastOpenAt = now;
    const generation = ++this.openGeneration;
    // Resolved again on every open: the chosen camera may be back, or gone (then the default
    // one, with the `camera_default` hint, unless its track ended less than 15 s ago). Limited
    // to 15 s: a hung `getUserMedia` must not leave `opening` set for good (the retries stop).
    const strict = this.chosenOnly(now);
    if (!strict) this.chosenOnlyUntil = null;
    openCameraWithin(this.deps, this.cameraRequest(), strict).then(
      (opened) => {
        if (this.stopped || generation !== this.openGeneration || this.mode !== 'camera') {
          opened.source.stop();
          return;
        }
        this.opening = false;
        this.adoptSource(opened);
      },
      (error: unknown) => {
        if (generation !== this.openGeneration) return;
        this.opening = false;
        this.lastCameraError = cameraErrorCodeOf(error);
        this.markFailing(this.now());
      },
    );
  }

  /** A stream opened mid-session becomes the source; the classifier follows its identity. */
  private adoptSource(opened: OpenedCamera): void {
    this.source = opened.source;
    this.stalledSince = null;
    if (!opened.fallback) this.chosenOnlyUntil = null;
    this.setFallbackCamera(opened.fallback);
    this.vision?.reset();
    this.cadence.reset();
    void this.checkIdentity(opened.source);
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
    // The calibrated camera is back: its profile applies again, no need to recalibrate.
    if (classifier.kind === 'personal') this.unstickHint('recalibrate');
    else if (this.profile !== null) this.stickyHint('recalibrate');
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

  /** `camera_default`: running on the default camera because the chosen one is missing. */
  private setFallbackCamera(fallback: boolean): void {
    this.onFallback = fallback;
    if (fallback) this.lastProbeAt = this.now(); // look for the chosen one 10 s from now
    if (fallback) this.stickyHint('camera_default');
    else this.unstickHint('camera_default');
  }

  private stickyHint(code: HintCode): void {
    if (this.hints.setSticky(code)) this.emit({ type: 'hint', at: this.now(), code, active: true });
  }

  private unstickHint(code: HintCode): void {
    if (this.hints.clearSticky(code)) {
      this.emit({ type: 'hint', at: this.now(), code, active: false });
    }
  }

  /**
   * Replaces a pipeline that lost its WebGL context or keeps failing. Until it is back the
   * loop keeps taking frames without analysing them (the engine keeps the last presence). A
   * rebuild that fails or takes over 30 s, or a second context loss within 60 s, switches to
   * no-camera mode, which then retries in the background.
   */
  private rebuildVision(now: MonoMs, cause: 'context_lost' | 'failures'): void {
    if (this.stopped || this.mode !== 'camera' || this.rebuilding) return;
    this.closeVision();
    const assets = this.options.assets;
    const tooSoon =
      cause === 'context_lost' &&
      this.lastRebuildAt !== null &&
      now - this.lastRebuildAt < VISION_REBUILD_MIN_INTERVAL_MS;
    if (assets === null || tooSoon) {
      this.switchToNoCamera('vision_failed', now);
      return;
    }
    this.lastRebuildAt = now;
    this.rebuilding = true;
    const generation = ++this.rebuildGeneration;
    createVisionWithin(this.deps, assets, (late) => this.adoptLateVision(late)).then(
      (vision) => {
        if (generation !== this.rebuildGeneration || this.stopped || this.mode !== 'camera') {
          this.adoptLateVision(vision); // the session gave up meanwhile: maybe it recovers
          return;
        }
        this.rebuilding = false;
        this.vision = vision;
        this.visionFailures = 0;
        this.cadence.reset();
      },
      (error: unknown) => {
        if (generation !== this.rebuildGeneration || this.stopped) return;
        this.rebuilding = false;
        this.switchToNoCamera('vision_failed', this.now(), isRetryableVisionError(error));
      },
    );
  }

  private cancelRebuild(): void {
    this.rebuildGeneration += 1;
    this.rebuilding = false;
  }

  private switchToNoCamera(reason: 'user' | 'vision_failed', now: MonoMs, retry = true): void {
    if (this.mode === 'no-camera') return;
    this.mode = 'no-camera';
    this.cancelRebuild();
    this.openGeneration += 1;
    this.opening = false;
    this.dropSource();
    this.closeVision();
    this.failingSince = null;
    this.cameraObserver = null;
    this.engine.setObserver(new NoCameraObserver(), now);
    this.emitCamera('off', null);
    this.announce(this.hints.clear('camera_lost'));
    this.announce(this.hints.clear('over_budget'));
    this.onFallback = false;
    this.unstickHint('camera_default');
    if (reason === 'vision_failed') this.stickyHint('vision_failed');
    this.emit({ type: 'mode', at: now, mode: 'no-camera', reason });
    if (reason === 'vision_failed' && retry) {
      this.recoverable = true;
      this.scheduleRecovery();
    } else {
      this.stopRecovery();
    }
  }

  // -------------------------------------------------------------------------------------
  // Recovery (no-camera mode after a failure → camera mode)
  // -------------------------------------------------------------------------------------

  private scheduleRecovery(): void {
    if (!this.recoverable || !this.started || this.stopped || this.mode !== 'no-camera') return;
    if (this.recoveryTimer !== null || this.recovering || this.recoveryWaitsForWork) return;
    const delays = RECOVERY_DELAYS_MS;
    const delay = delays[Math.min(this.recoveryAttempts, delays.length - 1)] as number;
    this.recoveryAttempts += 1;
    this.recoveryTimer = this.deps.timers.set(() => {
      this.recoveryTimer = null;
      void this.attemptRecovery();
    }, delay);
  }

  private stopRecovery(): void {
    this.recoverable = false;
    this.recovering = false;
    this.recoveryWaitsForWork = false;
    this.recoveryGeneration += 1;
    if (this.recoveryTimer !== null) this.deps.timers.clear(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /** A pipeline that finished loading after its deadline: used to recover, or closed. */
  private adoptLateVision(late: VisionPipeline): void {
    const usable =
      !this.stopped &&
      this.recoverable &&
      !this.recovering &&
      this.mode === 'no-camera' &&
      this.vision === null;
    if (!usable) {
      try {
        late.close();
      } catch {
        // Nothing else holds it.
      }
      return;
    }
    this.vision = late;
    if (!this.started) return; // start() schedules the camera attempt
    if (this.recoveryTimer !== null) this.deps.timers.clear(this.recoveryTimer);
    this.recoveryTimer = null;
    void this.attemptRecovery();
  }

  /** One background attempt: the vision pipeline if missing, then the camera. */
  private async attemptRecovery(): Promise<void> {
    const assets = this.options.assets;
    if (!this.recoverable || this.recovering || this.stopped || this.mode !== 'no-camera') return;
    if (assets === null) return;
    this.recovering = true;
    const generation = ++this.recoveryGeneration;
    const live = (): boolean =>
      generation === this.recoveryGeneration && !this.stopped && this.mode === 'no-camera';
    try {
      if (this.vision === null) {
        let vision: VisionPipeline;
        try {
          vision = await createVisionWithin(this.deps, assets, (late) =>
            this.adoptLateVision(late),
          );
        } catch (error) {
          if (live() && !isRetryableVisionError(error)) this.stopRecovery();
          return;
        }
        if (!live() || this.vision !== null) {
          vision.close();
          return;
        }
        this.vision = vision;
      }
      if (this.effectiveContext(this.now()).phase !== 'work') {
        // A break or «Pausa»: the camera stays off; the attempt runs when work resumes.
        this.recoveryWaitsForWork = true;
        return;
      }
      let opened: OpenedCamera;
      try {
        opened = await openCameraWithin(this.deps, this.cameraRequest());
      } catch (error) {
        if (!live()) return;
        const code = cameraErrorCodeOf(error);
        this.lastCameraError = code;
        if (!isRetryableCameraError(code)) {
          this.stopRecovery();
          this.closeVision();
        }
        return;
      }
      if (!live()) {
        opened.source.stop();
        return;
      }
      const identity = await this.useCamera(opened, this.now());
      if (!live() || this.source !== opened.source) {
        if (this.source === opened.source) this.dropSource();
        else opened.source.stop();
        this.emitCamera('off', null);
        return;
      }
      this.enterCameraMode(identity, this.now());
    } finally {
      if (generation === this.recoveryGeneration) this.recovering = false;
      if (!this.recoveryWaitsForWork) this.scheduleRecovery();
    }
  }

  /** The camera analysis is back: camera mode again, `mode{camera, recovered}`. */
  private enterCameraMode(identity: CameraIdentity | null, now: MonoMs): void {
    const classifier = this.classifierFor(identity);
    this.stopRecovery();
    this.mode = 'camera';
    this.cameraObserver = this.createCameraObserver(classifier);
    this.failingSince = null;
    this.offerSent = false;
    this.lastCameraError = null;
    this.visionFailures = 0;
    this.streakRebuilt = false;
    this.nonWorkSince = null;
    this.vision?.reset();
    this.cadence.reset();
    this.engine.setObserver(this.cameraObserver, now);
    this.unstickHint('vision_failed');
    if (this.profile !== null && classifier.kind === 'generic') this.stickyHint('recalibrate');
    this.emit({ type: 'mode', at: now, mode: 'camera', reason: 'recovered' });
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
    this.context = copyContext(context);
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
    if (this.stopped) return false;
    if (this.mode === 'no-camera') {
      // Already without camera after a failure («Seguir sin cámara»): stop trying to bring
      // the camera back. Nothing to do when no retry was pending.
      if (!this.recoverable) return false;
      this.stopRecovery();
      this.dropSource();
      this.closeVision();
      this.emit({ type: 'mode', at: this.now(), mode: 'no-camera', reason: 'user' });
      return true;
    }
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
    if (this.mode === 'camera' && this.vision?.contextLost === true) {
      this.rebuildVision(now, 'context_lost');
    } else {
      this.vision?.reset();
    }
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
    this.stopRecovery();
    this.openGeneration += 1;
    this.opening = false;
    this.cancelRebuild();
    this.dropSource();
    this.closeVision();
    this.sendReport(); // Final totals, so main can close the last heartbeat interval.
    this.summary = { totals: this.engine.totals(), timeline: this.engine.timeline() };
    return this.summary;
  }
}

/** Main's context, with only the keys the contract knows. */
function copyContext(context: ContextInput): ContextInput {
  const copy: ContextInput = {
    phase: context.phase,
    foreground: context.foreground,
    idleMs: context.idleMs,
  };
  if (context.visibleDistraction === true) copy.visibleDistraction = true;
  return copy;
}
