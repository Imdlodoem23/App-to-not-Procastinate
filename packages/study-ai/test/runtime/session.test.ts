/**
 * Study session facade wiring (fake camera, fake vision, fake engine and observer), then the
 * same facade with DECISION's real engine and observer.
 */
import { describe, expect, it } from 'vitest';
import { serializeProfile } from '../../src/calibration/profile';
import { isAnalysisOutbound } from '../../src/runtime/ipc';
import { NoCameraObserver } from '../../src/runtime/no-camera';
import {
  PHONE_ALERT_MS,
  RECOVERY_DELAYS_MS,
  VISIBLE_DISTRACTION_IDLE_MS,
  engineContext,
  startStudySession,
  startStudySessionWith,
} from '../../src/runtime/session';
import type {
  AttentionEvent,
  ContextInput,
  FeedbackEpisode,
  SessionDeps,
  SessionEvent,
  SessionReport,
  StudySessionHandle,
  StudySessionOptions,
  VisionAssets,
} from '../../src/types';
import { profileFor } from '../calibration/fixtures';
import { PERSONAS, synthesize } from '../synth';
import {
  CameraError,
  FakeCamera,
  FakeScheduler,
  FakeVision,
  VisionError,
  fakeParts,
  plainFeatures,
  replay,
} from './fakes';

const ASSETS: VisionAssets = {
  wasmBaseUrl: 'http://127.0.0.1:5173/mediapipe',
  faceModel: { url: 'http://127.0.0.1:5173/models/face_landmarker.task' },
  objectModel: { url: 'http://127.0.0.1:5173/models/efficientdet_lite0_int8.tflite' },
};

const WORK: ContextInput = { phase: 'work', foreground: 'study', idleMs: 2_000 };

interface Rig {
  s: FakeScheduler;
  camera: FakeCamera;
  vision: FakeVision;
  events: SessionEvent[];
  reports: SessionReport[];
  deps: Partial<SessionDeps>;
  visionLoads: number;
  visionFails: unknown;
  options(overrides?: Partial<StudySessionOptions>): StudySessionOptions;
}

function rig(): Rig {
  const s = new FakeScheduler(1_000);
  const camera = new FakeCamera(s);
  const vision = new FakeVision(s);
  const r: Rig = {
    s,
    camera,
    vision,
    events: [],
    reports: [],
    visionLoads: 0,
    visionFails: null,
    deps: {},
    options: (overrides = {}) => ({
      mode: 'camera',
      profileJson: null,
      assets: ASSETS,
      initialContext: WORK,
      onEvent: (event) => r.events.push(event),
      onReport: (report) => r.reports.push(report),
      deps: r.deps,
      ...overrides,
    }),
  };
  r.deps = {
    clock: s,
    timers: s,
    openCamera: camera.open,
    listCameras: camera.list,
    createVision: () => {
      r.visionLoads += 1;
      return r.visionFails === null ? Promise.resolve(vision) : Promise.reject(r.visionFails);
    },
    cpuProbe: null,
    nowIso: () => '2026-09-28T10:00:00.000Z',
    randomId: () => 'run0001',
  };
  return r;
}

/** Keeps main's context fresh (1 Hz) while time passes. */
async function run(
  r: Rig,
  handle: StudySessionHandle,
  ms: number,
  context: ContextInput = WORK,
): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) {
    handle.setContext(context);
    await r.s.advance(Math.min(1_000, ms - t));
  }
}

