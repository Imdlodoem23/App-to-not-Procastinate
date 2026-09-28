/**
 * Phase 4 «terminado» acceptance (DESIGN.md §8.10): a calibrated persona through the whole
 * facade (loop, governor, real classifier, real observer and engine) with a fake camera
 * replaying synthetic numeric frames. No MediaPipe, no pixels.
 */
import { describe, expect, it } from 'vitest';
import { serializeProfile } from '../../src/calibration/profile';
import { startStudySession } from '../../src/runtime/session';
import type {
  AttentionEvent,
  ContextInput,
  SessionEvent,
  SessionReport,
  StudySessionHandle,
  VisionAssets,
} from '../../src/types';
import { profileFor } from '../calibration/fixtures';
import { PERSONAS, synthesize, type Script, type SynthTick } from '../synth';
import { FakeCamera, FakeScheduler, FakeVision, plainFeatures, shiftFrame } from '../runtime/fakes';

const ASSETS: VisionAssets = {
  wasmBaseUrl: 'centrate-ai://assets/mediapipe',
  faceModel: { url: 'centrate-ai://assets/models/face_landmarker.task' },
  objectModel: { url: 'centrate-ai://assets/models/efficientdet_lite0_int8.tflite' },
};

interface Run {
  events: SessionEvent[];
  reports: SessionReport[];
  /** Session-relative times of the strike requests. */
  strikes: { at: number; cause: string }[];
  warnings: { at: number; kind: string }[];
}

/**
 * Plays `script` through a calibrated session. The camera hands out a frame whenever the
 * loop asks; its features are the synthetic tick current at that moment, and main's context
 * (foreground, idle) follows the script at 1 Hz. Every strike is acknowledged as counted.
 */
async function play(script: Script, seed = 11): Promise<Run> {
  const s = new FakeScheduler(50_000);
  const t0 = s.t;
  const camera = new FakeCamera(s);
  const vision = new FakeVision(s);
  const ticks: SynthTick[] = synthesize(script, { persona: PERSONAS.baseline, seed });
  const total = ticks[ticks.length - 1]?.now ?? 0;
  const at = (rel: number): SynthTick => {
    // Binary search: the last synthetic tick at or before `rel`.
    let lo = 0;
    let hi = ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((ticks[mid] as SynthTick).now <= rel) lo = mid;
      else hi = mid - 1;
    }
    return ticks[lo] as SynthTick;
  };
  vision.features = (frame) => {
    const tick = at(frame.t - t0);
    return tick.frame ? shiftFrame(tick.frame, frame.t) : { ...plainFeatures(frame.t), face: null };
  };

  const run: Run = { events: [], reports: [], strikes: [], warnings: [] };
  let handle: StudySessionHandle | null = null;
  let seq = 0;
  const context = (rel: number): ContextInput => {
    const tick = at(rel);
    return { phase: tick.phase, ...tick.context };
  };
  handle = await startStudySession({
    mode: 'camera',
    profileJson: serializeProfile(profileFor('baseline')),
    assets: ASSETS,
    initialContext: context(0),
    onEvent: (event) => {
      run.events.push(event);
      if (event.type === 'strike') {
        run.strikes.push({ at: event.at - t0, cause: event.cause });
        seq = event.seq;
        // Main POSTs /strike; the guardian counts it and starts its 60 s cooldown.
        queueMicrotask(() =>
          handle?.strikeResult({ seq, counted: true, reason: null, cooldownLeftMs: 60_000 }),
        );
      }
      if (event.type === 'warning') run.warnings.push({ at: event.at - t0, kind: event.kind });
    },
    onReport: (report) => run.reports.push(report),
    deps: {
      clock: s,
      timers: s,
      openCamera: camera.open,
      createVision: () => Promise.resolve(vision),
      nowIso: () => '2026-09-28T10:00:00.000Z',
      randomId: () => 'accept01',
    },
  });
  const h = handle;
  for (let rel = 0; rel < total; rel += 1_000) {
    h.setContext(context(rel));
    await s.advance(1_000);
  }
  await h.stop();
  return run;
}

