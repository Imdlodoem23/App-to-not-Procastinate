import { describe, expect, it } from 'vitest';
import { parseProfile } from '../../src/calibration/profile';
import { startCalibration } from '../../src/runtime/calibration-session';
import { isAnalysisOutbound } from '../../src/runtime/ipc';
import { CALIBRATION_CLASSES } from '../../src/types';
import type {
  CalibrationClass,
  CalibrationProgress,
  SessionDeps,
  VisionAssets,
} from '../../src/types';
import { calibrationFrames, PERSONAS } from '../synth';
import { CameraError, FakeCamera, FakeScheduler, FakeVision, VisionError, replay } from './fakes';

const ASSETS: VisionAssets = {
  wasmBaseUrl: 'http://127.0.0.1:5173/mediapipe',
  faceModel: { url: 'http://127.0.0.1:5173/models/face_landmarker.task' },
  objectModel: { url: 'http://127.0.0.1:5173/models/efficientdet_lite0_int8.tflite' },
};

function rig(visionFails: unknown = null) {
  const s = new FakeScheduler(5_000);
  const camera = new FakeCamera(s);
  const vision = new FakeVision();
  const progress: CalibrationProgress[] = [];
  const deps: Partial<SessionDeps> = {
    clock: s,
    timers: s,
    openCamera: camera.open,
    createVision: () =>
      visionFails === null ? Promise.resolve(vision) : Promise.reject(visionFails),
    nowIso: () => '2026-09-28T10:00:00.000Z',
  };
  const play = (cls: CalibrationClass, seed = 20): void => {
    vision.features = replay(calibrationFrames(cls, { persona: PERSONAS.baseline, seed }));
  };
  return { s, camera, vision, progress, deps, play };
}

async function recordClass(
  r: ReturnType<typeof rig>,
  handle: Awaited<ReturnType<typeof startCalibration>>,
  cls: CalibrationClass,
) {
  r.play(cls);
  const pending = handle.record(cls);
  await r.s.advance(21_000);
  return pending;
}

