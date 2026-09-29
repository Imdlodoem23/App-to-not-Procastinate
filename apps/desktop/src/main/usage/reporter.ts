/**
 * Foreground-app usage for daily limits (ARCHITECTURE §10.13 «Client side», §8.8 «Usage»).
 *
 * Only while the guardian has the `daily_limits` capability, the link is up and
 * `/v1/state.limits` holds an enabled limit: once a second main reads the foreground window's
 * process (the active-window reader) and counts that second for the process name when the
 * user touched the keyboard or mouse in the last `usageIdleSeconds` (60 s) and the screen is
 * not locked. Every `usageReportIntervalMs` (30 s) with unreported seconds, or every
 * `usageFastReportIntervalMs` (5 s) while a limit this app counted toward applies today and
 * has less than 30 s left (from the last answer), the counts go to `POST /v1/usage`.
 *
 * Never a retry: a failed report's seconds are added to the next one, which covers at most
 * `usageMaxIntervalMs` (older seconds are dropped). The guardian clamps everything to real
 * elapsed time and matches the names itself; the app sends every valid process name
 * (`isValidProcessName`) and never a window title. Nothing is logged but counts.
 */
import { isValidProcessName } from '@centrate/shared/catalog';
import {
  GUARDIAN_LIMITS,
  type GuardianStateResponse,
  type UsageItem,
  type UsageReportRequest,
  type UsageReportResponse,
} from '@centrate/shared/guardian-api';
import { hasEnabledLimit } from '../../shared/limits';
import type { Clock, IdleSource, TimerHandle } from '../contracts';
import type { LogFields } from '../logs/logger';

/** One sample per second. */
export const USAGE_SAMPLE_MS = 1_000;

/** What the reporter reads of the foreground (`ForegroundReader.readProcess`). */
export type ForegroundProcess = string | null | 'unsupported';

export interface UsageReporterOptions {
  clock: Clock;
  /** Monotonic milliseconds (`performance.now()`): the report's `intervalMs`. */
  monotonic(): number;
  readProcess(): Promise<ForegroundProcess>;
  /** `null`: idleness unknown (every sample counts). */
  idle: IdleSource | null;
  report(body: UsageReportRequest): Promise<UsageReportResponse>;
  /** A report was accepted (tests, and a poll when a limit ran out). */
  onReported?(response: UsageReportResponse): void;
  log(event: string, fields: LogFields): void;
}

/** Items of one report: the most used names first, at most `usageMaxItems`. */
export function usageItems(counts: ReadonlyMap<string, number>, intervalMs: number): UsageItem[] {
  const cap = Math.ceil(intervalMs / 1_000);
  return [...counts.entries()]
    .filter(([, seconds]) => seconds > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, GUARDIAN_LIMITS.usageMaxItems)
    .map(([value, seconds]) => ({
      type: 'process' as const,
      value,
      seconds: Math.min(Math.max(1, Math.round(seconds)), cap),
    }));
}

/**
 * Report cadence from the last answer: 5 s while a limit this app counted toward (credited
 * seconds) applies today and has less than 30 s left, else 30 s.
 */
export function reportIntervalMs(last: UsageReportResponse | null): number {
  const fast = last?.limits.some(
    (l) =>
      l.appliesToday &&
      l.creditedSeconds > 0 &&
      l.remainingTodaySeconds > 0 &&
      l.remainingTodaySeconds * 1_000 < GUARDIAN_LIMITS.usageReportIntervalMs,
  );
  return fast ? GUARDIAN_LIMITS.usageFastReportIntervalMs : GUARDIAN_LIMITS.usageReportIntervalMs;
}

export class UsageReporter {
  private running = false;
  private stopped = false;
  private timer: TimerHandle | null = null;
  private busy = false;
  private sending = false;
  /** Seconds per process name since the last accepted report. */
  private counts = new Map<string, number>();
  /** Monotonic start of what the next report covers. */
  private since: number | null = null;
  private last: UsageReportResponse | null = null;
  /** After a failure, the next report waits a whole interval (no retry). */
  private nextAt: number | null = null;
  private unsupported = false;

  constructor(private readonly options: UsageReporterOptions) {}

  /** Whether it samples now (tests). */
  active(): boolean {
    return this.running;
  }

  /** Seconds waiting for the next report (tests). */
  pending(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }

  /** Every new snapshot: sample only while a limit exists and the guardian can take it. */
  sync(state: GuardianStateResponse | null, linkOk: boolean, capable: boolean): void {
    if (this.stopped) return;
    const on = capable && linkOk && !this.unsupported && hasEnabledLimit(state);
    if (on && !this.running) {
      this.running = true;
      this.since = this.options.monotonic();
      this.schedule();
    } else if (!on && this.running) {
      this.halt();
    }
  }

  stop(): void {
    this.stopped = true;
    this.halt();
  }

  private halt(): void {
    this.running = false;
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    // What was not sent is dropped: a report after a pause would cover time not counted.
    this.counts = new Map();
    this.since = null;
    this.last = null;
    this.nextAt = null;
  }

  private schedule(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, USAGE_SAMPLE_MS);
  }

  /** The user is at the machine: recent input and an unlocked screen. */
  private present(): boolean {
    const idle = this.options.idle;
    if (!idle) return true;
    try {
      if (idle.locked()) return false;
      return idle.idleSeconds() < GUARDIAN_LIMITS.usageIdleSeconds;
    } catch {
      return false;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (this.present()) {
        const name = await this.options.readProcess();
        if (!this.running) return;
        if (name === 'unsupported') {
          this.unsupported = true;
          this.halt();
          this.options.log('usage_unsupported', {});
          return;
        }
        if (name !== null && isValidProcessName(name)) {
          this.counts.set(name, (this.counts.get(name) ?? 0) + USAGE_SAMPLE_MS / 1_000);
        }
      }
      this.maybeSend();
    } catch (error) {
      this.options.log('usage_sample_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.busy = false;
      if (this.running && !this.stopped) this.schedule();
    }
  }

  private maybeSend(): void {
    if (this.sending || this.since === null || this.counts.size === 0) return;
    const now = this.options.monotonic();
    if (now - this.since < reportIntervalMs(this.last)) return;
    if (this.nextAt !== null && now < this.nextAt) return;
    // Older seconds than the longest interval are dropped (the guardian would clamp them).
    const intervalMs = Math.min(
      GUARDIAN_LIMITS.usageMaxIntervalMs,
      Math.max(1_000, Math.round(now - this.since)),
    );
    const items = usageItems(this.counts, intervalMs);
    if (items.length === 0) return;
    const sentCounts = this.counts;
    this.counts = new Map();
    this.sending = true;
    void this.options
      .report({ intervalMs, items })
      .then(
        (response) => {
          this.last = response;
          this.nextAt = null;
          if (this.running) this.since = now;
          this.options.onReported?.(response);
        },
        (error: unknown) => {
          if (!this.running) return;
          // Never retried: its seconds join the next report (still from the same `since`).
          this.nextAt = now + reportIntervalMs(this.last);
          for (const [name, seconds] of sentCounts) {
            this.counts.set(name, (this.counts.get(name) ?? 0) + seconds);
          }
          this.options.log('usage_report_failed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        },
      )
      .finally(() => {
        this.sending = false;
      });
  }
}
