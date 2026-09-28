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
    for (const frame of r.camera.last.frames) expect(frame.closed).toBe(1);
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

  it('fails to start when the camera or vision fails, releasing the other', async () => {
    const r1 = rig();
    r1.camera.failWith = new CameraError('not_found');
    await expect(
      startCalibration({
        assets: ASSETS,
        profileJson: null,
        onProgress: () => undefined,
        deps: r1.deps,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(r1.vision.closed).toBe(1);

    const r2 = rig(new VisionError('hash_mismatch'));
    await expect(
      startCalibration({
        assets: ASSETS,
        profileJson: null,
        onProgress: () => undefined,
        deps: r2.deps,
      }),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(r2.camera.last.stopped).toBe(1);
  });
});