const attention = (run: Run): AttentionEvent[] =>
  run.events.filter(
    (e): e is AttentionEvent =>
      e.type !== 'profile_updated' && e.type !== 'camera' && e.type !== 'mode',
  );

describe('acceptance: calibrated persona through the facade', () => {
  it('uses the personal classifier for the calibrated camera', async () => {
    const run = await play([['screen', 20_000]]);
    const last = run.reports[run.reports.length - 1];
    expect(last?.snapshot.classifier).toBe('personal');
    expect(last?.snapshot.state).toBe('focused');
  });

  it('picking up the phone: a warning, then a `phone` strike', async () => {
    const run = await play([
      ['screen', 60_000],
      ['phoneInHand', 120_000],
    ]);
    const doubt = run.warnings.find((w) => w.kind === 'doubt');
    expect(doubt).toBeDefined();
    const first = run.strikes[0];
    expect(first?.cause).toBe('phone');
    // Picked up at 60 s: doubt after ~15–30 s, the strike 30 s later.
    expect((doubt?.at ?? 0) - 60_000).toBeGreaterThanOrEqual(15_000);
    expect((doubt?.at ?? 0) - 60_000).toBeLessThanOrEqual(32_000);
    expect((first?.at ?? 0) - 60_000).toBeGreaterThanOrEqual(45_000);
    expect((first?.at ?? 0) - 60_000).toBeLessThanOrEqual(66_000);
    expect(run.strikes.every((s) => s.at > 60_000)).toBe(true);
    expect(attention(run).some((e) => e.type === 'state' && e.to === 'doubt')).toBe(true);
  });

  it('leaving: «No te veo», a warning at 30 s and `no_face` at 60 s', async () => {
    const run = await play([
      ['screen', 60_000],
      ['absent', 90_000],
    ]);
    const first = run.strikes[0];
    expect(first?.cause).toBe('no_face');
    expect((first?.at ?? 0) - 60_000).toBeGreaterThanOrEqual(58_000);
    expect((first?.at ?? 0) - 60_000).toBeLessThanOrEqual(64_000);
    const absentWarning = run.warnings.find((w) => w.kind === 'absent');
    expect((absentWarning?.at ?? 0) - 60_000).toBeGreaterThanOrEqual(28_000);
    expect((absentWarning?.at ?? 0) - 60_000).toBeLessThanOrEqual(34_000);
    expect(attention(run).some((e) => e.type === 'state' && e.to === 'away')).toBe(true);
    expect(run.strikes).toHaveLength(1);
  });

  it('writing in a notebook for 30 minutes: no strike, mostly focused', async () => {
    const run = await play([
      ['screen', 30_000],
      ['notebook', 1_800_000],
    ]);
    expect(run.strikes).toEqual([]);
    expect(run.warnings.length).toBeLessThanOrEqual(1);
    const last = run.reports[run.reports.length - 1] as SessionReport;
    expect(last.totals.focusedMs / last.totals.workMs).toBeGreaterThanOrEqual(0.9);
  });

  it('three strikes are requested only while the behaviour continues', async () => {
    const brief = await play([
      ['screen', 30_000],
      ['phoneInHand', 70_000],
      ['notebook', 240_000],
    ]);
    expect(brief.strikes.map((s) => s.cause)).toEqual(['phone']);

    const long = await play([
      ['screen', 30_000],
      ['phoneInHand', 300_000],
    ]);
    expect(long.strikes.length).toBeGreaterThanOrEqual(3);
    expect(long.strikes.slice(0, 3).map((s) => s.cause)).toEqual(['phone', 'phone', 'phone']);
    // The 60 s grace after each strike spaces them out.
    for (let i = 1; i < long.strikes.length; i += 1) {
      const gap = (long.strikes[i]?.at ?? 0) - (long.strikes[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('a Pomodoro break with nobody in view never strikes and turns the camera off', async () => {
    const run = await play([
      ['screen', 30_000],
      { activity: 'absent', ms: 300_000, phase: 'break' },
      ['screen', 30_000],
    ]);
    expect(run.strikes).toEqual([]);
    const off = run.reports.filter((r) => !r.cameraOn);
    expect(off.length).toBeGreaterThan(250);
  });
});
