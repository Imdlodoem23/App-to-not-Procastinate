import { describe, expect, it } from 'vitest';
import { createAnalysisHost } from '../../src/runtime/analysis-host';
import { isAnalysisOutbound } from '../../src/runtime/ipc';
import type {
  AnalysisInbound,
  AnalysisOutbound,
  ContextInput,
  SessionDeps,
  VisionAssets,
} from '../../src/types';
import { calibrationFrames, PERSONAS, synthesize } from '../synth';
import { CameraError, FakeCamera, FakeScheduler, FakeVision, VisionError, replay } from './fakes';

const ASSETS: VisionAssets = {
  wasmBaseUrl: 'centrate-ai://assets/mediapipe',
  faceModel: { url: 'centrate-ai://assets/models/face_landmarker.task' },
  objectModel: { url: 'centrate-ai://assets/models/efficientdet_lite0_int8.tflite' },
};

const WORK: ContextInput = { phase: 'work', foreground: 'study', idleMs: 1_000 };

function rig(visionFails: unknown = null) {
  const s = new FakeScheduler(10_000);
  const camera = new FakeCamera(s);
  const vision = new FakeVision();
  const posted: AnalysisOutbound[] = [];
  const deps: Partial<SessionDeps> = {
    clock: s,
    timers: s,
    openCamera: camera.open,
    createVision: () =>
      visionFails === null ? Promise.resolve(vision) : Promise.reject(visionFails),
    nowIso: () => '2026-09-28T10:00:00.000Z',
    randomId: () => 'hostrun1',
  };
  const host = createAnalysisHost({
    post: (message) => {
      // Main validates every message; the host must never post anything invalid.
      expect(isAnalysisOutbound(message), JSON.stringify(message).slice(0, 120)).toBe(true);
      posted.push(message);
    },
    assets: ASSETS,
    deps,
  });
  const send = (message: AnalysisInbound | unknown): void => host.handle(message);
  const ofType = <T extends AnalysisOutbound['type']>(type: T) =>
    posted.filter((m): m is Extract<AnalysisOutbound, { type: T }> => m.type === type);
  return { s, camera, vision, posted, host, send, ofType };
}

const start = (mode: 'camera' | 'no-camera' = 'camera'): AnalysisInbound => ({
  type: 'session_start',
  mode,
  settings: {},
  profileJson: null,
  cameraDeviceId: null,
  context: WORK,
});

