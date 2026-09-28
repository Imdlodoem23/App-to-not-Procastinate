/**
 * Persistence of detector evidence across runs (owner: DECISION). DESIGN.md §7.2.
 *
 * Only fresh detector runs are stored (the detector runs at 0.25–2 Hz, held values between
 * runs are the same run). The windows are measured in time, with a minimum number of runs so
 * slow loop levels still have evidence.
 */
import { boxesOverlap } from '../perception/geometry';
import type { FrameFeatures, MonoMs } from '../types';
import {
  BOOK_MIN_RUNS,
  BOOK_SCORE,
  BOOK_SHARE,
  BOOK_SPAN_MS,
  PERSON_RUNS,
  PHONE_ENTER_HITS,
  PHONE_ENTER_SHARE,
  PHONE_HOLD_MIN_RUNS,
  PHONE_HOLD_MS,
  PHONE_MIN_RUNS,
  PHONE_SPAN_MS,
  PHONE_STILL_MS,
  RUN_MAX_AGE_MS,
  RUN_RING_MAX,
  RUN_RING_MS,
} from './constants';

interface DetectorRun {
  at: MonoMs;
  /** Phone in hand and in use on this run (`phoneInUseOn`). */
  phone: boolean;
  book: boolean;
  person: number;
}

/** Phone in hand on one frame's detector values. */
export function phoneInHandOn(frame: FrameFeatures, threshold: number): boolean {
  const phone = frame.objects?.phone;
  if (!phone || !(phone.score >= threshold)) return false;
  return (phone.nearFace || phone.moving) && phone.stillMs < PHONE_STILL_MS;
}

/**
 * Phone in hand and in use on one frame: in hand (`phoneInHandOn`) and moving, or the user
 * looks down at it, or holds it against the face, or the face is out of view (bent over it).
 * A phone that does not move near a user who visibly looks at the screen is a timer on a
 * stand or a phone on the desk: no E_phone (the classifier still judges the pose).
 */
export function phoneInUseOn(
  frame: FrameFeatures,
  threshold: number,
  lookingDown: boolean,
): boolean {
  if (!phoneInHandOn(frame, threshold)) return false;
  const phone = frame.objects?.phone;
  const face = frame.luma?.covered ? null : frame.face;
  if (!phone || phone.moving || face === null || lookingDown) return true;
  return boxesOverlap(phone.box, face.box);
}

const isPhone = (run: DetectorRun): boolean => run.phone;
const isBook = (run: DetectorRun): boolean => run.book;

export class DetectorEvidence {
  private runs: DetectorRun[] = [];
  private phoneOn = false;

  /**
   * Records the frame's detector run if it is fresh (once per run). `lookingDown`: the
   * user looks down on this frame (a phone near the face then counts as in use).
   */
  record(frame: FrameFeatures | null, thresholds: { phone: number }, lookingDown = false): void {
    const objects = frame?.objects;
    if (!frame || !objects || !objects.fresh || !Number.isFinite(objects.ranAt)) return;
    const last = this.runs.at(-1);
    if (last && objects.ranAt <= last.at) return;
    this.runs.push({
      at: objects.ranAt,
      phone: phoneInUseOn(frame, thresholds.phone, lookingDown),
      book: (objects.book?.score ?? 0) >= BOOK_SCORE,
      person: Number.isFinite(objects.person?.score) ? (objects.person?.score ?? 0) : 0,
    });
    if (this.runs.length > RUN_RING_MAX) this.runs.splice(0, this.runs.length - RUN_RING_MAX);
  }

  /** Drops old runs and updates the phone hysteresis. Call once per tick. */
  update(now: MonoMs): void {
    const keepFrom = now - RUN_MAX_AGE_MS;
    let drop = 0;
    while (drop < this.runs.length && (this.runs[drop] as DetectorRun).at < keepFrom) drop += 1;
    if (drop > 0) this.runs.splice(0, drop);

    if (this.phoneOn) {
      this.phoneOn = this.count(now, PHONE_HOLD_MS, PHONE_HOLD_MIN_RUNS, isPhone).hits > 0;
      return;
    }
    const recent = this.count(now, PHONE_SPAN_MS, PHONE_MIN_RUNS, isPhone);
    this.phoneOn =
      recent.hits >= PHONE_ENTER_HITS && recent.hits / recent.runs >= PHONE_ENTER_SHARE;
  }

  /** E_phone: a phone in hand, persistent. */
  get phone(): boolean {
    return this.phoneOn;
  }

  /** E_book: a book seen in ≥ 50 % of the recent runs. */
  book(now: MonoMs): boolean {
    const recent = this.count(now, BOOK_SPAN_MS, BOOK_MIN_RUNS, isBook);
    return recent.runs > 0 && recent.hits / recent.runs >= BOOK_SHARE;
  }

  /** A person above `threshold` in any of the last 3 runs (within the retention time). */
  personSeen(threshold: number): boolean {
    const n = this.runs.length;
    for (let i = n - 1; i >= 0 && i >= n - PERSON_RUNS; i -= 1) {
      if ((this.runs[i] as DetectorRun).person >= threshold) return true;
    }
    return false;
  }

  /**
   * Runs of the last `spanMs` (capped at the ring time), or at least the last `minRuns`
   * (within the retention time), and how many of them match.
   */
  private count(
    now: MonoMs,
    spanMs: number,
    minRuns: number,
    match: (run: DetectorRun) => boolean,
  ): { runs: number; hits: number } {
    const from = now - Math.min(spanMs, RUN_RING_MS);
    const n = this.runs.length;
    let i = n;
    while (i > 0 && (this.runs[i - 1] as DetectorRun).at > from) i -= 1;
    const start = n - i >= minRuns ? i : Math.max(0, n - minRuns);
    let hits = 0;
    for (let k = start; k < n; k += 1) if (match(this.runs[k] as DetectorRun)) hits += 1;
    return { runs: n - start, hits };
  }

  /**
   * Forgets the phone hits of the stored runs and turns E_phone off (the user vouched for a
   * phone lying on the desk). A phone in hand elsewhere turns it on again within two runs.
   */
  dropPhone(): void {
    for (const run of this.runs) run.phone = false;
    this.phoneOn = false;
  }

  reset(): void {
    this.runs = [];
    this.phoneOn = false;
  }
}
