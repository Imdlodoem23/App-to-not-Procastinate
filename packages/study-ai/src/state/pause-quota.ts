/**
 * Local pause quota (owner: DECISION). The guardian computes phases and enforces the quota
 * (ARCHITECTURE §10.4): at most 2 pauses may start per hour of awake time, each at most 5 min.
 * The engine enforces the same limits on the phase it receives, so a stale or forged
 * `paused` phase (main lost the guardian, a bug) cannot freeze the timers beyond the quota:
 * past it, the phase is treated as `work`. Strikes stay the guardian's call either way.
 *
 * Time is the engine's observed step time (gaps such as a suspend never count), like the
 * guardian's awake time.
 */
import type { StudyPhase } from '../types';
import { PAUSE_MERGE_MS, PAUSE_OVERRUN_SLACK_MS, PAUSE_RULES } from './constants';

export interface PauseQuotaLimits {
  pauseMs: number;
  maxPausesPerWindow: number;
  pauseWindowMs: number;
  overrunSlackMs: number;
  mergeMs: number;
}

export interface PauseQuotaStatus {
  /** Pauses started within the last window. */
  used: number;
  remaining: number;
  /** The current `paused` phase is past the local quota and counts as work. */
  overQuota: boolean;
}

interface PauseRun {
  elapsed: number;
  over: boolean;
}

export const DEFAULT_PAUSE_LIMITS: Readonly<PauseQuotaLimits> = Object.freeze({
  ...PAUSE_RULES,
  overrunSlackMs: PAUSE_OVERRUN_SLACK_MS,
  mergeMs: PAUSE_MERGE_MS,
});

export class PauseQuota {
  private awakeMs = 0;
  private starts: number[] = [];
  private current: PauseRun | null = null;
  private last: PauseRun | null = null;
  private lastEndedAt: number | null = null;

  constructor(private readonly limits: Readonly<PauseQuotaLimits> = DEFAULT_PAUSE_LIMITS) {}

  /** Advances by `stepMs` of observed time; returns the phase the engine should use. */
  step(phase: StudyPhase, stepMs: number): StudyPhase {
    const step = Number.isFinite(stepMs) && stepMs > 0 ? stepMs : 0;
    this.awakeMs += step;
    const windowFrom = this.awakeMs - this.limits.pauseWindowMs;
    while (this.starts.length > 0 && (this.starts[0] as number) <= windowFrom) this.starts.shift();

    if (phase !== 'paused') {
      if (this.current) {
        this.last = this.current;
        this.lastEndedAt = this.awakeMs;
        this.current = null;
      }
      return phase;
    }

    if (this.current) {
      this.current.elapsed += step;
    } else if (
      this.last &&
      this.lastEndedAt !== null &&
      this.awakeMs - this.lastEndedAt <= this.limits.mergeMs
    ) {
      // The same pause flickered (a polling glitch): continue it.
      this.current = this.last;
      this.current.elapsed += step;
    } else {
      const over = this.starts.length >= this.limits.maxPausesPerWindow;
      if (!over) this.starts.push(this.awakeMs);
      this.current = { elapsed: 0, over };
    }
    return this.overQuota() ? 'work' : 'paused';
  }

  status(): PauseQuotaStatus {
    const used = this.starts.length;
    return {
      used,
      remaining: Math.max(0, this.limits.maxPausesPerWindow - used),
      overQuota: this.overQuota(),
    };
  }

  private overQuota(): boolean {
    const run = this.current;
    if (!run) return false;
    return run.over || run.elapsed > this.limits.pauseMs + this.limits.overrunSlackMs;
  }
}
