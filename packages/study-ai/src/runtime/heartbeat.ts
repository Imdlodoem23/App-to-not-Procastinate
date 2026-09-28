/**
 * Main-process helper (owner: RUNTIME): turns 1 Hz `SessionReport`s into the 15 s heartbeat
 * body and detects a dead analysis loop. Pure and DOM-free (runs in Electron main).
 * DESIGN.md §8.7.
 *
 * Reports carry cumulative totals per `runId`. Deltas are accumulated as reports arrive, so
 * a restarted analysis window (a new `runId` whose totals start again at zero) never re-sends
 * old totals and never loses what the previous run had not sent yet. What exceeds the API
 * limits of one heartbeat (600 000 ms, 100 warnings) carries over to the next one.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import { heartbeatState } from '../state/heartbeat-state';
import type {
  AttentionTotals,
  HeartbeatAccumulatorOptions,
  HeartbeatBody,
  MonoMs,
  SessionReport,
} from '../types';

/** `HeartbeatRequest` limits (ARCHITECTURE §8.8). */
export const HEARTBEAT_MAX_FOCUSED_MS = 600_000;
export const HEARTBEAT_MAX_WARNINGS = 100;

/** Replaced run ids remembered to drop their late reports. */
const MAX_RETIRED_RUNS = 16;

const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

export class HeartbeatAccumulator {
  private readonly deadAfterMs: number;
  private runId: string | null = null;
  private last: AttentionTotals | null = null;
  private latest: SessionReport | null = null;
  private lastReportAt: MonoMs | null = null;
  /** When `totals.ticks` last advanced (or a run started). */
  private progressAt: MonoMs | null = null;
  private pendingFocusedMs = 0;
  private pendingWarnings = 0;
  /** Runs replaced by a newer one (bounded). */
  private readonly retired = new Set<string>();

  constructor(options: HeartbeatAccumulatorOptions = {}) {
    const dead = options.deadAfterMs;
    this.deadAfterMs =
      typeof dead === 'number' && Number.isFinite(dead) && dead > 0
        ? dead
        : STUDY_AI_CONSTANTS.deadLoopMs;
  }

  /** Records a report received at `receivedAt` (main's own monotonic clock). */
  report(report: SessionReport, receivedAt: MonoMs): void {
    const totals = report.totals;
    if (report.runId !== this.runId || this.last === null) {
      // A late report from a run that was already replaced must not count twice.
      if (this.retired.has(report.runId)) return;
      if (this.runId !== null) this.retire(this.runId);
      // A new run counts from zero: everything it reports is new.
      this.runId = report.runId;
      this.pendingFocusedMs += nonNegative(totals.focusedMs);
      this.pendingWarnings += Math.round(nonNegative(totals.warnings));
      this.last = { ...totals };
      this.progressAt = receivedAt;
    } else {
      const last = this.last;
      this.pendingFocusedMs += nonNegative(totals.focusedMs - last.focusedMs);
      this.pendingWarnings += Math.round(nonNegative(totals.warnings - last.warnings));
      if (totals.ticks > last.ticks) this.progressAt = receivedAt;
      // High-water marks: a report that arrives out of order never counts twice.
      this.last = {
        focusedMs: Math.max(totals.focusedMs, last.focusedMs),
        warnings: Math.max(totals.warnings, last.warnings),
        strikesRequested: Math.max(totals.strikesRequested, last.strikesRequested),
        ticks: Math.max(totals.ticks, last.ticks),
        workMs: Math.max(totals.workMs, last.workMs),
      };
    }
    this.latest = report;
    this.lastReportAt = receivedAt;
  }

  private retire(runId: string): void {
    this.retired.add(runId);
    if (this.retired.size > MAX_RETIRED_RUNS) {
      const oldest = this.retired.values().next().value;
      if (oldest !== undefined) this.retired.delete(oldest);
    }
  }

  /**
   * Body for the next heartbeat (deltas since the last `take`, clamped to the API limits),
   * or `null` when the loop is dead: main then stops heartbeating (the guardian decides).
   */
  take(now: MonoMs): HeartbeatBody | null {
    if (!this.alive(now) || this.latest === null) return null;
    const focused = Math.min(HEARTBEAT_MAX_FOCUSED_MS, Math.floor(this.pendingFocusedMs));
    const warnings = Math.min(HEARTBEAT_MAX_WARNINGS, Math.floor(this.pendingWarnings));
    this.pendingFocusedMs -= focused;
    this.pendingWarnings -= warnings;
    const score = this.latest.snapshot.score;
    return {
      state: heartbeatState(this.latest.snapshot),
      focusScore:
        typeof score === 'number' && Number.isFinite(score)
          ? Math.min(100, Math.max(0, Math.round(score)))
          : null,
      focusedMsSinceLast: focused,
      warningsSinceLast: warnings,
      cameraOn: this.latest.cameraOn,
    };
  }

  /**
   * Puts back the deltas of a body that **certainly never reached** the guardian (the request
   * was never sent: no connection could be opened, main refused it before sending), so the
   * next `take` carries them.
   *
   * Never after a request that may have arrived (a timeout, a lost response, a 5xx): the
   * guardian may already have counted it, and restoring would count those focused ms and
   * warnings twice. Resend the identical `{seq, body}` instead until a definitive answer: a
   * `seq` ≤ the last accepted one is a no-op (`duplicate: true`), so an identical resend is
   * exactly-once. Take a new body only after that answer (HANDOFF §4).
   */
  restore(body: HeartbeatBody): void {
    this.pendingFocusedMs += nonNegative(body.focusedMsSinceLast);
    this.pendingWarnings += Math.round(nonNegative(body.warningsSinceLast));
  }

  alive(now: MonoMs): boolean {
    if (this.lastReportAt === null || this.progressAt === null) return false;
    return now - this.progressAt <= this.deadAfterMs;
  }
}
