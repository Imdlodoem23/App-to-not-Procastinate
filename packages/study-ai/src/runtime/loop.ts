/**
 * The analysis loop (owner: RUNTIME). setTimeout only (never requestAnimationFrame), one step
 * at a time (the next is scheduled after the current one settles), errors counted and
 * survived. Pure: clock and timers are injected. DESIGN.md §8.1.
 *
 * - **Grid.** The delay is `max(10, interval − elapsed)` measured on a fixed-rate grid (from
 *   when the step was due, not when its timer fired), so timer latency never lowers the rate.
 *   A step that ends more than an interval behind restarts the grid at its end instead of
 *   bursting to catch up.
 * - **Hard duty cap.** Whatever the governor plans, the steps never use more than `maxDuty`
 *   (0.15) of one core over time: a token bucket earns `maxDuty` ms of compute per ms of wall
 *   time (up to a small burst) and every step spends its measured cost. A step that overdraws
 *   it waits until the bucket is back at zero, and the grid restarts after that wait. So a
 *   machine too slow for 2 fps runs a controlled 1–1.5 fps instead of a busy loop that starves
 *   the renderer (IPC, the report timer); the stats say `overBudget`.
 * - **Idle ticks.** A step that returns `null` did no vision work (a break tick, no-camera
 *   mode, a camera that is not delivering): the next step then comes after
 *   `STUDY_AI_CONSTANTS.noCameraTickMs` (1 s) instead of the governor's interval, so idle phases
 *   wake the window once a second.
 * - **Throttling.** `throttled` compares when each analysed frame's timer fired with when it
 *   was asked to fire. Chromium aligns the timers of a hidden page that is throttled anyway (no
 *   `backgroundThrottling: false`) to 1 s wake-ups: the median lateness then exceeds 250 ms
 *   although the loop still ticks once a second. Idle ticks never count, so breaks never flag.
 *   Fewer than 24 ticks in 30 s (a frozen renderer) flags it too, unless the duty cap spaced
 *   them out.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { Clock, LoopPlan, LoopStats, MonoMs, StepCost, TimerApi } from '../types';
import type { CpuGovernor } from './governor';

/** One loop step. Returns its cost, or `null` when it did no vision work (break tick). */
export type LoopStep = (now: MonoMs, plan: LoopPlan) => Promise<StepCost | null>;

export interface AdaptiveLoopOptions {
  /** Hard cap on the share of one core the steps may use over time (0.15). */
  maxDuty?: number;
}

/** Shortest delay between two steps, even when a step overran its interval. */
export const MIN_DELAY_MS = 10;
/** Default hard cap: the brief's 15 % of one core. */
export const MAX_STEP_DUTY = 0.15;
/** Compute the bucket may hold: one slow detector run on top of the frames around it. */
export const DUTY_BURST_MS = 300;
/** `overBudget` stays set this long after the duty cap last delayed a step. */
const DUTY_LIMITED_HOLD_MS = 10_000;
/** Window over which `fps` is measured. */
const FPS_WINDOW_MS = 5_000;
/** `throttled`: under one tick per second over this window while running… */
const THROTTLE_WINDOW_MS = 30_000;
/** …with slack, since idle phases tick at exactly 1 Hz plus timer latency. */
const THROTTLE_MIN_TICKS = 24;
/** `throttled`: median lateness of the analysed frames over the window above this… */
export const THROTTLE_LATE_MS = 250;
/** …once at least this many analysed frames are in the window. */
const THROTTLE_MIN_SAMPLES = 10;

interface Late {
  at: MonoMs;
  ms: number;
}

function sanitizeDuty(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : MAX_STEP_DUTY;
}

export class AdaptiveLoop {
  private readonly step: LoopStep;
  private readonly governor: CpuGovernor;
  private readonly clock: Clock;
  private readonly timers: TimerApi;
  private readonly maxDuty: number;

  private isRunning = false;
  private inFlight = false;
  private handle: unknown = null;
  private hasHandle = false;
  private startedAt: MonoMs = 0;
  private faceSeen = false;
  private alert = false;
  private lastPlan: LoopPlan | null = null;

  private ticks = 0;
  private errors = 0;
  private lastTickAt: MonoMs = 0;
  private prevTickAt: MonoMs | null = null;
  /** When the next step is due on the fixed-rate grid (`null` until the first step). */
  private dueAt: MonoMs | null = null;
  /** When the pending timer was asked to fire (`null` for the first step). */
  private firesAt: MonoMs | null = null;
  private maxGapMs = 0;
  /** Compute the duty cap still allows (ms), and when it was last brought up to date. */
  private credit = DUTY_BURST_MS;
  private creditAt: MonoMs | null = null;
  private limitedAt: MonoMs | null = null;
  /** Start times of recent ticks (all) and of recent vision frames, oldest first. */
  private readonly tickTimes: MonoMs[] = [];
  private readonly frameTimes: MonoMs[] = [];
  /** Timer lateness of recent vision frames, oldest first. */
  private readonly lateness: Late[] = [];