const eventsOf = <T extends SessionEvent['type']>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe('study session facade (wiring)', () => {
  it('analyses ~3 fps, closes every frame once and reports at 1 Hz with valid IPC shapes', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 10_000);

    const engine = f.engine();
    const frames = engine.ticks.filter((t) => t.frame !== null);
    expect(frames.length).toBeGreaterThanOrEqual(27);
    expect(frames.length).toBeLessThanOrEqual(33);
    for (const frame of r.camera.last.frames) expect(frame.closed).toBe(1);
    // L1: the detector on every 3rd frame, luma about once a second.
    const objectRuns = r.vision.calls.filter((c) => c.options.objects).length;
    expect(objectRuns).toBeGreaterThanOrEqual(9);
    expect(objectRuns).toBeLessThanOrEqual(12);
    const lumaRuns = r.vision.calls.filter((c) => c.options.luma).length;
    expect(lumaRuns).toBeGreaterThanOrEqual(9);
    expect(lumaRuns).toBeLessThanOrEqual(12);

    // setTimeout chains drift by the work done in between: 9–10 reports in 10 s.
    expect(r.reports.length).toBeGreaterThanOrEqual(9);
    expect(r.reports.length).toBeLessThanOrEqual(10);
    for (const report of r.reports) {
      expect(report.runId).toBe('run0001');
      expect(isAnalysisOutbound({ type: 'report', report })).toBe(true);
    }
    const ticks = r.reports.map((rep) => rep.totals.ticks);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    const last = r.reports[r.reports.length - 1] as SessionReport;
    expect(last.cameraOn).toBe(true);
    expect(last.camera).toBe('ok');
    expect(last.loop?.fps).toBeGreaterThan(2);
    for (const event of r.events) expect(isAnalysisOutbound({ type: 'event', event })).toBe(true);
    // `starting` the moment the stream opens (main shows «● Cámara activa» at once), then ok.
    expect(eventsOf(r.events, 'camera')).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'starting', error: null },
      { type: 'camera', at: expect.any(Number), status: 'ok', error: null },
    ]);
    await handle.stop();
  });

  it('never hands an image to anyone: events and reports are numbers and enums only', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 3_000);
    const summary = await handle.stop();
    const text = JSON.stringify({ events: r.events, reports: r.reports, summary });
    expect(text).not.toMatch(/fake|source|pixels|image/i);
  });

  it('switches the camera off after 10 s of break and back on for work', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 3_000);
    const first = r.camera.last;
    const breakCtx: ContextInput = { ...WORK, phase: 'break' };

    await run(r, handle, 9_000, breakCtx);
    expect(first.stopped).toBe(0); // not yet: 10 s grace for short phase blips
    await run(r, handle, 3_000, breakCtx);
    expect(first.stopped).toBe(1);
    expect(r.reports[r.reports.length - 1]?.cameraOn).toBe(false);
    expect(eventsOf(r.events, 'camera').map((e) => e.status)).toEqual(['starting', 'ok', 'off']);

    // Breaks tick the engine once a second without frames.
    const engine = f.engine();
    const before = engine.ticks.length;
    await run(r, handle, 5_000, breakCtx);
    const breakTicks = engine.ticks.slice(before);
    expect(breakTicks.length).toBeGreaterThanOrEqual(4);
    expect(breakTicks.length).toBeLessThanOrEqual(6);
    expect(breakTicks.every((t) => t.frame === null && t.camera === 'off')).toBe(true);
    expect(breakTicks.every((t) => t.phase === 'break')).toBe(true);

    const resetsBefore = r.vision.resets;
    await run(r, handle, 3_000);
    expect(r.camera.opened.length).toBe(2);
    expect(r.vision.resets).toBeGreaterThan(resetsBefore);
    expect(r.reports[r.reports.length - 1]?.cameraOn).toBe(true);
    expect(eventsOf(r.events, 'camera').map((e) => e.status)).toEqual([
      'starting',
      'ok',
      'off',
      'ok',
    ]);
    expect(r.visionLoads).toBe(1); // the WASM and models stay loaded
    await handle.stop();
  });

  it('camera lost: fails closed, retries every 10 s, offers «Continuar sin cámara» after 30 s', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 2_000);
    expect(handle.continueWithoutCamera()).toBe(false); // camera fine: not allowed

    r.camera.failWith = new CameraError('in_use');
    r.camera.last.status = 'error'; // unplugged
    await run(r, handle, 1_000);
    expect(r.camera.opened[0]?.stopped).toBe(1);
    const engine = f.engine();
    const lostTick = engine.ticks[engine.ticks.length - 1];
    expect(lostTick?.frame).toBeNull();
    expect(lostTick?.camera).not.toBe('ok');

    await run(r, handle, 12_000);
    expect(r.camera.calls.length).toBeGreaterThanOrEqual(3); // first + immediate + 10 s retry
    const hints = r.reports[r.reports.length - 1]?.snapshot.hints ?? [];
    expect(hints).toContain('camera_lost');
    expect(eventsOf(r.events, 'camera').some((e) => e.status === 'error')).toBe(false);

    await run(r, handle, 20_000);
    const offer = eventsOf(r.events, 'camera').filter((e) => e.status === 'error');
    expect(offer).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'error', error: 'in_use' },
    ]);

    expect(handle.continueWithoutCamera()).toBe(true);
    expect(eventsOf(r.events, 'mode')).toEqual([
      { type: 'mode', at: expect.any(Number), mode: 'no-camera', reason: 'user' },
    ]);
    expect(engine.observerSwaps[0]).toBeInstanceOf(NoCameraObserver);
    expect(r.vision.closed).toBe(1);
    await run(r, handle, 2_000);
    const report = r.reports[r.reports.length - 1] as SessionReport;
    expect(report.mode).toBe('no-camera');
    expect(report.cameraOn).toBe(false);
    expect(report.loop).toBeNull();
    expect(report.snapshot.hints).not.toContain('camera_lost');
    expect(handle.continueWithoutCamera()).toBe(false); // already without camera
    await handle.stop();
  });

  it('a covered lens (frames keep coming) never allows switching to no-camera mode', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    r.vision.features = (frame) => ({
      t: frame.t,
      width: 320,
      height: 240,
      face: null,
      objects: null,
      luma: {
        at: frame.t,
        mean: 0.02,
        spatialStd: 0.01,
        temporalDiff: 0,
        motionNearFace: 0,
        covered: true,
        lowLight: false,
      },
      quality: 0.2,
    });
    await run(r, handle, 40_000);
    expect(handle.continueWithoutCamera()).toBe(false);
    expect(eventsOf(r.events, 'mode')).toEqual([]);
    await handle.stop();
  });

  it('a stalled camera is restarted after 10 s', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 2_000);
    const first = r.camera.last;
    first.status = 'stalled';
    await run(r, handle, 8_000);
    expect(first.stopped).toBe(0);
    await run(r, handle, 3_000);
    expect(first.stopped).toBe(1);
    expect(r.camera.opened.length).toBe(2);
    await run(r, handle, 2_000);
    expect(r.camera.last.frames.length).toBeGreaterThan(0);
    expect(r.reports[r.reports.length - 1]?.camera).toBe('ok');
    await handle.stop();
  });

  it('vision that fails to load falls back to no-camera mode at start, the camera never on', async () => {
    const r = rig();
    r.visionFails = new VisionError('simd_unsupported');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    expect(r.camera.calls).toHaveLength(0); // vision first: the camera was never opened
    expect(f.observers).toHaveLength(0);
    expect(f.engine().observer).toBeInstanceOf(NoCameraObserver);
    expect(eventsOf(r.events, 'mode')).toEqual([
      { type: 'mode', at: expect.any(Number), mode: 'no-camera', reason: 'vision_failed' },
    ]);
    await run(r, handle, 3_000);
    const report = r.reports[r.reports.length - 1] as SessionReport;
    expect(report.mode).toBe('no-camera');
    expect(report.snapshot.hints).toContain('vision_failed');
    expect(f.engine().ticks.every((t) => t.frame === null && t.camera === 'off')).toBe(true);
    // SIMD missing fails the same way every time: never retried.
    await run(r, handle, 600_000);
    expect(r.visionLoads).toBe(1);
    expect(r.camera.calls).toHaveLength(0);
    await handle.stop();
  });

  it('a vision load that fails for a passing reason is retried, then the camera comes back', async () => {
    const r = rig();
    r.visionFails = new VisionError('load_failed');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    expect(r.camera.calls).toHaveLength(0);
    await run(r, handle, RECOVERY_DELAYS_MS[0] as number);
    expect(r.visionLoads).toBe(2); // retried after 30 s, failed again
    r.visionFails = null;
    await run(r, handle, (RECOVERY_DELAYS_MS[1] as number) + 2_000);
    expect(r.visionLoads).toBe(3);
    expect(r.camera.calls).toHaveLength(1);
    const modes = eventsOf(r.events, 'mode');
    expect(modes.map((e) => [e.mode, e.reason])).toEqual([
      ['no-camera', 'vision_failed'],
      ['camera', 'recovered'],
    ]);
    for (const e of r.events) expect(isAnalysisOutbound({ type: 'event', event: e })).toBe(true);
    const hints = eventsOf(r.events, 'hint').filter((e) => e.code === 'vision_failed');
    expect(hints.map((e) => e.active)).toEqual([true, false]);
    expect(f.observers).toHaveLength(1);
    expect(f.engine().observer).toBe(f.observers[0]);
    const report = handle.report();
    expect(report.mode).toBe('camera');
    expect(report.cameraOn).toBe(true);
    expect(report.snapshot.hints).not.toContain('vision_failed');
    expect(f.engine().ticks.at(-1)?.frame).not.toBeNull();
    await handle.stop();
    expect(r.s.pending).toBe(0);
  });

  it('5 processing failures in a row rebuild the pipeline once; the same streak again falls back', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 1_000);
    r.vision.failNext = 4;
    await run(r, handle, 6_000);
    expect(eventsOf(r.events, 'mode')).toEqual([]); // 4 failures, then it recovered
    expect(r.visionLoads).toBe(1);
    r.vision.failNext = 5;
    await run(r, handle, 8_000);
    // A WASM abort leaves the module dead: rebuilt once instead of giving up.
    expect(r.visionLoads).toBe(2);
    expect(eventsOf(r.events, 'mode')).toEqual([]);
    expect(handle.report().mode).toBe('camera');
    r.vision.failNext = 5;
    await run(r, handle, 8_000);
    expect(r.visionLoads).toBe(3); // a good frame came between the two streaks
    expect(eventsOf(r.events, 'mode')).toEqual([]);
    r.vision.failNext = 10; // two streaks with no good frame in between
    await run(r, handle, 12_000);
    expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed']);
    expect(r.camera.last.stopped).toBe(1);
    for (const source of r.camera.opened) {
      for (const frame of source.frames) expect(frame.closed).toBe(1);
    }
    await handle.stop();
  });

  describe('WebGL context lost (GPU reset, resume from sleep)', () => {
    /** A rig whose next `createVision` calls return these (a pipeline, a failure, or hang). */
    function rebuildRig(next: (FakeVision | Error | 'hang')[]): Rig & { pipelines: FakeVision[] } {
      const r = rig();
      const pipelines: FakeVision[] = [r.vision];
      r.deps.createVision = () => {
        r.visionLoads += 1;
        if (r.visionLoads === 1) return Promise.resolve(r.vision);
        const item = next.shift();
        if (item === undefined || item === 'hang') return new Promise(() => undefined);
        if (item instanceof Error) return Promise.reject(item);
        pipelines.push(item);
        return Promise.resolve(item);
      };
      return Object.assign(r, { pipelines });
    }

    it('rebuilds the pipeline at once and keeps analysing, without counting a failure', async () => {
      const fresh = new FakeVision();
      const r = rebuildRig([fresh]);
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 3_000);
      r.vision.contextLost = true;
      await run(r, handle, 3_000);
      expect(r.visionLoads).toBe(2);
      expect(r.vision.closed).toBe(1);
      expect(fresh.calls.length).toBeGreaterThan(5);
      expect(eventsOf(r.events, 'mode')).toEqual([]);
      const report = handle.report();
      expect(report.mode).toBe('camera');
      expect(report.loop?.errors).toBe(0);
      // The frames of the lost context never reached the engine as «nobody there».
      const lostAt = r.vision.calls.at(-1)?.frame.t ?? 0;
      const blind = f.engine().ticks.filter((t) => t.now >= lostAt && t.frame === null);
      expect(blind.every((t) => t.camera === 'ok')).toBe(true);
      expect(f.engine().ticks.at(-1)?.frame).not.toBeNull();
      await handle.stop();
      expect(fresh.closed).toBe(1);
    });

    it('a rebuild that fails, or takes over 30 s, switches to no-camera mode', async () => {
      for (const outcome of [new VisionError('hash_mismatch'), 'hang'] as const) {
        const r = rebuildRig([outcome]);
        const f = fakeParts();
        const handle = await startStudySessionWith(r.options(), f.parts);
        await run(r, handle, 2_000);
        r.vision.contextLost = true;
        await run(r, handle, outcome === 'hang' ? 28_000 : 1_000);
        if (outcome === 'hang') {
          expect(eventsOf(r.events, 'mode')).toEqual([]);
          await run(r, handle, 3_000);
        }
        expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed']);
        expect(handle.report().mode).toBe('no-camera');
        expect(r.camera.last.stopped).toBe(1);
        await handle.stop();
      }
    });

    it('a slow rebuild keeps the camera healthy: frames are taken and closed, nothing absent', async () => {
      const r = rebuildRig(['hang']);
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 2_000);
      const source = r.camera.last;
      const grabbed = source.frames.length;
      r.vision.contextLost = true;
      await run(r, handle, 25_000); // 25 s rebuild (a slow laptop after resume)
      expect(eventsOf(r.events, 'mode')).toEqual([]);
      expect(source.frames.length).toBeGreaterThan(grabbed + 20); // ~1 per second
      for (const frame of source.frames) expect(frame.closed).toBe(1);
      expect(source.stopped).toBe(0);
      const lostAt = r.vision.calls.at(-1)?.frame.t ?? 0;
      const blind = f.engine().ticks.filter((t) => t.now > lostAt);
      expect(blind.length).toBeGreaterThan(20);
      expect(blind.every((t) => t.frame === null && t.camera === 'ok')).toBe(true);
      expect(handle.report().snapshot.hints).not.toContain('camera_lost');
      expect(eventsOf(r.events, 'camera').filter((e) => e.status === 'error')).toEqual([]);
      await handle.stop();
    });

    it('a rebuild that failed for a passing reason is retried and adopted late', async () => {
      const r = rebuildRig([]);
      let answer: ((vision: FakeVision) => void) | null = null;
      r.deps.createVision = () => {
        r.visionLoads += 1;
        if (r.visionLoads === 1) return Promise.resolve(r.vision);
        return new Promise((resolve) => {
          answer = resolve;
        });
      };
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 2_000);
      r.vision.contextLost = true;
      await run(r, handle, 31_000);
      expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed']);
      // The rebuild finally loads (seconds after its deadline): used to recover at once.
      const late = new FakeVision(r.s);
      (answer as unknown as (vision: FakeVision) => void)(late);
      await run(r, handle, 3_000);
      expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual([
        'vision_failed',
        'recovered',
      ]);
      expect(late.calls.length).toBeGreaterThan(3);
      expect(late.closed).toBe(0);
      await handle.stop();
      expect(late.closed).toBe(1);
    });

    it('a second loss within 60 s of a rebuild gives up; a later one rebuilds again', async () => {
      const second = new FakeVision();
      const third = new FakeVision();
      const r = rebuildRig([second, third]);
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 2_000);
      r.vision.contextLost = true;
      await run(r, handle, 61_000);
      second.contextLost = true;
      await run(r, handle, 2_000);
      expect(r.visionLoads).toBe(3); // 70 s later: rebuilt again
      expect(eventsOf(r.events, 'mode')).toEqual([]);
      third.contextLost = true;
      await run(r, handle, 2_000);
      expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed']);
      // A broken GPU is still retried, with backoff (30 s, 60 s, …).
      expect(handle.report().mode).toBe('no-camera');
      await handle.stop();
    });

    it('resume() rebuilds a pipeline whose context was lost before its next frame', async () => {
      const fresh = new FakeVision();
      const r = rebuildRig([fresh]);
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 2_000);
      r.vision.contextLost = true;
      const processed = r.vision.calls.length;
      handle.resume();
      expect(r.visionLoads).toBe(2);
      await run(r, handle, 2_000);
      expect(r.vision.calls.length).toBe(processed);
      expect(fresh.calls.length).toBeGreaterThan(0);
      await handle.stop();
    });

    it('stop() during a rebuild closes the late pipeline', async () => {
      const r = rig();
      let resolve: ((v: FakeVision) => void) | null = null;
      r.deps.createVision = () => {
        r.visionLoads += 1;
        if (r.visionLoads === 1) return Promise.resolve(r.vision);
        return new Promise((ok) => {
          resolve = ok;
        });
      };
      const f = fakeParts();
      const handle = await startStudySessionWith(r.options(), f.parts);
      await run(r, handle, 1_000);
      r.vision.contextLost = true;
      await run(r, handle, 1_000);
      await handle.stop();
      const late = new FakeVision();
      (resolve as unknown as (v: FakeVision) => void)(late);
      await r.s.advance(10);
      expect(late.closed).toBe(1);
      expect(late.calls).toEqual([]);
    });
  });

  it('feeds the process-CPU probe to the governor, which slows the loop down', async () => {
    const r = rig();
    let pct = 5;
    r.deps.cpuProbe = () => pct;
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 4_000);
    expect(handle.report().loop?.level).toBe(1);
    expect(handle.report().loop?.processCpuPct).toBe(5);
    pct = 30; // measured over the 12 % limit
    await run(r, handle, 30_000);
    const loop = handle.report().loop;
    expect(loop?.processCpuPct).toBe(30);
    expect(loop?.level).toBe(5); // down to the emergency level
    expect(loop?.overBudget).toBe(true);
    expect(handle.report().snapshot.hints).toContain('over_budget');
    await handle.stop();
  });

  it('a camera that cannot be opened at start runs the session without camera (never rejects)', async () => {
    // Main starts the analysis after the guardian accepted the session: rejecting here would
    // leave that session without reports, heartbeats, and so abandoned and punished.
    const r = rig();
    r.camera.failWith = new CameraError('permission_denied');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    expect(r.vision.closed).toBe(1); // a denied permission will not pass: nothing kept
    expect(f.observers).toHaveLength(0);
    expect(f.engine().observer).toBeInstanceOf(NoCameraObserver);
    expect(r.events).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'error', error: 'permission_denied' },
      { type: 'mode', at: expect.any(Number), mode: 'no-camera', reason: 'vision_failed' },
    ]);
    for (const event of r.events) expect(isAnalysisOutbound({ type: 'event', event })).toBe(true);
    await run(r, handle, 3_000);
    const report = r.reports[r.reports.length - 1] as SessionReport;
    expect(report.mode).toBe('no-camera');
    expect(report.cameraOn).toBe(false);
    expect(report.totals.ticks).toBeGreaterThan(0);
    // The camera error explains it: not the «the AI could not start» hint.
    expect(report.snapshot.hints).not.toContain('vision_failed');
    await run(r, handle, 600_000);
    expect(r.camera.calls).toHaveLength(1); // never retried: the user must allow it first
    expect(handle.continueWithoutCamera()).toBe(false); // already without camera
    expect(handle.studyingFeedback()).toEqual({ ok: false, reason: 'no_camera' });
    await handle.stop();
    expect(r.s.pending).toBe(0);
  });

  it('a camera busy at start (a video call) is retried and the session goes back to camera mode', async () => {
    const r = rig();
    r.camera.failWith = new CameraError('in_use');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    expect(r.vision.closed).toBe(0); // kept for the retries
    await run(r, handle, (RECOVERY_DELAYS_MS[0] as number) + 1_000);
    expect(r.camera.calls).toHaveLength(2); // retried at 30 s: still busy
    expect(handle.report().mode).toBe('no-camera');
    r.camera.failWith = null; // the call ended
    await run(r, handle, RECOVERY_DELAYS_MS[1] as number);
    expect(r.camera.calls).toHaveLength(3);
    expect(r.visionLoads).toBe(1); // the pipeline was kept, not reloaded
    const recovered = r.events.slice(2);
    expect(recovered.slice(0, 2)).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'starting', error: null },
      { type: 'mode', at: expect.any(Number), mode: 'camera', reason: 'recovered' },
    ]);
    expect(handle.report().mode).toBe('camera');
    expect(handle.report().cameraOn).toBe(true);
    expect(f.engine().observerSwaps).toEqual([f.observers[0]]);
    expect(f.engine().ticks.at(-1)?.frame).not.toBeNull();
    await handle.stop();
    expect(r.s.pending).toBe(0);
  });

  it('«Seguir sin cámara» after a start-time failure stops the retries', async () => {
    const r = rig();
    r.camera.failWith = new CameraError('in_use');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 2_000);
    expect(handle.continueWithoutCamera()).toBe(true);
    expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed', 'user']);
    expect(r.vision.closed).toBe(1);
    r.camera.failWith = null;
    await run(r, handle, 600_000);
    expect(r.camera.calls).toHaveLength(1);
    expect(handle.report().mode).toBe('no-camera');
    expect(handle.continueWithoutCamera()).toBe(false);
    await handle.stop();
  });

  it('a camera that never answers at start gives up after 15 s and stops the late stream', async () => {
    const r = rig();
    r.camera.hang = true; // wedged driver: getUserMedia never settles
    const f = fakeParts();
    let handle: StudySessionHandle | null = null;
    void startStudySessionWith(r.options(), f.parts).then((h) => {
      handle = h;
    });
    await r.s.advance(14_000);
    expect(handle).toBeNull();
    await r.s.advance(1_500);
    expect(handle).not.toBeNull();
    expect(eventsOf(r.events, 'camera')).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'error', error: 'unknown' },
    ]);
    expect(eventsOf(r.events, 'mode')).toHaveLength(1);
    expect(r.vision.closed).toBe(0); // kept: a camera that did not answer is retried
    // The stream arrives much later: released at once, never analysed.
    const late = r.camera.answerHung();
    await r.s.advance(1_000);
    expect(late).toHaveLength(1);
    expect(late[0]?.stopped).toBe(1);
    expect(late[0]?.frames).toHaveLength(0);
    expect(r.reports[r.reports.length - 1]?.mode).toBe('no-camera');
    await (handle as unknown as StudySessionHandle).stop();
  });

  it('a vision load that never settles gives up after 30 s; a late pipeline brings the camera back', async () => {
    const r = rig();
    const lateVision = new FakeVision(r.s);
    let answer: ((vision: FakeVision) => void) | null = null;
    r.deps.createVision = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const f = fakeParts();
    let handle: StudySessionHandle | null = null;
    void startStudySessionWith(r.options(), f.parts).then((h) => {
      handle = h;
    });
    await r.s.advance(29_000);
    expect(handle).toBeNull();
    await r.s.advance(1_500);
    expect(handle).not.toBeNull();
    expect(r.camera.calls).toHaveLength(0); // never on while MediaPipe loads
    expect(eventsOf(r.events, 'mode')).toEqual([
      { type: 'mode', at: expect.any(Number), mode: 'no-camera', reason: 'vision_failed' },
    ]);
    // A slow laptop finishes compiling the WASM at 35 s: adopted, not thrown away.
    (answer as unknown as (vision: FakeVision) => void)(lateVision);
    const h = handle as unknown as StudySessionHandle;
    await run(r, h, 3_000);
    expect(r.camera.calls).toHaveLength(1);
    expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed', 'recovered']);
    expect(lateVision.closed).toBe(0);
    expect(lateVision.calls.length).toBeGreaterThan(3);
    await h.stop();
    expect(lateVision.closed).toBe(1);
  });

  it('opens the camera only once the vision pipeline is ready, and says so before any report', async () => {
    const r = rig();
    let answer: ((vision: FakeVision) => void) | null = null;
    r.deps.createVision = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const f = fakeParts();
    let handle: StudySessionHandle | null = null;
    void startStudySessionWith(r.options(), f.parts).then((h) => {
      handle = h;
    });
    await r.s.advance(8_000); // MediaPipe compiling on a slow laptop
    expect(r.camera.calls).toHaveLength(0); // the camera light is off meanwhile
    (answer as unknown as (vision: FakeVision) => void)(r.vision);
    await r.s.advance(1);
    expect(r.camera.calls).toHaveLength(1);
    expect(handle).not.toBeNull();
    expect(r.reports).toHaveLength(0);
    expect(r.events[0]).toEqual({
      type: 'camera',
      at: expect.any(Number),
      status: 'starting',
      error: null,
    });
    await (handle as unknown as StudySessionHandle).stop();
  });

  it('a reopen that hangs mid-session gives up after 15 s and keeps retrying', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 2_000);
    r.camera.hang = true;
    r.camera.last.status = 'error'; // unplugged; the reopen never answers
    await run(r, handle, 14_000);
    expect(r.camera.calls).toHaveLength(2); // still waiting on the first reopen
    await run(r, handle, 3_000);
    expect(r.camera.calls.length).toBeGreaterThanOrEqual(3); // gave up, retried
    await run(r, handle, 14_000);
    // Failing for 30 s: «Continuar sin cámara» is offered with the timeout's code.
    expect(eventsOf(r.events, 'camera').filter((e) => e.status === 'error')).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'error', error: 'unknown' },
    ]);
    // The driver wakes up: the timed-out stream is stopped, the one still in time is used.
    r.camera.hang = false;
    const answered = r.camera.answerHung();
    await run(r, handle, 12_000);
    expect(answered[0]?.stopped).toBe(1);
    expect(r.reports[r.reports.length - 1]?.camera).toBe('ok');
    expect(r.reports[r.reports.length - 1]?.cameraOn).toBe(true);
    await handle.stop();
  });

  it('no-camera mode never opens the camera and ticks at 1 Hz', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(
      r.options({ mode: 'no-camera', assets: null }),
      f.parts,
    );
    await run(r, handle, 10_000);
    expect(r.camera.calls).toHaveLength(0);
    expect(r.visionLoads).toBe(0);
    const ticks = f.engine().ticks;
    expect(ticks.length).toBeGreaterThanOrEqual(9);
    expect(ticks.length).toBeLessThanOrEqual(11);
    expect(handle.studyingFeedback()).toEqual({ ok: false, reason: 'no_camera' });
    await handle.stop();
  });

  it('treats context older than 5 s as unknown foreground and idle', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await r.s.advance(4_000);
    expect(f.engine().ticks[f.engine().ticks.length - 1]?.context).toEqual({
      foreground: 'study',
      idleMs: 2_000,
    });
    await r.s.advance(3_000);
    const last = f.engine().ticks[f.engine().ticks.length - 1];
    expect(last?.context).toEqual({ foreground: 'unknown', idleMs: null });
    expect(last?.phase).toBe('work');
    await handle.stop();
  });

  it('forwards settings, strike results and resume', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(
      r.options({ settings: { doubtAfterMs: 20_000 } }),
      f.parts,
    );
    handle.setSettings({ focusScoreThreshold: 999 });
    const engine = f.engine();
    expect(engine.settings.doubtAfterMs).toBe(20_000);
    expect(engine.settings.focusScoreThreshold).toBe(80); // clamped
    handle.strikeResult({ seq: 1, counted: false, reason: 'cooldown', cooldownLeftMs: 5_000 });
    expect(engine.acks).toHaveLength(1);
    await run(r, handle, 1_000);
    const resets = r.vision.resets;
    handle.resume();
    expect(engine.resumes).toHaveLength(1);
    expect(r.vision.resets).toBe(resets + 1);
    await handle.stop();
  });

  it('stop() releases everything, sends a final report and is idempotent', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 3_000);
    const reports = r.reports.length;
    const summary = await handle.stop();
    expect(r.reports.length).toBe(reports + 1);
    expect(r.camera.last.stopped).toBe(1);
    expect(r.vision.closed).toBe(1);
    expect(summary.totals.ticks).toBe(f.engine().ticks.length);
    expect(isAnalysisOutbound({ type: 'session_stopped', summary })).toBe(true);
    const ticks = f.engine().ticks.length;
    await r.s.advance(5_000);
    expect(f.engine().ticks.length).toBe(ticks);
    expect(r.s.pending).toBe(0);
    expect(await handle.stop()).toBe(summary);
    expect(r.camera.last.stopped).toBe(1);
  });

  it('survives throwing listeners and a failing engine tick', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(
      r.options({
        onEvent: () => {
          throw new Error('listener');
        },
        onReport: () => {
          throw new Error('listener');
        },
      }),
      f.parts,
    );
    await run(r, handle, 2_000);
    f.engine().failTicks = true;
    await run(r, handle, 2_000);
    f.engine().failTicks = false;
    await run(r, handle, 2_000);
    expect(handle.report().loop?.errors).toBeGreaterThan(0);
    expect(f.engine().ticks.length).toBeGreaterThan(10);
    await handle.stop();
  });

  it('uses the personal classifier only for the calibrated camera, else generic + recalibrate', async () => {
    const profileJson = serializeProfile(profileFor('baseline'));

    const r1 = rig();
    const f1 = fakeParts();
    const h1 = await startStudySessionWith(r1.options({ profileJson }), f1.parts);
    expect(f1.observers[0]?.classifier.kind).toBe('personal');
    expect(f1.observers[0]?.fallback?.kind).toBe('generic');
    expect(eventsOf(r1.events, 'hint')).toEqual([]);
    await h1.stop();

    const r2 = rig();
    r2.camera.identity = { key: `sha256:${'b'.repeat(64)}`, aspect: 4 / 3 };
    const f2 = fakeParts();
    const h2 = await startStudySessionWith(r2.options({ profileJson }), f2.parts);
    expect(f2.observers[0]?.classifier.kind).toBe('generic');
    expect(eventsOf(r2.events, 'hint')).toEqual([
      { type: 'hint', at: expect.any(Number), code: 'recalibrate', active: true },
    ]);
    await run(r2, h2, 1_000);
    expect(r2.reports[0]?.snapshot.hints).toContain('recalibrate');
    await h2.stop();

    const r3 = rig();
    const f3 = fakeParts();
    const h3 = await startStudySessionWith(r3.options({ profileJson: '{broken' }), f3.parts);
    expect(f3.observers[0]?.classifier.kind).toBe('generic');
    expect(eventsOf(r3.events, 'hint').map((e) => e.code)).toEqual(['recalibrate']);
    await h3.stop();
  });

  it('re-picks the classifier when another camera shows up after a reopen', async () => {
    const r = rig();
    const f = fakeParts();
    const profileJson = serializeProfile(profileFor('baseline'));
    const handle = await startStudySessionWith(r.options({ profileJson }), f.parts);
    await run(r, handle, 2_000);
    r.camera.identity = { key: `sha256:${'c'.repeat(64)}`, aspect: 16 / 9 };
    r.camera.last.status = 'error';
    await run(r, handle, 3_000);
    const observer = f.observers[0];
    expect(observer?.swaps.map((c) => c.kind)).toEqual(['generic']);
    expect(eventsOf(r.events, 'hint').map((e) => e.code)).toEqual(['recalibrate']);
    await handle.stop();
  });

  it('migrates a profile from another trainer version and asks main to persist it', async () => {
    const profile = profileFor('baseline');
    const old = JSON.parse(serializeProfile(profile)) as { trainer: number };
    old.trainer = 2; // trained by another trainer version
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(
      r.options({ profileJson: JSON.stringify(old) }),
      f.parts,
    );
    const updated = eventsOf(r.events, 'profile_updated');
    expect(updated.map((e) => e.reason)).toEqual(['migrated']);
    expect(JSON.parse(updated[0]?.profileJson ?? '{}').trainer).toBe(profile.trainer);
    expect(f.observers[0]?.classifier.kind).toBe('personal');
    await handle.stop();
  });
});