describe('analysis host', () => {
  it('answers invalid messages with invalid_message and nothing else', async () => {
    const r = rig();
    r.send({ type: 'session_start' });
    r.send({ type: 'context', context: { ...WORK, extra: 1 } });
    r.send('resume');
    await r.s.advance(100);
    expect(r.posted).toEqual([
      { type: 'error', code: 'invalid_message', camera: null },
      { type: 'error', code: 'invalid_message', camera: null },
      { type: 'error', code: 'invalid_message', camera: null },
    ]);
    expect(r.camera.calls).toHaveLength(0);
  });

  it('answers session and calibration messages with not_running when idle', async () => {
    const r = rig();
    r.send({ type: 'studying_feedback' });
    r.send({ type: 'calibration_build' });
    await r.s.advance(10);
    expect(r.ofType('error').map((e) => e.code)).toEqual(['not_running', 'not_running']);
  });

  it('runs a study session: queued context, reports, feedback, stop', async () => {
    const r = rig();
    r.vision.features = replay(
      synthesize([['screen', 30_000]], { persona: PERSONAS.baseline, seed: 2 })
        .map((t) => t.frame)
        .filter((f): f is NonNullable<typeof f> => f !== null),
    );
    r.send(start());
    // Sent before the session finished starting: queued and replayed.
    r.send({ type: 'context', context: { ...WORK, foreground: 'neutral' } });
    r.send(start());
    for (let i = 0; i < 12; i += 1) {
      r.send({ type: 'context', context: WORK });
      await r.s.advance(1_000);
    }
    expect(r.ofType('error')).toEqual([{ type: 'error', code: 'busy', camera: null }]);
    const reports = r.ofType('report');
    expect(reports.length).toBeGreaterThanOrEqual(10);
    expect(reports.every((m) => m.report.runId === 'hostrun1')).toBe(true);
    expect(r.ofType('event').some((m) => m.event.type === 'camera')).toBe(true);

    r.send({ type: 'studying_feedback' });
    expect(r.ofType('feedback_result')).toEqual([
      { type: 'feedback_result', outcome: { ok: false, reason: 'not_calibrated' } },
    ]);
    r.send({
      type: 'strike_result',
      ack: { seq: 1, counted: true, reason: null, cooldownLeftMs: 60_000 },
    });
    r.send({ type: 'resume' });
    r.send({ type: 'continue_without_camera' }); // camera fine: refused silently
    r.send({ type: 'settings', settings: { focusScoreThreshold: 70 } });

    r.send({ type: 'session_stop' });
    await r.s.advance(10);
    const stopped = r.ofType('session_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.summary.totals.ticks).toBeGreaterThan(20);
    expect(r.camera.last.stopped).toBe(1);
    expect(r.vision.closed).toBe(1);

    // Idle again: a new session can start.
    r.send(start('no-camera'));
    await r.s.advance(2_000);
    expect(r.ofType('error').filter((e) => e.code === 'busy')).toHaveLength(1);
    await r.host.dispose();
  });

  it('a camera that cannot open at start keeps the session running without camera', async () => {
    // The guardian session already runs: the job must never go idle without a report.
    const r = rig();
    r.camera.failWith = new CameraError('blocked_by_system');
    r.send(start());
    r.send({ type: 'context', context: WORK });
    r.send({ type: 'studying_feedback' });
    await r.s.advance(2_500);
    expect(r.ofType('error')).toEqual([]);
    expect(r.ofType('event').map((m) => m.event)).toEqual([
      { type: 'camera', at: expect.any(Number), status: 'error', error: 'blocked_by_system' },
      { type: 'mode', at: expect.any(Number), mode: 'no-camera', reason: 'vision_failed' },
    ]);
    // The queued «¡Estaba estudiando!» is answered by the running session.
    expect(r.ofType('feedback_result')).toEqual([
      { type: 'feedback_result', outcome: { ok: false, reason: 'no_camera' } },
    ]);
    const reports = r.ofType('report');
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports.every((m) => m.report.mode === 'no-camera' && !m.report.cameraOn)).toBe(true);
    r.send({ type: 'session_stop' });
    await r.s.advance(10);
    expect(r.ofType('session_stopped')).toHaveLength(1);
    await r.host.dispose();
  });

  it('answers messages queued behind a start that failed unexpectedly', async () => {
    const r = rig();
    const host = createAnalysisHost({
      post: (message) => r.posted.push(message),
      assets: ASSETS,
      deps: {
        clock: r.s,
        timers: r.s,
        randomId: () => {
          throw new Error('no CSPRNG');
        },
      },
    });
    host.handle(start());
    host.handle({ type: 'context', context: WORK });
    host.handle({ type: 'studying_feedback' });
    await r.s.advance(10);
    expect(r.ofType('error')).toEqual([
      { type: 'error', code: 'camera_failed', camera: 'unknown' },
      { type: 'error', code: 'not_running', camera: null },
    ]);
    await host.dispose();
  });

  it('a vision failure in a session becomes no-camera mode, not an error', async () => {
    const r = rig(new VisionError('load_failed'));
    r.send(start());
    await r.s.advance(1_500);
    expect(r.ofType('error')).toEqual([]);
    const modes = r.ofType('event').filter((m) => m.event.type === 'mode');
    expect(modes).toHaveLength(1);
    expect(r.ofType('report')[0]?.report.mode).toBe('no-camera');
    await r.host.dispose();
  });

  it('runs a calibration: record with progress, build, close; busy while running', async () => {
    const r = rig();
    r.send({ type: 'calibration_start', profileJson: null, cameraDeviceId: null });
    r.vision.features = replay(
      calibrationFrames('screen', { persona: PERSONAS.baseline, seed: 5 }),
    );
    r.send({ type: 'calibration_record', cls: 'screen' }); // queued until started
    r.send(start());
    await r.s.advance(21_000);
    expect(r.ofType('error').map((e) => e.code)).toEqual(['busy']);
    expect(r.ofType('calibration_progress').length).toBeGreaterThan(70);
    const recorded = r.ofType('calibration_recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.summary.cls).toBe('screen');

    r.send({ type: 'calibration_record', cls: 'paper' });
    r.send({ type: 'calibration_record', cls: 'phone' }); // clash: busy
    await r.s.advance(1_000);
    r.send({ type: 'calibration_cancel' }); // cancelled: no message
    await r.s.advance(10);
    expect(r.ofType('error').map((e) => e.code)).toEqual(['busy', 'busy']);

    r.send({ type: 'calibration_build' });
    const built = r.ofType('calibration_built');
    expect(built).toHaveLength(1);
    expect(built[0]?.outcome.ok).toBe(false); // four situations missing
    r.send({ type: 'calibration_close' });
    expect(r.camera.last.stopped).toBe(1);
    r.send({ type: 'calibration_build' });
    await r.s.advance(10);
    expect(r.ofType('error').map((e) => e.code)).toEqual(['busy', 'busy', 'not_running']);
  });

  it('maps calibration failures: vision at start, the camera at each recording', async () => {
    const r = rig(new VisionError('simd_unsupported'));
    r.send({ type: 'calibration_start', profileJson: null, cameraDeviceId: null });
    await r.s.advance(10);
    expect(r.ofType('error')).toEqual([{ type: 'error', code: 'vision_failed', camera: null }]);
    expect(r.camera.calls).toHaveLength(0);

    const r2 = rig();
    r2.camera.failWith = new CameraError('permission_denied');
    r2.send({ type: 'calibration_start', profileJson: null, cameraDeviceId: null });
    await r2.s.advance(10);
    expect(r2.ofType('error')).toEqual([]); // the camera is not opened until a recording
    r2.send({ type: 'calibration_record', cls: 'screen' });
    await r2.s.advance(10);
    expect(r2.ofType('error')).toEqual([
      { type: 'error', code: 'camera_failed', camera: 'permission_denied' },
    ]);
    r2.send({ type: 'calibration_close' });
  });

  it('dispose stops the running session and ignores later messages', async () => {
    const r = rig();
    r.send(start());
    await r.s.advance(2_000);
    await r.host.dispose();
    expect(r.camera.last.stopped).toBe(1);
    const count = r.posted.length;
    r.send({ type: 'resume' });
    await r.s.advance(5_000);
    expect(r.posted.length).toBe(count);
    expect(r.s.pending).toBe(0);
  });
});
