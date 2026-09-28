/**
 * RUNTIME test doubles: a deterministic scheduler (clock + setTimeout-style timers), a fake
 * camera, a fake vision pipeline replaying synthetic `FrameFeatures`, and fakes of DECISION's
 * engine and camera observer for wiring tests.
 */
import type {
  AnalysisFrame,
  AttentionClassifier,
  AttentionEngineOptions,
  AttentionEvent,
  AttentionSnapshot,
  AttentionTotals,
  CameraIdentity,
  CameraStatus,
  Clock,
  FeedbackEpisodeResult,
  FrameFeatures,
  FrameSource,
  MonoMs,
  Observation,
  Observer,
  OpenCameraOptions,
  SessionTimeline,
  StrikeAck,
  StudyAiSettings,
  StudyMode,
  TickInput,
  TickOutput,
  TimerApi,
  VisionCost,
  VisionFrameOptions,
  VisionPipeline,
  VisionResult,
} from '../../src/types';
import type { CameraObserverPort, EnginePort } from '../../src/runtime/session';

// ---------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------

interface Pending {
  id: number;
  at: MonoMs;
  fn: () => void;
}

/** Lets every pending promise callback run (microtasks drain before the next macrotask). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Manual clock and timers. `advance` fires due timers in order and settles async work. */
export class FakeScheduler implements Clock, TimerApi {
  t: MonoMs;
  private seq = 0;
  private queue: Pending[] = [];

  constructor(start: MonoMs = 0) {
    this.t = start;
  }

  now(): MonoMs {
    return this.t;
  }

  /** Extra delay on every timer (a busy event loop fires timers late). */
  latency = 0;

  set(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.queue.push({ id: this.seq, at: this.t + Math.max(0, ms) + this.latency, fn });
    return this.seq;
  }

  clear(handle: unknown): void {
    this.queue = this.queue.filter((p) => p.id !== handle);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Delays of the pending timers from now. */
  delays(): number[] {
    return this.queue.map((p) => p.at - this.t);
  }

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next: Pending | null = null;
      for (const p of this.queue) {
        if (
          p.at <= end &&
          (next === null || p.at < next.at || (p.at === next.at && p.id < next.id))
        ) {
          next = p;
        }
      }
      if (next === null) break;
      this.queue = this.queue.filter((p) => p !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

// ---------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------

export const CAMERA_ID: CameraIdentity = Object.freeze({
  key: `sha256:${'a'.repeat(64)}`,
  aspect: 4 / 3,
});

export class FakeFrame implements AnalysisFrame {
  readonly t: MonoMs;
  readonly width = 320;
  readonly height = 240;
  readonly source: unknown = Object.freeze({ fake: true });
  closed = 0;

  constructor(t: MonoMs) {
    this.t = t;
  }

  close(): void {
    this.closed += 1;
  }
}

export class FakeSource implements FrameSource {
  status: CameraStatus = 'ok';
  readonly width = 320;
  readonly height = 240;
  readonly frames: FakeFrame[] = [];
  stopped = 0;
  /** `next()` returns `null` while this is false. */
  delivering = true;
  identityValue: CameraIdentity = CAMERA_ID;

  constructor(private readonly clock: Clock) {}

  next(): Promise<AnalysisFrame | null> {
    if (!this.delivering || this.status !== 'ok' || this.stopped > 0) {
      return Promise.resolve(null);
    }
    const frame = new FakeFrame(this.clock.now());
    this.frames.push(frame);
    return Promise.resolve(frame);
  }

  identity(): Promise<CameraIdentity> {
    return Promise.resolve(this.identityValue);
  }

  stop(): void {
    this.stopped += 1;
  }
}

/** `openCamera` double: hands out `FakeSource`s, or rejects with `failWith`. */
export class FakeCamera {
  readonly opened: FakeSource[] = [];
  readonly calls: OpenCameraOptions[] = [];
  failWith: unknown = null;
  identity: CameraIdentity = CAMERA_ID;

  constructor(private readonly clock: Clock) {}

  readonly open = (options: OpenCameraOptions): Promise<FrameSource> => {
    this.calls.push(options);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    const source = new FakeSource(this.clock);
    source.identityValue = this.identity;
    this.opened.push(source);
    return Promise.resolve(source);
  };

  get last(): FakeSource {
    const source = this.opened[this.opened.length - 1];
    if (!source) throw new Error('no camera opened');
    return source;
  }
}

export class CameraError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CameraOpenError';
    this.code = code;
  }
}

export class VisionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'VisionLoadError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------------------

/** A plain visible face at the screen, for when the content does not matter. */
export function plainFeatures(t: MonoMs): FrameFeatures {
  return {
    t,
    width: 320,
    height: 240,
    face: {
      pose: { yaw: 0, pitch: -5, roll: 0 },
      box: { cx: 0.5, cy: 0.42, w: 0.22, h: 0.3 },
      truncated: 0,
      blink: 0.12,
      lookDown: 0.1,
      lookUp: 0.05,
      gazeX: 0,
      jawOpen: 0.02,
      jitter: 0.005,
      faces: 1,
    },
    objects: null,
    luma: null,
    quality: 0.95,
  };
}

/** A synthetic frame moved to time `t` (every timestamp inside shifts with it). */
export function shiftFrame(frame: FrameFeatures, t: MonoMs): FrameFeatures {
  const d = t - frame.t;
  return {
    ...frame,
    t,
    objects: frame.objects ? { ...frame.objects, ranAt: frame.objects.ranAt + d } : null,
    luma: frame.luma ? { ...frame.luma, at: frame.luma.at + d } : null,
  };
}

/** Replays `frames` in order (the last one repeats), each moved to its analysis time. */
export function replay(frames: readonly FrameFeatures[]): (frame: AnalysisFrame) => FrameFeatures {
  let i = 0;
  return (frame) => {
    const source = frames[Math.min(i, frames.length - 1)];
    i += 1;
    if (!source) return plainFeatures(frame.t);
    return shiftFrame(source, frame.t);
  };
}

export class FakeVision implements VisionPipeline {
  readonly calls: { frame: AnalysisFrame; options: VisionFrameOptions }[] = [];
  resets = 0;
  closed = 0;
  /** Number of upcoming `process` calls that throw. */
  failNext = 0;
  cost: VisionCost = { faceMs: 10, objectMs: 0, lumaMs: 0.5, totalMs: 10.5 };
  objectMs = 35;
  /** Features for a frame; defaults to a plain face. */
  features: (frame: AnalysisFrame, index: number) => FrameFeatures = (frame) =>
    plainFeatures(frame.t);