describe('«¡Estaba estudiando!» through the facade', () => {
  const profile = profileFor('baseline');
  const profileJson = serializeProfile(profile);
  const frames = synthesize([['notebook', 20_000]], { persona: PERSONAS.baseline, seed: 3 })
    .map((t) => t.frame)
    .filter((fr): fr is NonNullable<typeof fr> => fr !== null)
    .slice(0, 30);
  const episode: FeedbackEpisode = {
    ok: true,
    episodeId: 7,
    trigger: 'doubt',
    frames: frames.map((frame) => ({ frame, rel: null, book: false, lookingDown: true })),
  };

  it('retrains, swaps the classifier, applies the episode and persists the profile', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ profileJson }), f.parts);
    const engine = f.engine();
    engine.episode = episode;
    const cleared: AttentionEvent = { type: 'doubt_cleared', at: 1, by: 'feedback' };
    engine.applyEvents = [cleared];

    const outcome = handle.studyingFeedback();
    expect(outcome).toEqual({ ok: true, added: expect.any(Number), doubtCleared: true });
    if (outcome.ok) expect(outcome.added).toBeGreaterThan(0);
    expect(engine.applied).toEqual([7]);
    const observer = f.observers[0];
    expect(observer?.swaps).toHaveLength(1);
    expect(observer?.swaps[0]?.kind).toBe('personal');
    expect(r.events).toContainEqual(cleared);
    const updated = eventsOf(r.events, 'profile_updated');
    expect(updated.map((e) => e.reason)).toEqual(['feedback']);
    const saved = JSON.parse(updated[0]?.profileJson ?? '{}') as { samples: { src: number[] } };
    expect(saved.samples.src.filter((s) => s === 1).length).toBeGreaterThan(0);
    await handle.stop();
  });

  it('passes the engine rejection through and never retrains without a profile', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ profileJson }), f.parts);
    f.engine().episode = { ok: false, reason: 'limit_reached' };
    expect(handle.studyingFeedback()).toEqual({ ok: false, reason: 'limit_reached' });
    expect(eventsOf(r.events, 'profile_updated')).toEqual([]);
    await handle.stop();

    const r2 = rig();
    const f2 = fakeParts();
    const h2 = await startStudySessionWith(r2.options(), f2.parts);
    f2.engine().episode = episode;
    expect(h2.studyingFeedback()).toEqual({ ok: false, reason: 'not_calibrated' });
    expect(f2.engine().applied).toEqual([]);
    await h2.stop();
  });

  it('reports no_usable_frames when the moment had nobody in view', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ profileJson }), f.parts);
    const empty = synthesize([['absent', 10_000]], { seed: 4 })
      .map((t) => t.frame)
      .filter((fr): fr is NonNullable<typeof fr> => fr !== null)
      .slice(0, 10);
    f.engine().episode = {
      ok: true,
      episodeId: 1,
      trigger: 'away',
      frames: empty.map((frame) => ({ frame, rel: null, book: false, lookingDown: false })),
    };
    expect(handle.studyingFeedback()).toEqual({ ok: false, reason: 'no_usable_frames' });
    expect(f.engine().applied).toEqual([]);
    await handle.stop();
  });
});

