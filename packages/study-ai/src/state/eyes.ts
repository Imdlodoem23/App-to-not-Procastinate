/**
 * Drowsiness from closed-eye frames (owner: DECISION). DESIGN.md §7.4.
 *
 * Starts when the eyes were closed ≥ 80 % of the visible time of the last 20 s (with ≥ 50 %
 * coverage), or PERCLOS ≥ 0.3 over 60 s; ends when they were open ≥ 70 % of the last 5 s.
 * The ring is cleared on exit, so an old PERCLOS never re-enters at once.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { MonoMs } from '../types';
import { EYES_MIN_COVERAGE, EYES_OPEN_SHARE, EYES_OPEN_WINDOW_MS } from './constants';

interface EyeSample {
  at: MonoMs;
  span: number;
  visible: boolean;
  closed: boolean;
}

interface Sums {
  visible: number;
  closed: number;
  open: number;
}

export class DrowsyTracker {
  private ring: EyeSample[] = [];
  private on = false;

  get drowsy(): boolean {
    return this.on;
  }

  /** Adds one tick; returns true when drowsiness starts on this tick. */
  update(now: MonoMs, span: number, visible: boolean, closed: boolean): boolean {
    const c = STUDY_AI_CONSTANTS;
    this.ring.push({ at: now, span: Math.max(0, span), visible, closed: visible && closed });
    const from = now - c.perclosWindowMs;
    let drop = 0;
    while (drop < this.ring.length && (this.ring[drop] as EyeSample).at <= from) drop += 1;
    if (drop > 0) this.ring.splice(0, drop);

    if (this.on) {
      const last = this.sums(now, EYES_OPEN_WINDOW_MS);
      if (last.open >= EYES_OPEN_SHARE * EYES_OPEN_WINDOW_MS) {
        this.on = false;
        this.ring = [];
      }
      return false;
    }
    const short = this.sums(now, c.eyesClosedMs);
    const long = this.sums(now, c.perclosWindowMs);
    const closedLong =
      short.visible >= EYES_MIN_COVERAGE * c.eyesClosedMs &&
      short.closed >= c.eyesClosedShare * short.visible;
    const perclos =
      long.visible >= EYES_MIN_COVERAGE * c.perclosWindowMs &&
      long.closed >= c.perclosLimit * long.visible;
    if (closedLong || perclos) {
      this.on = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.ring = [];
    this.on = false;
  }

  private sums(now: MonoMs, spanMs: number): Sums {
    const from = now - spanMs;
    const out: Sums = { visible: 0, closed: 0, open: 0 };
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const s = this.ring[i] as EyeSample;
      if (s.at <= from) break;
      if (!s.visible) continue;
      out.visible += s.span;
      if (s.closed) out.closed += s.span;
      else out.open += s.span;
    }
    return out;
  }
}
