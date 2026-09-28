/**
 * Main-process helper (owner: RUNTIME): turns 1 Hz `SessionReport`s into the 15 s heartbeat
 * body and detects a dead analysis loop. Pure and DOM-free (runs in Electron main).
 * DESIGN.md §8.7.
 */
import type { HeartbeatAccumulatorOptions, HeartbeatBody, MonoMs, SessionReport } from '../types';
import { notImplemented } from '../util/not-implemented';

export class HeartbeatAccumulator {
  constructor(_options: HeartbeatAccumulatorOptions = {}) {}

  /** Records a report received at `receivedAt` (main's own monotonic clock). */
  report(_report: SessionReport, _receivedAt: MonoMs): void {
    notImplemented('HeartbeatAccumulator.report');
  }

  /**
   * Body for the next heartbeat (deltas since the last `take`, clamped to the API limits),
   * or `null` when the loop is dead: main then stops heartbeating (the guardian decides).
   */
  take(_now: MonoMs): HeartbeatBody | null {
    return notImplemented('HeartbeatAccumulator.take');
  }

  /** Puts back a body that could not be sent so its deltas are not lost. */
  restore(_body: HeartbeatBody): void {
    notImplemented('HeartbeatAccumulator.restore');
  }

  alive(_now: MonoMs): boolean {
    return notImplemented('HeartbeatAccumulator.alive');
  }
}