describe('study session facade with the real engine', () => {
  it('runs end to end in Node and reports valid snapshots', async () => {
    const r = rig();
    r.vision.features = replay(
      synthesize([['screen', 20_000]], { persona: PERSONAS.baseline, seed: 1 })
        .map((t) => t.frame)
        .filter((fr): fr is NonNullable<typeof fr> => fr !== null),
    );
    const handle = await startStudySession(r.options());
    await run(r, handle, 15_000);
    const last = r.reports[r.reports.length - 1] as SessionReport;
    expect(isAnalysisOutbound({ type: 'report', report: last })).toBe(true);
    expect(last.snapshot.state).toBe('focused');
    expect(last.snapshot.classifier).toBe('generic');
    expect(last.totals.ticks).toBeGreaterThan(30);
    const summary = await handle.stop();
    expect(summary.timeline.durationMs).toBeGreaterThan(10_000);
    expect(isAnalysisOutbound({ type: 'session_stopped', summary })).toBe(true);
  });
});

describe('study session facade: the chosen camera, by label', () => {
  const USB = 'Logitech C920 (046d:082d)';
  const BUILT_IN = 'FaceTime HD Camera';
  const USB_ID = { key: `sha256:${'b'.repeat(64)}`, aspect: 4 / 3 };

  it('resolves the label in this window: the id main never had is found by enumeration', async () => {
    const r = rig();
    r.camera.devices = [
      { deviceId: 'salted-built-in', label: BUILT_IN },
      { deviceId: 'salted-usb', label: USB },
    ];
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ cameraLabel: USB }), f.parts);
    expect(r.camera.calls.map((c) => c.deviceId)).toEqual(['salted-usb']);
    await run(r, handle, 3_000);
    expect(handle.report().snapshot.hints).not.toContain('camera_default');
    await handle.stop();
  });

  it('unplugged and replugged into another port (new deviceId): back on the same camera', async () => {
    const r = rig();
    r.camera.devices = [{ deviceId: 'usb-port-1', label: USB }];
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ cameraLabel: USB }), f.parts);
    await run(r, handle, 2_000);
    r.camera.devices = [];
    r.camera.last.status = 'error'; // unplugged
    await run(r, handle, 25_000);
    expect(handle.report().camera).toBe('error'); // nothing to open: fails closed meanwhile
    r.camera.devices = [{ deviceId: 'usb-port-2', label: USB }]; // a new raw id
    await run(r, handle, 11_000);
    expect(r.camera.last.deviceId).toBe('usb-port-2');
    const report = handle.report();
    expect(report.camera).toBe('ok');
    expect(report.cameraOn).toBe(true);
    expect(report.snapshot.hints).not.toContain('camera_default');
    // The old id was never retried: every open resolved the label again.
    expect(r.camera.calls.filter((c) => c.deviceId === 'usb-port-1')).toHaveLength(1);
    await handle.stop();
  });

  it('a chosen camera that is missing: the default one, with the `camera_default` hint', async () => {
    const r = rig();
    r.camera.devices = [{ deviceId: 'built-in', label: BUILT_IN }];
    r.camera.identities.set(USB, USB_ID);
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options({ cameraLabel: USB }), f.parts);
    expect(r.camera.last.deviceId).toBeNull(); // the default camera
    expect(handle.report().mode).toBe('camera');
    expect(handle.report().snapshot.hints).toContain('camera_default');
    const hint = eventsOf(r.events, 'hint').find((e) => e.code === 'camera_default');
    expect(hint?.active).toBe(true);
    for (const e of r.events) expect(isAnalysisOutbound({ type: 'event', event: e })).toBe(true);

    // Plugged in during a break: the reopen after the break finds it.
    r.camera.devices = [
      { deviceId: 'built-in', label: BUILT_IN },
      { deviceId: 'usb', label: USB },
    ];
    await run(r, handle, 12_000, { ...WORK, phase: 'break' });
    await run(r, handle, 2_000);
    expect(r.camera.last.deviceId).toBe('usb');
    expect(handle.report().snapshot.hints).not.toContain('camera_default');
    const hints = eventsOf(r.events, 'hint').filter((e) => e.code === 'camera_default');
    expect(hints.map((e) => e.active)).toEqual([true, false]);
    await handle.stop();
  });

  it('a stale raw deviceId (another partition, an earlier run) falls back instead of failing', async () => {
    const r = rig();
    r.camera.devices = [{ deviceId: 'this-window-id', label: BUILT_IN }];
    const f = fakeParts();
    const handle = await startStudySessionWith(
      r.options({ cameraDeviceId: 'id-from-the-settings-window' }),
      f.parts,
    );
    expect(handle.report().mode).toBe('camera'); // not a silent no-camera session
    expect(r.camera.last.deviceId).toBeNull();
    await handle.stop();
  });
});

