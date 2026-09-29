/**
 * Drowsiness from closed-eye frames (owner: DECISION). DESIGN.md §7.4.
 *
 * Starts when the eyes were closed ≥ 80 % of the visible time of the last 20 s (with ≥ 50 %
 * coverage), or PERCLOS ≥ 0.3 over 60 s; ends when they were open ≥ 70 % of the last 5 s.
 * The ring is cleared on exit, so an old PERCLOS never re-enters at once.
 *
 * Running sums over three windows keep `update` O(1) amortised (it runs on every tick).
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type { MonoMs } from '../types';
import { EYES_MIN_COVERAGE, EYES_OPEN_SHARE, EYES_OPEN_WINDOW_MS } from './constants';

interface EyeSample {
  at: MonoMs;
  visible: number;
  closed: number;
}

/** Sums of the samples with `at` in (now − span, now]. */
class WindowSums {
  head = 0;
  visible = 0;
  closed = 0;

  constructor(readonly span: number) {}

  add(s: EyeSample): void {
    this.visible += s.visible;
    this.closed += s.closed;
  }

  advance(ring: readonly EyeSample[], now: MonoMs): void {
    const from = now - this.span;
    while (this.head < ring.length && (ring[this.head] as EyeSample).at <= from) {
      const s = ring[this.head] as EyeSample;
      this.visible -= s.visible;
      this.closed -= s.closed;
      this.head += 1;
    }
    // Float drift: never below zero.
    if (this.visible < 1e-6) this.visible = 0;
    if (this.closed < 1e-6) this.closed = 0;
  }

  reset(): void {
    this.head = 0;
    this.visible = 0;
    this.closed = 0;
  }
}

export class DrowsyTracker {
  private ring: EyeSample[] = [];
  private readonly open5 = new WindowSums(EYES_OPEN_WINDOW_MS);
  private readonly short = new WindowSums(STUDY_AI_CONSTANTS.eyesClosedMs);
  private readonly long = new WindowSums(STUDY_AI_CONSTANTS.perclosWindowMs);
  private on = false;

  get drowsy(): boolean {
    return this.on;
  }

  /** Adds one tick; returns true when drowsiness starts on this tick. */
  update(now: MonoMs, span: number, visible: boolean, closed: boolean): boolean {
    const c = STUDY_AI_CONSTANTS;
    const ms = Number.isFinite(span) && span > 0 ? span : 0;
    const sample: EyeSample = {
      at: now,
      visible: visible ? ms : 0,
      closed: visible && closed ? ms : 0,
    };
    this.ring.push(sample);
    for (const w of [this.open5, this.short, this.long]) {
      w.add(sample);
      w.advance(this.ring, now);
    }
    this.compact();

    if (this.on) {
      const open = this.open5.visible - this.open5.closed;
      if (open >= EYES_OPEN_SHARE * EYES_OPEN_WINDOW_MS) this.reset();
      return false;
    }
    const closedLong =
      this.short.visible >= EYES_MIN_COVERAGE * c.eyesClosedMs &&
      this.short.closed >= c.eyesClosedShare * this.short.visible;
    const perclos =
      this.long.visible >= EYES_MIN_COVERAGE * c.perclosWindowMs &&
      this.long.closed >= c.perclosLimit * this.long.visible;
    if (closedLong || perclos) {
      this.on = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.ring = [];
    this.open5.reset();
    this.short.reset();
    this.long.reset();
    this.on = false;
  }

  /** Drops samples every window has passed (the 60 s one is the slowest). */
  private compact(): void {
    const drop = this.long.head;
    if (drop < 512 || drop * 2 < this.ring.length) return;
    this.ring = this.ring.slice(drop);
    this.open5.head -= drop;
    this.short.head -= drop;
    this.long.head = 0;
  }
}
