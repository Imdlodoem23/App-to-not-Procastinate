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
import { PERSONAS, synthesize, type Persona, type Script, type SynthTick } from '../synth';
import { FakeCamera, FakeScheduler, FakeVision, plainFeatures, shiftFrame } from '../runtime/fakes';
import { LiveFrames } from './live-frames';
import { STALL_AFTER_MS } from '../../src/perception/constants';

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
async function play(
  script: Script,
  seed = 11,
  context?: (rel: number, tick: SynthTick) => Partial<ContextInput>,
): Promise<Run> {
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
  const contextAt = (rel: number): ContextInput => {
    const tick = at(rel);
    return { phase: tick.phase, ...tick.context, ...(context?.(rel, tick) ?? {}) };
  };
  handle = await startStudySession({
    mode: 'camera',
    profileJson: serializeProfile(profileFor('baseline')),
    assets: ASSETS,
    initialContext: contextAt(0),
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
    h.setContext(contextAt(rel));
    await s.advance(1_000);
  }
  await h.stop();
  return run;
}

/** Face and detector costs that settle the governor at one level (DESIGN §8.2). */
const LEVEL_COSTS = {
  L1: { faceMs: 10, objectMs: 35 }, // (10.5 + 35 / 3) / 333 = 0.067
  L3: { faceMs: 20, objectMs: 60 }, // (20.5 + 60 / 4) / 500 = 0.071; L2 would be 0.101
  L4: { faceMs: 30, objectMs: 60 }, // (30.5 + 60 / 8) / 500 = 0.076; L3 would be 0.091
} as const;

/**
 * Plays `script` through a calibrated session with the detector running only on the frames
 * the session asks for (`LiveFrames`) and the costs of a machine at `level`.
 */
async function playLive(
  script: Script,
  seed: number,
  level: keyof typeof LEVEL_COSTS | { faceMs: number; objectMs: number },
  persona: Persona = PERSONAS.baseline,
): Promise<Run & { levels: number[] }> {
  const s = new FakeScheduler(50_000);
  const t0 = s.t;
  const camera = new FakeCamera(s);
  // Like the real source: `stalled` once the loop has not taken a frame for 3 s.
  camera.stallAfterMs = STALL_AFTER_MS;
  const vision = new FakeVision(s);
  const costs = typeof level === 'string' ? LEVEL_COSTS[level] : level;
  vision.cost = { faceMs: costs.faceMs, objectMs: 0, lumaMs: 0.5, totalMs: costs.faceMs + 0.5 };
  vision.objectMs = costs.objectMs;
  const live = new LiveFrames(script, persona, seed, t0);
  vision.features = (frame, index) =>
    live.features(frame, vision.calls[index]?.options ?? { objects: false, luma: false });

  const run: Run & { levels: number[] } = {
    events: [],
    reports: [],
    strikes: [],
    warnings: [],
    levels: [],
  };
  let handle: StudySessionHandle | null = null;
  const contextAt = (rel: number): ContextInput => {
    const tick = live.at(rel);
    return { phase: tick.phase, ...tick.context };
  };
  handle = await startStudySession({
    mode: 'camera',
    profileJson: serializeProfile(profileFor('baseline')),
    assets: ASSETS,
    initialContext: contextAt(0),
    onEvent: (event) => {
      run.events.push(event);
      if (event.type === 'strike') {
        run.strikes.push({ at: event.at - t0, cause: event.cause });
        const seq = event.seq;
        queueMicrotask(() =>
          handle?.strikeResult({ seq, counted: true, reason: null, cooldownLeftMs: 60_000 }),
        );
      }
      if (event.type === 'warning') run.warnings.push({ at: event.at - t0, kind: event.kind });
    },
    onReport: (report) => {
      run.reports.push(report);
      if (report.loop) run.levels.push(report.loop.level);
    },
    deps: {
      clock: s,
      timers: s,
      openCamera: camera.open,
      createVision: () => Promise.resolve(vision),
      nowIso: () => '2026-09-28T10:00:00.000Z',
      randomId: () => 'accept02',
    },
  });
  const h = handle;
  for (let rel = 0; rel < live.durationMs; rel += 1_000) {
    h.setContext(contextAt(rel));
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

/**
 * A video on the same screen (HANDOFF §4, `context.foreground`). The camera cannot tell a
 * lecture from entertainment: both are a face at the screen. Main therefore sends every
 * catalog service, `educationalCapable` ones such as YouTube included, as `distraction`,
 * unless the user chose «Voy a usar YouTube para estudiar» before starting, which makes it
 * `neutral`.
 */
describe('acceptance: a video in the foreground', () => {
  it('watching YouTube (`distraction`) is not studying, although the face is at the screen', async () => {
    const run = await play([
      ['screen', 30_000],
      { activity: 'screen', ms: 120_000, foreground: 'distraction' },
    ]);
    const doubt = run.warnings.find((w) => w.kind === 'doubt');
    // F_dist after 5 s, the window falls below θ, then 15 s low: doubt ~20–35 s after the
    // switch, the strike 30 s later.
    expect((doubt?.at ?? 0) - 30_000).toBeGreaterThanOrEqual(15_000);
    expect((doubt?.at ?? 0) - 30_000).toBeLessThanOrEqual(40_000);
    const first = run.strikes[0];
    expect(first?.cause).toBe('distraction_app');
    expect((first?.at ?? 0) - 30_000).toBeGreaterThanOrEqual(45_000);
    expect((first?.at ?? 0) - 30_000).toBeLessThanOrEqual(80_000);
  });

  it('writing notes with the video in front is still studying (looking down)', async () => {
    const run = await play([
      ['screen', 30_000],
      { activity: 'notebook', ms: 600_000, foreground: 'distraction' },
    ]);
    expect(run.strikes).toEqual([]);
    const last = run.reports[run.reports.length - 1] as SessionReport;
    expect(last.totals.focusedMs / last.totals.workMs).toBeGreaterThanOrEqual(0.9);
  });

  it('with the per-session opt-in (`neutral`) watching the lecture counts as focus', async () => {
    const run = await play([
      ['screen', 30_000],
      { activity: 'screen', ms: 600_000, foreground: 'neutral' },
    ]);
    expect(run.strikes).toEqual([]);
    expect(run.warnings).toEqual([]);
  });
});

/**
 * DESIGN §7.12: ≥ 70 s of continuous phone → at least one strike, whatever the machine. On a
 * slow laptop (L3/L4) the detector runs every 2–4 s; PERCEPTION's tracker counts sightings,
 * so a phone wobbling in the hand then looked like one at rest after 20 s and the DUDA
 * cleared. The governor's alert keeps the detector at ≥ 1 Hz while a phone is around.
 */
describe('acceptance: a phone in hand on a slow laptop (detector at the planned rate)', () => {
  const SEEDS = [100, 101, 102, 103, 104, 105, 106, 107];

  for (const level of ['L1', 'L3', 'L4'] as const) {
    it(`${level}: 2 minutes of phone always end in a \`phone\` strike`, async () => {
      for (const seed of SEEDS) {
        const run = await playLive(
          [
            ['screen', 60_000],
            ['phoneInHand', 120_000],
          ],
          seed,
          level,
        );
        const calm = run.levels.slice(10, 50);
        expect(Math.max(...calm), `seed ${seed}`).toBe(Number(level.slice(1)));
        expect(run.strikes[0]?.cause, `seed ${seed}`).toBe('phone');
        expect(run.strikes[0]?.at ?? 0, `seed ${seed}`).toBeGreaterThanOrEqual(60_000 + 45_000);
        expect(run.strikes[0]?.at ?? 0, `seed ${seed}`).toBeLessThanOrEqual(60_000 + 90_000);
      }
    }, 60_000);
  }

  it('L4, glasses persona: the phone still strikes', async () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const run = await playLive(
        [
          ['screen', 60_000],
          ['phoneInHand', 120_000],
        ],
        seed,
        'L4',
        PERSONAS.glasses,
      );
      expect(run.strikes[0]?.cause, `seed ${seed}`).toBe('phone');
    }
  }, 60_000);

  it('L4: writing in a notebook is never punished (no phone, no alert)', async () => {
    const run = await playLive(
      [
        ['screen', 30_000],
        ['notebook', 300_000],
      ],
      7,
      'L4',
    );
    expect(run.strikes).toEqual([]);
  }, 60_000);
});

/**
 * A slow or heavily loaded machine: the duty cap must repay a slow detector run by shedding
 * work, never with a sleep the camera reads as stalled (3 s) or the engine as unobserved time
 * (5 s), or the absence and phone rules would silently stop (fail-open).
 */
describe('acceptance: a slow detector never switches the rules off', () => {
  for (const objectMs of [700, 900, 1_500]) {
    it(`face 100 ms + detector ${objectMs} ms: leaving still ends in \`no_face\``, async () => {
      const run = await playLive(
        [
          ['screen', 30_000],
          ['absent', 165_000],
        ],
        5,
        { faceMs: 100, objectMs },
      );
      expect(run.strikes[0]?.cause).toBe('no_face');
      expect(run.strikes[0]?.at ?? 0).toBeLessThanOrEqual(30_000 + 75_000);
      const gaps = run.reports.map((r) => r.loop?.maxGapMs ?? 0);
      expect(Math.max(...gaps)).toBeLessThan(3_000);
      // The camera never read as stalled or lost, and no warm-up went back to `warmup`.
      const camera = run.events.filter((e) => e.type === 'camera').map((e) => e.status);
      expect(camera).not.toContain('stalled');
      expect(camera).not.toContain('error');
      expect(run.events.some((e) => e.type === 'hint' && e.code === 'camera_lost')).toBe(false);
      const states = attention(run).flatMap((e) => (e.type === 'state' ? [e.to] : []));
      expect(states.filter((to) => to === 'warmup')).toEqual([]);
    }, 60_000);
  }

  // At 15 % of a core a 900 ms detector runs every ~6 s at best, too rarely for E_phone (two
  // sightings within 5 s): the low score still leads through DUDA to a strike.
  it('face 100 ms + detector 900 ms: a phone in hand still strikes', async () => {
    const run = await playLive(
      [
        ['screen', 60_000],
        ['phoneInHand', 150_000],
      ],
      101,
      { faceMs: 100, objectMs: 900 },
    );
    expect(['phone', 'doubt_timeout']).toContain(run.strikes[0]?.cause);
    expect(run.warnings.some((w) => w.kind === 'doubt')).toBe(true);
  }, 60_000);
});

/**
 * A video playing on the second monitor while the notes have the focus (HANDOFF §4,
 * `visibleDistraction`). The foreground class alone says `study`, and the second monitor
 * reads as a screen: without the flag this is full focus credit.
 */
describe('acceptance: a video on the second monitor', () => {
  const watching = (from: number) => (rel: number) =>
    rel >= from ? { visibleDistraction: true } : {};

  it('watching it with the keyboard idle is not studying: doubt, then a strike', async () => {
    const run = await play(
      [['screen', 30_000], { activity: 'screen', ms: 150_000, foreground: 'study' }],
      11,
      (rel, tick) => ({
        ...watching(30_000)(rel),
        // Watching: no keyboard or mouse input at all.
        idleMs: rel >= 30_000 ? rel - 30_000 + (tick.context.idleMs ?? 0) : tick.context.idleMs,
      }),
    );
    expect(run.warnings.some((w) => w.kind === 'doubt')).toBe(true);
    expect(run.strikes[0]?.cause).toBe('distraction_app');
    expect((run.strikes[0]?.at ?? 0) - 30_000).toBeLessThanOrEqual(100_000);
  });

  it('typing in the notes with the video visible stays focus', async () => {
    const run = await play(
      [['screen', 30_000], { activity: 'typing', ms: 300_000, foreground: 'study' }],
      11,
      watching(30_000),
    );
    expect(run.strikes).toEqual([]);
  });

  it('writing on paper with the video visible stays focus (looking down is studying)', async () => {
    const run = await play(
      [['screen', 30_000], { activity: 'notebook', ms: 300_000, foreground: 'study' }],
      11,
      watching(30_000),
    );
    expect(run.strikes).toEqual([]);
  });
});