  constructor(private readonly scheduler?: FakeScheduler) {}

  process(frame: AnalysisFrame, options: VisionFrameOptions): VisionResult {
    this.calls.push({ frame, options });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('process failed');
    }
    const objectMs = options.objects ? this.objectMs : 0;
    const cost = { ...this.cost, objectMs, totalMs: this.cost.totalMs + objectMs };
    // Simulated processing time.
    if (this.scheduler) this.scheduler.t += cost.totalMs;
    return { features: this.features(frame, this.calls.length - 1), cost };
  }

  reset(): void {
    this.resets += 1;
  }

  close(): void {
    this.closed += 1;
  }
}

// ---------------------------------------------------------------------------------------
// DECISION doubles (wiring tests only; acceptance tests use the real ones)
// ---------------------------------------------------------------------------------------

export function fakeClassifier(kind: 'personal' | 'generic'): AttentionClassifier {
  return {
    kind,
    ready: true,
    thresholds: { phone: 0.5, person: 0.5 },
    trust: { phone: 0, away: 0 },
    eyes: { reliable: true, blinkFit: [0.15, -0.004], closedDelta: 0.45 },
    predict: () => ({ screen: 1, paper: 0, phone: 0, away: 0, absent: 0 }),
    relativePose: () => null,
    observe: () => undefined,
  };
}

export function observation(input: TickInput, mode: StudyMode): Observation {
  return {
    at: input.now,
    presence: mode === 'camera' ? (input.frame?.face ? 'visible' : 'camera_lost') : 'no_camera',
    study: 1,
    weight: 1,
    cause: null,
    evidence: {
      phone: false,
      book: false,
      lookingDown: false,
      distractionApp: false,
      inputActive: true,
    },
    eyes: { closed: false, yawn: false },
    hints: [],
    frame: input.frame,
    rel: null,
  };
}

export class FakeCameraObserver implements CameraObserverPort {
  readonly mode: StudyMode = 'camera';
  classifier: AttentionClassifier;
  readonly fallback: AttentionClassifier | null;
  readonly swaps: AttentionClassifier[] = [];
  resets = 0;

