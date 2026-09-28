import { describe, expect, it } from 'vitest';
import { FrameCadence } from '../../src/runtime/frame-step';
import { CpuGovernor, LOOP_LEVELS, START_LEVEL } from '../../src/runtime/governor';
import type { StepCost } from '../../src/types';

function cost(at: number, visionMs: number, objectMs: number, ranObjects: boolean): StepCost {
  return { at, visionMs, objectMs, otherMs: 0.5, ranObjects, faceSeen: true };
}

/** Feeds `seconds` of steps at the governor's own pace; returns the level after each step. */
function drive(
  governor: CpuGovernor,
  start: number,
  seconds: number,
  costs: { visionMs: number; objectMs: number },
  faceVisible = true,
): { levels: number[]; end: number } {
  let t = start;
  let frame = 0;
  const levels: number[] = [];
  while (t < start + seconds * 1_000) {
    const plan = governor.plan(t, faceVisible);
    const ranObjects = frame % plan.objectEvery === 0;
    governor.record({
      ...cost(t, costs.visionMs, costs.objectMs, ranObjects),
      faceSeen: faceVisible,
    });
    levels.push(plan.level);
    frame += 1;
    t += plan.intervalMs;
  }
  return { levels, end: t };
}

describe('CpuGovernor', () => {
  it('starts at L1: 3 fps with the detector at 1 Hz', () => {
    const plan = new CpuGovernor().plan(0, true);
    expect(plan.level).toBe(START_LEVEL);
    expect(plan.intervalMs).toBe(333);
    expect(plan.objectEvery).toBe(3);
    expect(plan.lumaEveryMs).toBe(1_000);
    expect(plan.overBudget).toBe(false);
  });

  it('picks levels by predicted duty (vision + other + object / objectEvery) / interval', () => {
    const g = new CpuGovernor();
    // 10 + 0.5 + 35/3 = 22.2 ms per 333 ms = 0.067 ≤ 0.08: L1 fits.
    const { levels } = drive(g, 0, 5, { visionMs: 10, objectMs: 35 });
    expect(new Set(levels)).toEqual(new Set([1]));
    expect(g.duty).toBeCloseTo((10 + 0.5 + 35 / 3) / 333, 3);
  });

  it('slows down at once when the current level no longer fits', () => {
    const g = new CpuGovernor();
    g.plan(0, true);
    // 30 + 0.5 + 60/3 = 50.5 ms per 333 = 0.15 → L2 (30.5 + 30)/500 = 0.121 → L3 0.106 → L4 0.068.
    g.record(cost(0, 30, 60, true));
    expect(g.plan(333, true).level).toBe(4);
  });

  it('speeds up one level only after 10 s of fitting 0.75 × target', () => {
    const g = new CpuGovernor();
    const { levels } = drive(g, 0, 25, { visionMs: 4, objectMs: 10 });
    const firstL0 = levels.indexOf(0);
    expect(firstL0).toBeGreaterThan(0);
    // 10 s at 3 fps ≈ 30 steps before the first speed-up.
    expect(firstL0).toBeGreaterThanOrEqual(29);
    expect(levels.slice(0, 29).every((l) => l === 1)).toBe(true);
  });

  it('climbs back from L4 one level at a time, never faster than every 10 s', () => {
    const g = new CpuGovernor();
    g.plan(0, true);
    g.record(cost(0, 80, 60, true));
    g.record(cost(1, 80, 60, true)); // two in a row are real, not an outlier
    expect(g.plan(500, true).level).toBe(4);
    // Costs drop: every EMA converges quickly, but each step up waits 10 s.
    const { levels } = drive(g, 1_000, 60, { visionMs: 3, objectMs: 8 });
    const changes: number[] = [];
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] !== levels[i - 1]) changes.push(i);
    }
    expect(levels[levels.length - 1]).toBe(0);
    for (const i of changes) expect(levels[i]).toBe((levels[i - 1] as number) - 1);
  });

  it('does not flap around the boundary', () => {
    const g = new CpuGovernor();
    // Duty oscillating just under/over the target at L1.
    let t = 0;
    let changes = 0;
    let prev = g.plan(0, true).level;
    for (let i = 0; i < 900; i += 1) {
      const plan = g.plan(t, true);
      if (plan.level !== prev) changes += 1;
      prev = plan.level;
      const vision = i % 2 === 0 ? 14 : 16;
      g.record(cost(t, vision, 30, i % plan.objectEvery === 0));
      t += plan.intervalMs;
    }
    expect(changes).toBeLessThanOrEqual(4);
  });

  it('forces one level slower for 10 s when the measured process CPU is too high', () => {
    const g = new CpuGovernor();
    drive(g, 0, 3, { visionMs: 4, objectMs: 10 });
    expect(g.plan(3_000, true).level).toBe(1);
    g.reportProcessCpu(18, 3_000);
    expect(g.plan(3_001, true).level).toBe(2);
    expect(g.processCpuPct).toBe(18);
    // Cheap costs, but no speed-up during the hold.
    const { levels } = drive(g, 3_001, 9, { visionMs: 4, objectMs: 10 });
    expect(levels.every((l) => l === 2)).toBe(true);
    // A value under the limit does nothing by itself.
    g.reportProcessCpu(5, 12_100);
    expect(g.plan(12_100, true).level).toBe(2);
  });

  it('keeps the detector at ≥ 1 Hz without a face', () => {
    const g = new CpuGovernor({}, LOOP_LEVELS);
    g.plan(0, true);
    g.record(cost(0, 40, 60, true));
    g.record(cost(1, 40, 60, true));
    const withFace = g.plan(500, true);
    expect(withFace.level).toBe(4);
    expect(withFace.objectEvery).toBe(8);
    const noFace = g.plan(1_000, false);
    expect(noFace.intervalMs * noFace.objectEvery).toBeLessThanOrEqual(1_000);
  });

  it('never goes under 2 fps and flags an impossible budget', () => {
    const g = new CpuGovernor();
    g.plan(0, true);
    g.record(cost(0, 300, 90, true));
    g.record(cost(1, 300, 90, true));
    const plan = g.plan(1_000, true);
    expect(plan.intervalMs).toBeLessThanOrEqual(500);
    expect(plan.level).toBe(LOOP_LEVELS.length - 1);
    expect(plan.overBudget).toBe(true);
  });

  it('clamps custom levels to 2–4 fps', () => {
    const g = new CpuGovernor({}, [
      { intervalMs: 50, objectEvery: 1 },
      { intervalMs: 5_000, objectEvery: 0 },
    ]);
    const first = g.plan(0, true);
    expect(first.intervalMs).toBeGreaterThanOrEqual(250);
    g.record(cost(0, 200, 0, false));
    g.record(cost(1, 200, 0, false));
    const second = g.plan(1, true);
    expect(second.intervalMs).toBe(500);
    expect(second.objectEvery).toBe(1);
  });

  it('ignores a single outlier step but not two in a row', () => {
    const g = new CpuGovernor();
    drive(g, 0, 2, { visionMs: 10, objectMs: 30 });
    g.record(cost(2_000, 900, 0, false));
    expect(g.plan(2_333, true).level).toBe(1);
    g.record(cost(2_333, 10, 30, false));
    g.record(cost(2_666, 900, 0, false));
    g.record(cost(3_000, 900, 0, false));
    expect(g.plan(3_333, true).level).toBe(4);
  });

  it('counts a detector that is slow on every run (420 ms, fast frames in between): L4, over budget', () => {
    // A cheap laptop on battery saver: face 30 ms, EfficientDet 420 ms on WASM. The detector
    // steps are never consecutive, so a filter that only lets «two slow steps in a row»
    // through would drop every one of them and believe the duty is 6 %.
    const g = new CpuGovernor();
    const cadence = new FrameCadence();
    let t = 0;
    let objectRuns = 0;
    for (let i = 0; i < 120; i += 1) {
      const plan = g.plan(t, true);
      const options = cadence.options(t, plan);
      cadence.done(t, options);
      if (options.objects) objectRuns += 1;
      g.record({
        at: t,
        visionMs: 30,
        objectMs: options.objects ? 420 : 0,
        otherMs: 0.5,
        ranObjects: options.objects,
        faceSeen: true,
      });
      t += plan.intervalMs;
    }
    expect(objectRuns).toBeGreaterThan(5);
    const plan = g.plan(t, true);
    expect(plan.level).toBe(LOOP_LEVELS.length - 1);
    expect(plan.overBudget).toBe(true);
    // The real duty at L4: (30.5 + 420 / 8) / 500 ≈ 0.166 of one core.
    expect(g.duty).toBeCloseTo((30.5 + 420 / 8) / 500, 2);
  });

  it('skips the first slow step of a kind (warm-up) and counts the next one', () => {
    const g = new CpuGovernor();
    g.plan(0, true);
    g.record(cost(0, 30, 0, false)); // frame steps known: 30.5 ms
    g.record(cost(333, 30, 420, true)); // first detector run: skipped as warm-up
    expect(g.plan(666, true).level).toBe(2); // 30.5 / 333 = 0.092 → L2 (0.061)
    g.record(cost(666, 30, 0, false));
    g.record(cost(1_000, 30, 420, true)); // the second slow run is real
    expect(g.plan(1_500, true).level).toBe(4);
  });

  it('still ignores a single slow detector run among normal ones (GC pause)', () => {
    const g = new CpuGovernor();
    drive(g, 0, 5, { visionMs: 10, objectMs: 35 });
    expect(g.plan(5_000, true).level).toBe(1);
    g.record(cost(5_000, 10, 900, true)); // 910 ms > max(400, 3 × 45.5): an outlier
    expect(g.plan(5_333, true).level).toBe(1);
    // Frame-only steps in between do not make a second slow detector run «the first again»…
    g.record(cost(5_333, 10, 0, false));
    g.record(cost(5_666, 10, 0, false));
    g.record(cost(6_000, 10, 900, true));
    // …it is the second in a row for the detector, so it counts.
    expect(g.plan(6_333, true).level).toBe(4);
  });

  it('ignores non-finite costs and CPU readings', () => {
    const g = new CpuGovernor();
    g.record(cost(0, Number.NaN, Number.POSITIVE_INFINITY, true));
    g.reportProcessCpu(Number.NaN, 0);
    const plan = g.plan(0, true);
    expect(plan.level).toBe(1);
    expect(Number.isFinite(g.duty)).toBe(true);
    expect(g.processCpuPct).toBeNull();
  });
});
