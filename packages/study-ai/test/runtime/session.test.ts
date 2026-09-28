/**
 * Study session facade wiring (fake camera, fake vision, fake engine and observer), then the
 * same facade with DECISION's real engine and observer.
 */
import { describe, expect, it } from 'vitest';
import { serializeProfile } from '../../src/calibration/profile';
import { isAnalysisOutbound } from '../../src/runtime/ipc';
import { NoCameraObserver } from '../../src/runtime/no-camera';
import { startStudySession, startStudySessionWith } from '../../src/runtime/session';
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
    expect(eventsOf(r.events, 'camera')).toEqual([
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
    expect(eventsOf(r.events, 'camera').map((e) => e.status)).toEqual(['ok', 'off']);

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
    expect(eventsOf(r.events, 'camera').map((e) => e.status)).toEqual(['ok', 'off', 'ok']);
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

  it('vision that fails to load falls back to no-camera mode at start', async () => {
    const r = rig();
    r.visionFails = new VisionError('simd_unsupported');
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    expect(r.camera.opened[0]?.stopped).toBe(1);
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
    await handle.stop();
  });

  it('5 processing failures in a row switch to no-camera mode', async () => {
    const r = rig();
    const f = fakeParts();
    const handle = await startStudySessionWith(r.options(), f.parts);
    await run(r, handle, 1_000);
    r.vision.failNext = 4;
    await run(r, handle, 6_000);
    expect(eventsOf(r.events, 'mode')).toEqual([]); // 4 failures, then it recovered
    r.vision.failNext = 5;
    await run(r, handle, 8_000);
    expect(eventsOf(r.events, 'mode').map((e) => e.reason)).toEqual(['vision_failed']);
    expect(r.camera.last.stopped).toBe(1);
    for (const frame of r.camera.last.frames) expect(frame.closed).toBe(1);
    await handle.stop();
  });

  it('rejects with the CameraOpenError when the camera cannot be opened', async () => {
    const r = rig();
    r.camera.failWith = new CameraError('permission_denied');
    const f = fakeParts();
    await expect(startStudySessionWith(r.options(), f.parts)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(r.vision.closed).toBe(1);
    expect(r.s.pending).toBe(0);
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
