import { afterEach, describe, expect, it, vi } from 'vitest';
import { CpuGovernor } from '../../src/runtime/governor';
import { AdaptiveLoop, DUTY_BURST_MS, MAX_STEP_DUTY, type LoopStep } from '../../src/runtime/loop';
import { analyseNextFrame, FrameCadence } from '../../src/runtime/frame-step';
import type { LoopPlan, StepCost } from '../../src/types';
import { FakeScheduler, FakeSource, FakeVision } from './fakes';

function frameCost(at: number): StepCost {
  return { at, visionMs: 10, objectMs: 0, otherMs: 1, ranObjects: false, faceSeen: true };
}

/**
 * Chromium's timer alignment for a hidden page that is throttled anyway (no
 * `backgroundThrottling: false`): every timer fires on the next whole second.
 */
class AlignedScheduler extends FakeScheduler {
  override set(fn: () => void, ms: number): unknown {
    const at = Math.ceil((this.t + Math.max(0, ms)) / 1_000) * 1_000;
    return super.set(fn, at - this.t);
  }
}

/** Runs a loop whose every step computes for `computeMs` (the fake clock moves meanwhile). */
async function dutyOf(
  computeMs: number,
  seconds: number,
): Promise<{ duty: number; steps: number; loop: AdaptiveLoop; governor: CpuGovernor }> {
  const s = new FakeScheduler();
  const governor = new CpuGovernor();
  let busy = 0;
  let steps = 0;
  const loop = new AdaptiveLoop(
    async (now) => {
      steps += 1;
      s.t += computeMs;
      busy += computeMs;
      return { ...frameCost(now), visionMs: computeMs, otherMs: 0 };
    },
    governor,
    s,
    s,
  );
  loop.start();
  await s.advance(seconds * 1_000);
  // Up to the next step: a step's idle time comes after it, so a window that ends right after
  // a long step would cut its repayment off.
  const nextAt = s.t + Math.min(...s.delays());
  return { duty: busy / nextAt, steps, loop, governor };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AdaptiveLoop', () => {
  const originalRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  afterEach(() => {
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = originalRaf;
  });

  it('runs at the plan interval on setTimeout only, never requestAnimationFrame', async () => {
    const raf = vi.fn();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    const s = new FakeScheduler();
    const starts: number[] = [];
    const loop = new AdaptiveLoop(
      async (now) => {
        starts.push(now);
        s.t += 20; // processing time
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(3_000);
    expect(raf).not.toHaveBeenCalled();
    // L1: a step every 333 ms (the delay subtracts the 20 ms of work).
    expect(starts.slice(0, 4)).toEqual([0, 333, 666, 999]);
    expect(loop.stats.ticks).toBe(starts.length);
    expect(loop.stats.fps).toBeGreaterThan(2.5);
    expect(loop.stats.fps).toBeLessThan(3.5);
    loop.stop();
  });

  it('keeps the planned rate when timers fire late (fixed-rate grid)', async () => {
    const s = new FakeScheduler();
    s.latency = 7;
    const g = new CpuGovernor();
    let steps = 0;
    const loop = new AdaptiveLoop(
      async (now) => {
        steps += 1;
        s.t += 60; // slow machine: the emergency level, still 2 fps (duty 0.12 < the cap)
        return { ...frameCost(now), visionMs: 60 };
      },
      g,
      s,
      s,
    );
    loop.start();
    await s.advance(60_000);
    loop.stop();
    expect(g.level).toBe(5);
    // 2 fps for 60 s despite 7 ms of latency on every timer.
    expect(steps).toBeGreaterThanOrEqual(119);
    expect(steps).toBeLessThanOrEqual(121);
  });

  it('never overlaps steps: the next is scheduled only after the current settles', async () => {
    const s = new FakeScheduler();
    const gates: { resolve(value: StepCost | null): void }[] = [];
    let active = 0;
    let maxActive = 0;
    const step: LoopStep = async (now) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred<StepCost | null>();
      gates.push(gate);
      const result = await gate.promise;
      active -= 1;
      void now;
      return result;
    };
    const loop = new AdaptiveLoop(step, new CpuGovernor(), s, s);
    loop.start();
    await s.advance(5_000);
    expect(gates.length).toBe(1);
    expect(s.pending).toBe(0);
    gates[0]?.resolve(frameCost(0));
    await s.advance(10);
    // The step overran its interval: the next one comes after the 10 ms minimum delay.
    expect(gates.length).toBe(2);
    expect(maxActive).toBe(1);
    loop.stop();
    gates[1]?.resolve(frameCost(5_010));
    await s.advance(2_000);
    expect(gates.length).toBe(2);
  });

  it('stop() clears the pending timer and a step in flight schedules nothing', async () => {
    const s = new FakeScheduler();
    let calls = 0;
    const loop = new AdaptiveLoop(
      async (now) => {
        calls += 1;
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(1_000);
    const before = calls;
    expect(s.pending).toBe(1);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(s.pending).toBe(0);
    await s.advance(5_000);
    expect(calls).toBe(before);
  });

  it('restarting while a step is in flight still never overlaps', async () => {
    const s = new FakeScheduler();
    const gates: { resolve(value: StepCost | null): void }[] = [];
    let active = 0;
    let maxActive = 0;
    const loop = new AdaptiveLoop(
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred<StepCost | null>();
        gates.push(gate);
        const result = await gate.promise;
        active -= 1;
        return result;
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(1);
    loop.stop();
    loop.start();
    loop.start();
    await s.advance(1_000);
    expect(gates.length).toBe(1);
    gates[0]?.resolve(null);
    await s.advance(1_000);
    expect(gates.length).toBe(2);
    expect(maxActive).toBe(1);
    loop.stop();
    gates[1]?.resolve(null);
    await s.advance(3_000);
  });

  it('counts errors and keeps going', async () => {
    const s = new FakeScheduler();
    let calls = 0;
    const loop = new AdaptiveLoop(
      async (now) => {
        calls += 1;
        if (calls % 2 === 0) throw new Error('boom');
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(10_000);
    expect(loop.stats.errors).toBeGreaterThan(3);
    expect(loop.stats.ticks).toBe(calls);
    expect(loop.running).toBe(true);
    loop.stop();
  });

  it('idle steps (null) tick once a second', async () => {
    const s = new FakeScheduler();
    const starts: number[] = [];
    const loop = new AdaptiveLoop(
      async (now) => {
        starts.push(now);
        return null;
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(5_500);
    expect(starts).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
    expect(loop.stats.fps).toBe(0);
    expect(loop.stats.throttled).toBe(false);
    loop.stop();
  });

  it('reports the largest gap and throttling when ticks come too rarely', async () => {
    const s = new FakeScheduler();
    const loop = new AdaptiveLoop(
      async (now) => {
        s.t += 2_500; // a frozen/throttled renderer: each step takes 2.5 s of wall time
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(20_000);
    expect(loop.stats.throttled).toBe(false); // not for 30 s yet
    await s.advance(20_000);
    expect(loop.stats.maxGapMs).toBeGreaterThanOrEqual(2_500);
    expect(loop.stats.throttled).toBe(true);
    loop.stop();
    expect(loop.stats.throttled).toBe(false);
  });

  it('passes the governor plan to the step and feeds back its cost', async () => {
    const s = new FakeScheduler();
    const plans: LoopPlan[] = [];
    const governor = new CpuGovernor();
    const loop = new AdaptiveLoop(
      async (now, plan) => {
        plans.push(plan);
        return {
          at: now,
          visionMs: 60,
          objectMs: 90,
          otherMs: 1,
          ranObjects: true,
          faceSeen: true,
        };
      },
      governor,
      s,
      s,
    );
    loop.start();
    await s.advance(3_000);
    loop.stop();
    expect(plans[0]?.level).toBe(1);
    expect(plans[plans.length - 1]?.level).toBe(5);
    expect(loop.stats.overBudget).toBe(true);
    expect(loop.stats.level).toBe(5);
  });

  it('passes the alert to the governor: the detector at ≥ 1 Hz while a phone was seen', async () => {
    const s = new FakeScheduler();
    const plans: LoopPlan[] = [];
    let alert = false;
    const loop = new AdaptiveLoop(
      async (now, plan) => {
        plans.push(plan);
        s.t += 30;
        return { ...frameCost(now), visionMs: 30, objectMs: 60, ranObjects: true, alert };
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(5_000);
    const calm = plans[plans.length - 1] as LoopPlan;
    expect(calm.objectEvery * calm.intervalMs).toBeGreaterThan(1_000); // L4/L5: every 4–8 s
    alert = true;
    await s.advance(2_000);
    const alerted = plans[plans.length - 1] as LoopPlan;
    expect(alerted.objectEvery * alerted.intervalMs).toBeLessThanOrEqual(1_000);
    loop.stop();
  });
});

describe('AdaptiveLoop: hard duty cap', () => {
  const allowed = (seconds: number): number => MAX_STEP_DUTY + DUTY_BURST_MS / (seconds * 1_000);

  for (const computeMs of [150, 400, 600, 900]) {
    it(`a ${computeMs} ms step never takes more than ${MAX_STEP_DUTY * 100} % of a core`, async () => {
      const { duty, steps, loop, governor } = await dutyOf(computeMs, 60);
      // Without the cap: 30 %, 81 %, 99 %, 99 % of a core at L4 (a busy loop).
      expect(duty).toBeLessThanOrEqual(allowed(60));
      // It keeps analysing, as fast as the cap allows.
      expect(steps).toBeGreaterThanOrEqual(Math.floor((60_000 * MAX_STEP_DUTY) / computeMs) - 1);
      expect(governor.level).toBe(5);
      expect(loop.stats.overBudget).toBe(true);
      loop.stop();
    });
  }

  it('leaves normal costs alone: 3–4 fps, never delayed by the cap', async () => {
    const { duty, steps, loop } = await dutyOf(15, 30);
    expect(duty).toBeLessThan(0.07);
    expect(steps).toBeGreaterThanOrEqual(89);
    expect(loop.stats.overBudget).toBe(false);
    loop.stop();
  });

  it('absorbs a slow detector run among fast frames without slowing the frame rate', async () => {
    // L4-like pace: 30 ms frames, a 200 ms detector every 8th frame = 11 % on average.
    const s = new FakeScheduler();
    let i = 0;
    const starts: number[] = [];
    const loop = new AdaptiveLoop(
      async (now) => {
        starts.push(now);
        const ranObjects = i % 8 === 0;
        i += 1;
        const objectMs = ranObjects ? 200 : 0;
        s.t += 30 + objectMs;
        return { ...frameCost(now), visionMs: 30, objectMs, otherMs: 0, ranObjects };
      },
      new CpuGovernor({}, [{ intervalMs: 500, objectEvery: 8 }]),
      s,
      s,
    );
    loop.start();
    await s.advance(60_000);
    loop.stop();
    const inLastMinute = starts.filter((t) => t >= 0).length;
    expect(inLastMinute).toBeGreaterThanOrEqual(118); // 2 fps kept
  });

  it('counts only the compute, not the wait for the next camera frame', async () => {
    const s = new FakeScheduler();
    let steps = 0;
    const loop = new AdaptiveLoop(
      async (now) => {
        steps += 1;
        s.t += 200; // grabFrame waits for the next frame (5 fps camera): idle, not CPU
        s.t += 20;
        return { ...frameCost(now), visionMs: 20, otherMs: 0 };
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(30_000);
    loop.stop();
    expect(steps).toBeGreaterThanOrEqual(85); // ~3 fps: the cap never kicks in
    expect(loop.stats.overBudget).toBe(false);
  });

  it('a failing step is charged its wall time', async () => {
    const s = new FakeScheduler();
    let steps = 0;
    const loop = new AdaptiveLoop(
      async () => {
        steps += 1;
        s.t += 600;
        throw new Error('WASM abort');
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(60_000);
    const nextAt = s.t + Math.min(...s.delays());
    loop.stop();
    expect(loop.stats.errors).toBe(steps);
    expect((steps * 600) / nextAt).toBeLessThanOrEqual(allowed(60));
  });
});

describe('AdaptiveLoop: throttling', () => {
  it('flags timers aligned to 1 s wake-ups (a hidden page throttled anyway)', async () => {
    const s = new AlignedScheduler();
    const loop = new AdaptiveLoop(
      async (now) => {
        s.t += 10;
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(120_000);
    // Still exactly one tick per second: the tick count alone never noticed.
    expect(loop.stats.fps).toBeLessThanOrEqual(1.05);
    expect(loop.stats.maxGapMs).toBeLessThanOrEqual(1_000);
    expect(loop.stats.throttled).toBe(true);
    loop.stop();
  });

  it('does not flag a normal loop, even with some timer latency', async () => {
    const s = new FakeScheduler();
    s.latency = 30;
    const loop = new AdaptiveLoop(
      async (now) => {
        s.t += 10;
        return frameCost(now);
      },
      new CpuGovernor(),
      s,
      s,
    );
    loop.start();
    await s.advance(120_000);
    expect(loop.stats.throttled).toBe(false);
    loop.stop();
  });

  it('never flags a break: idle ticks do not count, even on 1 s-aligned timers', async () => {
    const s = new AlignedScheduler();
    const loop = new AdaptiveLoop(async () => null, new CpuGovernor(), s, s);
    loop.start();
    await s.advance(120_000);
    expect(loop.stats.throttled).toBe(false);
    loop.stop();
  });

  it('does not flag the duty cap stretching the steps', async () => {
    const { loop } = await dutyOf(400, 120);
    expect(loop.stats.throttled).toBe(false);
    loop.stop();
  });
});

describe('analyseNextFrame', () => {
  it('closes every frame exactly once, also when processing throws', async () => {
    const s = new FakeScheduler();
    const source = new FakeSource(s);
    const vision = new FakeVision();
    const cadence = new FrameCadence();
    const plan = { objectEvery: 3, lumaEveryMs: 1_000 };
    vision.failNext = 2;
    const kinds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      s.t += 333;
      const outcome = await analyseNextFrame(
        source,
        vision,
        () => cadence.options(s.t, plan),
        () => true,
      );
      kinds.push(outcome.kind);
      if (outcome.kind === 'ok') cadence.done(s.t, outcome.options);
    }
    expect(kinds).toEqual(['failed', 'failed', 'ok', 'ok', 'ok', 'ok']);
    expect(source.frames).toHaveLength(6);
    for (const frame of source.frames) expect(frame.closed).toBe(1);
  });

  it('closes a frame unanalysed when the session went away during the grab', async () => {
    const s = new FakeScheduler();
    const source = new FakeSource(s);
    const vision = new FakeVision();
    const outcome = await analyseNextFrame(
      source,
      vision,
      () => ({ objects: false, luma: false }),
      () => false,
    );
    expect(outcome.kind).toBe('none');
    expect(vision.calls).toHaveLength(0);
    expect(source.frames[0]?.closed).toBe(1);
  });

  it('runs objects every N frames and luma once a second', () => {
    const cadence = new FrameCadence();
    const plan = { objectEvery: 3, lumaEveryMs: 1_000 };
    const seen: [boolean, boolean][] = [];
    for (let i = 0; i < 7; i += 1) {
      const t = i * 333;
      const options = cadence.options(t, plan);
      seen.push([options.objects, options.luma]);
      cadence.done(t, options);
    }
    expect(seen.map((s) => s[0])).toEqual([true, false, false, true, false, false, true]);
    expect(seen.map((s) => s[1])).toEqual([true, false, false, true, false, false, true]);
    cadence.reset();
    expect(cadence.options(2_400, plan)).toEqual({ objects: true, luma: true });
  });
});