describe('calibration session', () => {
  it('records the five situations at 4 fps (objects at 2 Hz) and builds a profile', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: (p) => r.progress.push(p),
      deps: r.deps,
    });
    for (const cls of CALIBRATION_CLASSES) {
      const before = r.vision.calls.length;
      const summary = await recordClass(r, handle, cls);
      expect(summary.cls).toBe(cls);
      expect(summary.rows).toBeGreaterThanOrEqual(60);
      expect(summary.rows).toBeLessThanOrEqual(80);
      expect(summary.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(isAnalysisOutbound({ type: 'calibration_recorded', summary })).toBe(true);
      const calls = r.vision.calls.slice(before);
      expect(calls.length).toBeGreaterThanOrEqual(78); // 20 s at 4 fps
      expect(calls.length).toBeLessThanOrEqual(81);
      const objects = calls.filter((c) => c.options.objects).length;
      expect(Math.abs(objects - calls.length / 2)).toBeLessThanOrEqual(1);
    }
    // One camera per recording, each stopped when its clip ended; every frame closed once.
    expect(r.camera.opened).toHaveLength(5);
    for (const source of r.camera.opened) {
      expect(source.stopped).toBe(1);
      for (const frame of source.frames) expect(frame.closed).toBe(1);
    }
    expect(r.progress.length).toBeGreaterThan(5 * 78);
    expect(r.progress.some((p) => p.phase === 'settling')).toBe(true);
    expect(r.progress[r.progress.length - 1]?.phase).toBe('done');
    for (const progress of r.progress.slice(0, 20)) {
      expect(isAnalysisOutbound({ type: 'calibration_progress', progress })).toBe(true);
    }

    const outcome = handle.build();
    expect(outcome.ok).toBe(true);
    expect(isAnalysisOutbound({ type: 'calibration_built', outcome })).toBe(true);
    if (outcome.ok) {
      const parsed = parseProfile(outcome.profileJson);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.profile.camera.key).toBe(r.camera.identity.key);
      expect(outcome.report.cvBinaryBalancedAccuracy).toBeGreaterThan(0.8);
    }
    handle.close();
    expect(r.camera.last.stopped).toBe(1);
    expect(r.vision.closed).toBe(1);
    expect(r.s.pending).toBe(0);
  });

  it('the camera is on only while a situation is being recorded', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    // The wizard is open and the user reads the instructions: no camera yet.
    await r.s.advance(30_000);
    expect(r.camera.calls).toHaveLength(0);
    const first = recordClass(r, handle, 'screen');
    await first;
    expect(r.camera.opened).toHaveLength(1);
    expect(r.camera.last.stopped).toBe(1); // off right after the clip
    await r.s.advance(60_000); // between two recordings
    expect(r.camera.calls).toHaveLength(1);
    r.play('paper');
    const second = handle.record('paper');
    await r.s.advance(3_000);
    expect(r.camera.opened).toHaveLength(2);
    expect(r.camera.last.stopped).toBe(0); // on while recording
    handle.cancel();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.camera.last.stopped).toBe(1); // off at once on cancel
    // The recording still gets its full 20 s: they start when the camera is open.
    await expect(first).resolves.toMatchObject({ cls: 'screen' });
    handle.close();
    expect(r.s.pending).toBe(0);
  });

  it('re-recording one situation keeps the previous profile, and missing clips fail', async () => {
    const r = rig();
    const first = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    await recordClass(r, first, 'screen');
    const incomplete = first.build();
    expect(incomplete.ok).toBe(false);
    expect(incomplete.issues.map((i) => i.code)).toContain('missing');
    for (const cls of CALIBRATION_CLASSES.slice(1)) await recordClass(r, first, cls);
    const full = first.build();
    expect(full.ok).toBe(true);
    first.close();
    if (!full.ok) return;

    const second = await startCalibration({
      assets: ASSETS,
      profileJson: full.profileJson,
      onProgress: () => undefined,
      deps: r.deps,
    });
    await recordClass(r, second, 'phone');
    const again = second.build();
    expect(again.ok).toBe(true);
    if (again.ok) {
      const before = parseProfile(full.profileJson);
      const after = parseProfile(again.profileJson);
      expect(before.ok && after.ok).toBe(true);
      if (before.ok && after.ok) {
        expect(after.profile.clips.screen).toEqual(before.profile.clips.screen);
        expect(after.profile.createdAt).toBe(before.profile.createdAt);
      }
    }
    second.close();
  });

  it('one recording at a time; cancel rejects with AbortError', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    r.play('screen');
    const pending = handle.record('screen');
    await expect(handle.record('paper')).rejects.toThrow(/busy/);
    await r.s.advance(5_000);
    handle.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const calls = r.vision.calls.length;
    await r.s.advance(5_000);
    expect(r.vision.calls.length).toBe(calls);
    // A new recording works after a cancel.
    const next = recordClass(r, handle, 'screen');
    await expect(next).resolves.toMatchObject({ cls: 'screen' });
    handle.close();
    await expect(handle.record('paper')).rejects.toThrow(/closed/);
  });

  it('close() during a recording aborts it and releases the camera', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    r.play('away');
    const pending = handle.record('away');
    await r.s.advance(2_000);
    handle.close();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.camera.last.stopped).toBe(1);
    expect(r.s.pending).toBe(0);
  });

  it('reports what the camera could not see', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    r.play('absent'); // nobody in view while recording «screen»
    const pending = handle.record('screen');
    await r.s.advance(21_000);
    const summary = await pending;
    expect(summary.issues.map((i) => i.code)).toContain('no_face');
    handle.close();
  });

  it('a lost WebGL context mid-recording rebuilds the pipeline and the clip still counts', async () => {
    const r = rig();
    const fresh = new FakeVision();
    let loads = 0;
    r.deps.createVision = () => {
      loads += 1;
      return Promise.resolve(loads === 1 ? r.vision : fresh);
    };
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: (p) => r.progress.push(p),
      deps: r.deps,
    });
    const frames = calibrationFrames('screen', { persona: PERSONAS.baseline, seed: 20 });
    r.vision.features = replay(frames);
    fresh.features = replay(frames);
    const pending = handle.record('screen');
    await r.s.advance(5_000);
    r.vision.contextLost = true;
    await r.s.advance(16_000);
    const summary = await pending;
    expect(loads).toBe(2);
    expect(r.vision.closed).toBe(1);
    expect(fresh.calls.length).toBeGreaterThan(50);
    expect(summary.issues.filter((i) => i.severity === 'error')).toEqual([]);
    handle.close();
    expect(fresh.closed).toBe(1);
  });

  it('fails to start only when vision fails; a camera failure fails that recording', async () => {
    const r1 = rig(new VisionError('hash_mismatch'));
    await expect(
      startCalibration({
        assets: ASSETS,
        profileJson: null,
        onProgress: () => undefined,
        deps: r1.deps,
      }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(r1.camera.calls).toHaveLength(0);

    const r2 = rig();
    r2.camera.failWith = new CameraError('not_found');
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r2.deps,
    });
    await expect(handle.record('screen')).rejects.toMatchObject({
      name: 'CameraOpenError',
      code: 'not_found',
    });
    // Not stuck: the camera comes back and the next recording works.
    r2.camera.failWith = null;
    await expect(recordClass(r2, handle, 'screen')).resolves.toMatchObject({ cls: 'screen' });
    handle.close();
    expect(r2.vision.closed).toBe(1);
  });

  it('a camera that never answers fails the recording after 15 s and stops the late stream', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: (p) => r.progress.push(p),
      deps: r.deps,
    });
    r.camera.hang = true;
    let error: unknown = null;
    handle.record('screen').catch((e: unknown) => {
      error = e;
    });
    await r.s.advance(14_000);
    expect(error).toBeNull();
    await r.s.advance(1_500);
    expect(error).toMatchObject({ name: 'CameraOpenError', code: 'unknown' });
    expect(r.progress).toHaveLength(0);
    const late = r.camera.answerHung();
    await r.s.advance(10);
    expect(late[0]?.stopped).toBe(1);
    // The wizard can try again.
    r.camera.hang = false;
    await expect(recordClass(r, handle, 'screen')).resolves.toMatchObject({ cls: 'screen' });
    handle.close();
    expect(r.s.pending).toBe(0);
  });

  it('a vision load that never settles fails the start after 30 s and closes the late pipeline', async () => {
    const r = rig();
    const late = new FakeVision();
    let answer: ((vision: FakeVision) => void) | null = null;
    r.deps.createVision = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    let error: unknown = null;
    startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    }).catch((e: unknown) => {
      error = e;
    });
    await r.s.advance(29_000);
    expect(error).toBeNull();
    await r.s.advance(1_500);
    expect(error).toMatchObject({ name: 'VisionLoadError', code: 'load_failed' });
    (answer as unknown as (vision: FakeVision) => void)(late);
    await r.s.advance(10);
    expect(late.closed).toBe(1);
    expect(r.camera.calls).toHaveLength(0);
  });

  it('another camera between two recordings discards the clips of the first one', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    for (const cls of CALIBRATION_CLASSES.slice(0, 4)) await recordClass(r, handle, cls);
    r.camera.identity = { key: `sha256:${'b'.repeat(64)}`, aspect: 16 / 9 };
    await recordClass(r, handle, 'absent');
    const outcome = handle.build();
    expect(outcome.ok).toBe(false);
    const missing = outcome.issues.filter((i) => i.code === 'missing').map((i) => i.cls);
    expect(missing.sort()).toEqual([...CALIBRATION_CLASSES.slice(0, 4)].sort());
    handle.close();
  });

  it('building before any recording reports every situation as missing', async () => {
    const r = rig();
    const handle = await startCalibration({
      assets: ASSETS,
      profileJson: null,
      onProgress: () => undefined,
      deps: r.deps,
    });
    const outcome = handle.build();
    expect(outcome).toEqual({
      ok: false,
      issues: CALIBRATION_CLASSES.map((cls) => ({ code: 'missing', cls, severity: 'error' })),
    });
    expect(isAnalysisOutbound({ type: 'calibration_built', outcome })).toBe(true);
    handle.close();
  });
});