describe('study session facade: a video on another display', () => {
  it('maps `visibleDistraction` with idle input to a distraction in the foreground', () => {
    const base: ContextInput = { phase: 'work', foreground: 'study', idleMs: 0 };
    expect(engineContext(base)).toEqual({ foreground: 'study', idleMs: 0 });
    const idle = VISIBLE_DISTRACTION_IDLE_MS;
    expect(engineContext({ ...base, visibleDistraction: true, idleMs: idle - 1 })).toEqual({
      foreground: 'study',
      idleMs: idle - 1,
    });
    expect(engineContext({ ...base, visibleDistraction: true, idleMs: idle })).toEqual({
      foreground: 'distraction',
      idleMs: idle,
    });
    // Idle unknown: cannot tell watching from working.
    expect(engineContext({ ...base, visibleDistraction: true, idleMs: null }).foreground).toBe(
      'study',
    );
    expect(engineContext({ ...base, visibleDistraction: false, idleMs: idle }).foreground).toBe(
      'study',
    );
  });

  it('hands the engine the mapped context, and forgets the flag when main goes quiet', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    const watching: ContextInput = { ...WORK, idleMs: 30_000, visibleDistraction: true };
    await run(r, handle, 3_000, watching);
    const engine = f.engine();
    expect(engine.ticks.at(-1)?.context).toEqual({ foreground: 'distraction', idleMs: 30_000 });
    await run(r, handle, 2_000, { ...watching, idleMs: 500 }); // typing in the notes
    expect(engine.ticks.at(-1)?.context.foreground).toBe('study');
    handle.setContext(watching);
    await r.s.advance(7_000); // no context for 7 s: stale
    expect(engine.ticks.at(-1)?.context).toEqual({ foreground: 'unknown', idleMs: null });
    await handle.stop();
  });
});

