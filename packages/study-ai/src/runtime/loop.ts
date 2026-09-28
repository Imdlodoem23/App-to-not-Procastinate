/**
 * The analysis loop (owner: RUNTIME). setTimeout only (never requestAnimationFrame), one step
 * at a time (the next is scheduled after the current one settles), errors counted and
 * survived. Pure: clock and timers are injected. DESIGN.md §8.1.
 *
 * The delay is `max(10, interval − elapsed)` measured on a fixed-rate grid (from when the step
 * was due, not when its timer fired), so timer latency never lowers the rate.
 *
 * A step that returns `null` did no vision work (a break tick, no-camera mode, a camera that
 * is not delivering): the next step then comes after `STUDY_AI_CONSTANTS.noCameraTickMs`
 * (1 s) instead of the governor's interval, so idle phases wake the window once a second.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { Clock, LoopPlan, LoopStats, MonoMs, StepCost, TimerApi } from '../types';
import type { CpuGovernor } from './governor';

/** One loop step. Returns its cost, or `null` when it did no vision work (break tick). */
export type LoopStep = (now: MonoMs, plan: LoopPlan) => Promise<StepCost | null>;

/** Shortest delay between two steps, even when a step overran its interval. */
const MIN_DELAY_MS = 10;
/** Window over which `fps` is measured. */
const FPS_WINDOW_MS = 5_000;
/** `throttled`: under one tick per second over this window while running… */
const THROTTLE_WINDOW_MS = 30_000;
/** …with slack, since idle phases tick at exactly 1 Hz plus timer latency. */
const THROTTLE_MIN_TICKS = 24;

export class AdaptiveLoop {
  private readonly step: LoopStep;
  private readonly governor: CpuGovernor;
  private readonly clock: Clock;
  private readonly timers: TimerApi;

  private isRunning = false;
  private inFlight = false;
  private handle: unknown = null;
  private hasHandle = false;
  private startedAt: MonoMs = 0;
  private faceSeen = false;
  private lastPlan: LoopPlan | null = null;

  private ticks = 0;
  private errors = 0;
  private lastTickAt: MonoMs = 0;
  private prevTickAt: MonoMs | null = null;
  /** When the next step is due on the fixed-rate grid (`null` until the first step). */
  private dueAt: MonoMs | null = null;
  private maxGapMs = 0;
  /** Start times of recent ticks (all) and of recent vision frames, oldest first. */
  private readonly tickTimes: MonoMs[] = [];
  private readonly frameTimes: MonoMs[] = [];

  constructor(step: LoopStep, governor: CpuGovernor, clock: Clock, timers: TimerApi) {
    this.step = step;
    this.governor = governor;
    this.clock = clock;
    this.timers = timers;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = this.clock.now();
    this.tickTimes.length = 0;
    this.frameTimes.length = 0;
    this.maxGapMs = 0;
    this.prevTickAt = null;
    this.dueAt = null;
    // A step still in flight from before a stop() schedules the next one when it settles.
    if (!this.inFlight) this.schedule(0);
  }

  /** Clears the pending timer; a step in flight finishes but schedules nothing. */
  stop(): void {
    this.isRunning = false;
    if (this.hasHandle) {
      this.timers.clear(this.handle);
      this.hasHandle = false;
      this.handle = null;
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  get stats(): Readonly<LoopStats> {
    const now = this.clock.now();
    this.prune(now);
    const span = Math.min(FPS_WINDOW_MS, Math.max(1_000, now - this.startedAt));
    const frames = this.frameTimes.filter((t) => now - t < span).length;
    const fps = this.isRunning ? (frames * 1_000) / span : 0;
    const ticksInWindow = this.tickTimes.filter((t) => now - t <= THROTTLE_WINDOW_MS).length;
    const throttled =
      this.isRunning &&
      now - this.startedAt >= THROTTLE_WINDOW_MS &&
      ticksInWindow < THROTTLE_MIN_TICKS;
    return {
      ticks: this.ticks,
      errors: this.errors,
      fps: Math.round(fps * 100) / 100,
      duty: Math.round(this.governor.duty * 10_000) / 10_000,
      processCpuPct: this.governor.processCpuPct,
      level: this.governor.level,
      overBudget: this.lastPlan?.overBudget ?? false,
      throttled,
      lastTickAt: this.lastTickAt,
      maxGapMs: this.maxGapMs,
    };
  }

  private schedule(delayMs: number): void {
    if (this.hasHandle) return;
    this.hasHandle = true;
    this.handle = this.timers.set(() => {
      this.hasHandle = false;
      this.handle = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (!this.isRunning || this.inFlight) return;
    this.inFlight = true;
    const startedAt = this.clock.now();
    if (this.prevTickAt !== null) {
      this.maxGapMs = Math.max(this.maxGapMs, startedAt - this.prevTickAt);
    }
    this.prevTickAt = startedAt;
    this.lastTickAt = startedAt;
    this.tickTimes.push(startedAt);

    let cost: StepCost | null = null;
    let plan: LoopPlan | null = null;
    try {
      plan = this.governor.plan(startedAt, this.faceSeen);
      this.lastPlan = plan;
      cost = await this.step(startedAt, plan);
      if (cost) {
        this.governor.record(cost);
        this.faceSeen = cost.faceSeen;
        this.frameTimes.push(startedAt);
      }
    } catch {
      this.errors += 1;
    } finally {
      this.ticks += 1;
      this.inFlight = false;
    }
    this.prune(startedAt);

    if (!this.isRunning) return;
    const now = this.clock.now();
    const interval =
      cost === null || plan === null ? STUDY_AI_CONSTANTS.noCameraTickMs : plan.intervalMs;
    // Fixed-rate: the next step is due one interval after this one was due, so timer latency
    // does not accumulate (2 fps stays 2 fps). A step that overran by more than an interval
    // restarts the grid instead of bursting to catch up.
    let nextDue = (this.dueAt ?? startedAt) + interval;
    if (nextDue < now - interval) nextDue = now;
    this.dueAt = nextDue;
    this.schedule(Math.max(MIN_DELAY_MS, nextDue - now));
  }

  private prune(now: MonoMs): void {
    while (this.tickTimes.length > 0 && now - (this.tickTimes[0] as number) > THROTTLE_WINDOW_MS) {
      this.tickTimes.shift();
    }
    while (this.frameTimes.length > 0 && now - (this.frameTimes[0] as number) > FPS_WINDOW_MS) {
      this.frameTimes.shift();
    }
  }
}