  constructor(
    step: LoopStep,
    governor: CpuGovernor,
    clock: Clock,
    timers: TimerApi,
    options: AdaptiveLoopOptions = {},
  ) {
    this.step = step;
    this.governor = governor;
    this.clock = clock;
    this.timers = timers;
    this.maxDuty = sanitizeDuty(options.maxDuty);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = this.clock.now();
    this.tickTimes.length = 0;
    this.frameTimes.length = 0;
    this.lateness.length = 0;
    this.maxGapMs = 0;
    this.prevTickAt = null;
    this.dueAt = null;
    this.firesAt = null;
    // A step still in flight from before a stop() schedules the next one when it settles.
    if (!this.inFlight) this.schedule(0, this.startedAt);
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
    const limited = this.limitedAt !== null && now - this.limitedAt <= DUTY_LIMITED_HOLD_MS;
    return {
      ticks: this.ticks,
      errors: this.errors,
      fps: Math.round(fps * 100) / 100,
      duty: Math.round(this.governor.duty * 10_000) / 10_000,
      processCpuPct: this.governor.processCpuPct,
      level: this.governor.level,
      overBudget: (this.lastPlan?.overBudget ?? false) || (this.isRunning && limited),
      // The duty cap spaces the ticks out on purpose (then `overBudget` says why).
      throttled: this.isRunning && ((this.fewTicks(now) && !limited) || this.late(now)),
      lastTickAt: this.lastTickAt,
      maxGapMs: this.maxGapMs,
    };
  }

  /** A frozen renderer: under one tick per second for 30 s. */
  private fewTicks(now: MonoMs): boolean {
    if (now - this.startedAt < THROTTLE_WINDOW_MS) return false;
    const ticks = this.tickTimes.filter((t) => now - t <= THROTTLE_WINDOW_MS).length;
    return ticks < THROTTLE_MIN_TICKS;
  }

  /** Throttled timers: the analysed frames' timers fire late (median over 30 s). */
  private late(now: MonoMs): boolean {
    const recent = this.lateness.filter((l) => now - l.at <= THROTTLE_WINDOW_MS).map((l) => l.ms);
    if (recent.length < THROTTLE_MIN_SAMPLES) return false;
    recent.sort((a, b) => a - b);
    const mid = recent.length >> 1;
    const median =
      recent.length % 2 === 1
        ? (recent[mid] as number)
        : ((recent[mid - 1] as number) + (recent[mid] as number)) / 2;
    return median > THROTTLE_LATE_MS;
  }

  private schedule(delayMs: number, now: MonoMs): void {
    if (this.hasHandle) return;
    this.hasHandle = true;
    this.firesAt = now + delayMs;
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
    const late = this.firesAt === null ? 0 : Math.max(0, startedAt - this.firesAt);
    if (this.prevTickAt !== null) {
      this.maxGapMs = Math.max(this.maxGapMs, startedAt - this.prevTickAt);
    }
    this.prevTickAt = startedAt;
    this.lastTickAt = startedAt;
    this.tickTimes.push(startedAt);

    let cost: StepCost | null = null;
    let plan: LoopPlan | null = null;
    let failed = false;
    try {
      plan = this.governor.plan(startedAt, this.faceSeen, this.alert);
      this.lastPlan = plan;
      cost = await this.step(startedAt, plan);
      if (cost) {
        this.governor.record(cost);
        this.faceSeen = cost.faceSeen;
        this.alert = cost.alert === true;
        this.frameTimes.push(startedAt);
        this.lateness.push({ at: startedAt, ms: late });
      }
    } catch {
      this.errors += 1;
      failed = true;
    } finally {
      this.ticks += 1;
      this.inFlight = false;
    }
    this.prune(startedAt);

    if (!this.isRunning) return;
    const now = this.clock.now();
    // What the step cost: its measured compute; a step that threw is charged its wall time
    // (it may have run inference before failing); an idle step did no vision work.
    const busy = cost !== null ? stepBusyMs(cost) : failed ? Math.max(0, now - startedAt) : 0;
    const wait = this.spend(busy, now);

    const interval =
      cost === null || plan === null ? STUDY_AI_CONSTANTS.noCameraTickMs : plan.intervalMs;
    // Fixed-rate: the next step is due one interval after this one was due, so timer latency
    // does not accumulate (2 fps stays 2 fps). More than an interval behind: restart the grid
    // now rather than bursting to catch up.
    let nextDue = (this.dueAt ?? startedAt) + interval;
    if (nextDue < now - interval) nextDue = now;
    let delay = Math.max(MIN_DELAY_MS, nextDue - now);
    if (wait > delay) {
      // The duty cap wins: the grid restarts after the idle time the step needs.
      delay = wait;
      nextDue = now + wait;
      this.limitedAt = now;
    }
    this.dueAt = nextDue;
    this.schedule(delay, now);
  }

  /** Spends `busy` ms from the duty bucket; returns how long to stay idle to repay it. */
  private spend(busy: number, now: MonoMs): number {
    const since = this.creditAt === null ? 0 : Math.max(0, now - this.creditAt);
    this.creditAt = now;
    this.credit = Math.min(DUTY_BURST_MS, this.credit + since * this.maxDuty) - busy;
    return this.credit < 0 ? -this.credit / this.maxDuty : 0;
  }

  private prune(now: MonoMs): void {
    while (this.tickTimes.length > 0 && now - (this.tickTimes[0] as number) > THROTTLE_WINDOW_MS) {
      this.tickTimes.shift();
    }
    while (this.frameTimes.length > 0 && now - (this.frameTimes[0] as number) > FPS_WINDOW_MS) {
      this.frameTimes.shift();
    }
    while (this.lateness.length > 0 && now - (this.lateness[0] as Late).at > THROTTLE_WINDOW_MS) {
      this.lateness.shift();
    }
  }
}

/** Measured compute of a step (non-finite parts count as 0). */
export function stepBusyMs(cost: StepCost): number {
  const part = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
  return part(cost.visionMs) + (cost.ranObjects ? part(cost.objectMs) : 0) + part(cost.otherMs);
}