  constructor(options: { classifier: AttentionClassifier; fallback: AttentionClassifier | null }) {
    this.classifier = options.classifier;
    this.fallback = options.fallback;
  }

  setClassifier(classifier: AttentionClassifier): void {
    this.classifier = classifier;
    this.swaps.push(classifier);
  }

  observe(input: TickInput, _settings: Readonly<StudyAiSettings>): Observation {
    return observation(input, 'camera');
  }

  rescore(obs: Observation): number | null {
    return obs.study;
  }

  reset(): void {
    this.resets += 1;
  }
}

export class FakeEngine implements EnginePort {
  readonly ticks: TickInput[] = [];
  readonly observations: Observation[] = [];
  readonly acks: StrikeAck[] = [];
  readonly resumes: MonoMs[] = [];
  readonly observerSwaps: Observer[] = [];
  readonly settingsSeen: Readonly<StudyAiSettings>[] = [];
  observer: Observer;
  settings: Readonly<StudyAiSettings>;
  /** Events to return from the next tick. */
  queued: AttentionEvent[] = [];
  episode: FeedbackEpisodeResult = { ok: false, reason: 'no_episode' };
  applied: number[] = [];
  applyEvents: AttentionEvent[] = [];
  focusedPerTick = 300;
  failTicks = false;

  constructor(readonly options: AttentionEngineOptions) {
    this.observer = options.observer;
    this.settings = options.settings;
  }

  tick(input: TickInput): TickOutput {
    if (this.failTicks) throw new Error('engine failed');
    this.ticks.push(input);
    const obs = this.observer.observe(input, this.settings);
    this.observations.push(obs);
    const events = this.queued;
    this.queued = [];
    return { snapshot: this.snapshot(), events, observation: obs };
  }

  strikeResult(ack: StrikeAck, _now: MonoMs): void {
    this.acks.push(ack);
  }

  feedbackEpisode(_now: MonoMs): FeedbackEpisodeResult {
    return this.episode;
  }

  applyFeedback(_now: MonoMs, episodeId: number): readonly AttentionEvent[] {
    this.applied.push(episodeId);
    return this.applyEvents;
  }

  setSettings(settings: Readonly<StudyAiSettings>): void {
    this.settings = settings;
    this.settingsSeen.push(settings);
  }

  setObserver(observer: Observer, _now: MonoMs): void {
    this.observer = observer;
    this.observerSwaps.push(observer);
    observer.reset();
  }

  resume(now: MonoMs): void {
    this.resumes.push(now);
  }

  snapshot(): AttentionSnapshot {
    const last = this.ticks[this.ticks.length - 1];
    return {
      at: last?.now ?? this.options.startedAt,
      mode: this.observer.mode,
      state: 'focused',
      score: 80,
      low: false,
      presence: this.observer.mode === 'camera' ? 'visible' : 'no_camera',
      cause: null,
      drowsy: false,
      classifier: null,
      graceLeftMs: 0,
      doubtInMs: null,
      strikeInMs: null,
      hints: [],
    };
  }

  totals(): AttentionTotals {
    const n = this.ticks.length;
    return {
      focusedMs: n * this.focusedPerTick,
      warnings: 0,
      strikesRequested: 0,
      ticks: n,
      workMs: n * this.focusedPerTick,
    };
  }

  timeline(): SessionTimeline {
    const last = this.ticks[this.ticks.length - 1];
    return {
      durationMs: Math.max(0, (last?.now ?? 0) - this.options.startedAt),
      segments: [],
      marks: [],
    };
  }
}

/** Parts that hand out fakes and remember them. */
export function fakeParts(): {
  engines: FakeEngine[];
  observers: FakeCameraObserver[];
  parts: {
    createEngine(options: AttentionEngineOptions): FakeEngine;
    createCameraObserver(options: {
      classifier: AttentionClassifier;
      fallback: AttentionClassifier | null;
    }): FakeCameraObserver;
  };
  engine(): FakeEngine;
} {
  const engines: FakeEngine[] = [];
  const observers: FakeCameraObserver[] = [];
  return {
    engines,
    observers,
    parts: {
      createEngine: (options) => {
        const engine = new FakeEngine(options);
        engines.push(engine);
        return engine;
      },
      createCameraObserver: (options) => {
        const observer = new FakeCameraObserver(options);
        observers.push(observer);
        return observer;
      },
    },
    engine: () => {
      const engine = engines[0];
      if (!engine) throw new Error('no engine created');
      return engine;
    },
  };
}