describe('study session facade: the governor alert', () => {
  it('a phone in view keeps the detector at ≥ 1 Hz for 20 s, even at the slowest level', async () => {
    const r = rig();
    r.vision.cost = { faceMs: 30, objectMs: 0, lumaMs: 0.5, totalMs: 30.5 };
    r.vision.objectMs = 60; // L4: (30.5 + 60 / 8) / 500 = 0.076
    let phone = false;
    r.vision.features = (frame, index) => {
      const base = plainFeatures(frame.t);
      const ran = r.vision.calls[index]?.options.objects === true;
      if (!ran) return base;
      return {
        ...base,
        objects: {
          ranAt: frame.t,
          ageMs: 0,
          fresh: true,
          phone: phone
            ? {
                score: 0.8,
                box: { cx: 0.5, cy: 0.8, w: 0.12, h: 0.18 },
                nearFace: true,
                moving: false,
                stillMs: 4_000,
              }
            : null,
          book: null,
          person: { score: 0.9, box: { cx: 0.5, cy: 0.6, w: 0.6, h: 0.8 } },
        },
      };
    };
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 20_000);
    expect(handle.report().loop?.level).toBe(4);
    const runsIn = (from: number, to: number): number =>
      r.vision.calls.filter((c) => c.options.objects && c.frame.t >= from && c.frame.t < to).length;
    const t0 = r.s.t;
    expect(runsIn(t0 - 16_000, t0)).toBeLessThanOrEqual(5); // every 4 s
    phone = true;
    await run(r, handle, 10_000);
    const t1 = r.s.t;
    // Seen within one slow run (≤ 4 s), then ≥ 1 Hz.
    expect(runsIn(t1 - 5_000, t1)).toBeGreaterThanOrEqual(4);
    phone = false;
    await run(r, handle, PHONE_ALERT_MS + 12_000);
    const t2 = r.s.t;
    expect(runsIn(t2 - 8_000, t2)).toBeLessThanOrEqual(3); // back to every 4 s
    expect(handle.report().loop?.level).toBe(4); // the alert never walked the levels down
    await handle.stop();
  });

  it('a phone lying still (at rest) does not raise the detector rate', async () => {
    const r = rig();
    r.vision.cost = { faceMs: 30, objectMs: 0, lumaMs: 0.5, totalMs: 30.5 };
    r.vision.objectMs = 60;
    r.vision.features = (frame, index) => {
      const base = plainFeatures(frame.t);
      if (r.vision.calls[index]?.options.objects !== true) return base;
      return {
        ...base,
        objects: {
          ranAt: frame.t,
          ageMs: 0,
          fresh: true,
          phone: {
            score: 0.6,
            box: { cx: 0.8, cy: 0.9, w: 0.1, h: 0.08 },
            nearFace: false,
            moving: false,
            stillMs: 120_000,
          },
          book: null,
          person: null,
        },
      };
    };
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 40_000);
    const t = r.s.t;
    const runs = r.vision.calls.filter((c) => c.options.objects && c.frame.t >= t - 16_000);
    expect(runs.length).toBeLessThanOrEqual(5);
    await handle.stop();
  });
});
