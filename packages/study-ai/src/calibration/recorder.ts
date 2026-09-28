/**
 * Records one calibration situation (owner: LEARNING). DESIGN.md §6.1–6.2.
 *
 * Timeline of one clip (defaults): 0–2 s `settling` (frames ignored while the user gets into
 * position), 2–20 s `recording`, then `done`. `finish` drops the last second (the user
 * reaching for the mouse), caps the clip at 80 rows by even subsampling and runs the per-clip
 * checks. The wizard shows `remainingMs` («Grabando 12 s») and `liveIssues` («no te veo»)
 * while recording. Only numbers are kept: one quantised row per frame.
 */
import { frameToRow } from '../classifier/rows';
import { STUDY_AI_CONSTANTS } from '../config';
import type {
  CalibrationClass,
  CalibrationIssue,
  CalibrationIssueCode,
  CalibrationProgress,
  CalibrationRecorderOptions,
  FeatureRow,
  FrameFeatures,
  MonoMs,
  SituationRecording,
} from '../types';
import { clamp, iqr, median } from '../util/math';
import {
  ABSENT_MAX_SHARE,
  ABSENT_PERSON_SCORE,
  CLIP_BUFFER_LIMIT,
  CLIP_MAX_ROWS,
  DARK_MEDIAN_LUMA,
  LIVE_MIN_ROWS,
  LIVE_MIN_RUNS,
  MAX_COVERED_SHARE,
  MIN_CLIP_ROWS,
  MIN_PRESENT_SHARE,
  PERSON_PRESENT_SCORE,
  PHONE_SEEN_SCORE,
  PHONE_SEEN_SHARE,
  SCREEN_MAX_IQR,
} from './constants';

/** Severity of each issue code (§6.2). */
export const ISSUE_SEVERITY: Readonly<Record<CalibrationIssueCode, 'error' | 'warning'>> =
  Object.freeze({
    missing: 'error',
    too_short: 'error',
    no_face: 'error',
    too_dark: 'error',
    covered: 'error',
    still_visible: 'error',
    phone_not_seen: 'warning',
    same_as_screen: 'error',
    unstable: 'warning',
    weak_separation: 'warning',
  });

export function issue(
  code: CalibrationIssueCode,
  cls: CalibrationClass | null,
  pair?: readonly [CalibrationClass, CalibrationClass],
): CalibrationIssue {
  return pair
    ? { code, cls, severity: ISSUE_SEVERITY[code], pair }
    : { code, cls, severity: ISSUE_SEVERITY[code] };
}

interface Kept {
  t: MonoMs;
  row: FeatureRow;
  face: boolean;
  /** Person score (0 without a detection). */
  person: number;
  /** `null` without a luma sample on this frame. */
  luma: number | null;
  covered: boolean | null;
  /** Fresh detector run on this frame: its phone score, else `null`. */
  run: number | null;
  yaw: number | null;
  pitch: number | null;
}

interface ClipStats {
  rows: number;
  faceRatio: number;
  personRatio: number;
  presentRatio: number;
  absentVisibleRatio: number;
  lumaMedian: number | null;
  coveredShare: number | null;
  runs: number;
  phoneRunShare: number | null;
  yawIqr: number | null;
  pitchIqr: number | null;
}

function stats(kept: readonly Kept[]): ClipStats {
  const n = kept.length;
  let face = 0;
  let person = 0;
  let present = 0;
  let absentVisible = 0;
  const luma: number[] = [];
  let lumaSamples = 0;
  let covered = 0;
  let runs = 0;
  let phoneRuns = 0;
  const yaw: number[] = [];
  const pitch: number[] = [];
  for (const k of kept) {
    const personHere = k.person >= PERSON_PRESENT_SCORE;
    if (k.face) face += 1;
    if (personHere) person += 1;
    if (k.face || personHere) present += 1;
    if (k.face || k.person >= ABSENT_PERSON_SCORE) absentVisible += 1;
    if (k.luma !== null) luma.push(k.luma);
    if (k.covered !== null) {
      lumaSamples += 1;
      if (k.covered) covered += 1;
    }
    if (k.run !== null) {
      runs += 1;
      if (k.run >= PHONE_SEEN_SCORE) phoneRuns += 1;
    }
    if (k.yaw !== null && k.pitch !== null) {
      yaw.push(k.yaw);
      pitch.push(k.pitch);
    }
  }
  const share = (count: number): number => (n > 0 ? count / n : 0);
  return {
    rows: n,
    faceRatio: share(face),
    personRatio: share(person),
    presentRatio: share(present),
    absentVisibleRatio: share(absentVisible),
    lumaMedian: luma.length > 0 ? median(luma) : null,
    coveredShare: lumaSamples > 0 ? covered / lumaSamples : null,
    runs,
    phoneRunShare: runs > 0 ? phoneRuns / runs : null,
    yawIqr: yaw.length > 0 ? iqr(yaw) : null,
    pitchIqr: pitch.length > 0 ? iqr(pitch) : null,
  };
}

/** Per-clip checks. `final` adds the ones that only make sense at the end. */
function clipIssues(cls: CalibrationClass, s: ClipStats, final: boolean): CalibrationIssue[] {
  const out: CalibrationIssue[] = [];
  if (final && s.rows < MIN_CLIP_ROWS) out.push(issue('too_short', cls));
  if (s.rows === 0) return out;
  if (cls !== 'absent' && s.presentRatio < MIN_PRESENT_SHARE) out.push(issue('no_face', cls));
  if (s.lumaMedian !== null && s.lumaMedian < DARK_MEDIAN_LUMA) out.push(issue('too_dark', cls));
  if (s.coveredShare !== null && s.coveredShare >= MAX_COVERED_SHARE)
    out.push(issue('covered', cls));
  if (cls === 'absent' && s.absentVisibleRatio > ABSENT_MAX_SHARE) {
    out.push(issue('still_visible', cls));
  }
  if (cls === 'phone' && (final || s.runs >= LIVE_MIN_RUNS)) {
    if (s.phoneRunShare === null || s.phoneRunShare < PHONE_SEEN_SHARE) {
      out.push(issue('phone_not_seen', cls));
    }
  }
  if (
    cls === 'screen' &&
    final &&
    ((s.yawIqr ?? 0) > SCREEN_MAX_IQR || (s.pitchIqr ?? 0) > SCREEN_MAX_IQR)
  ) {
    out.push(issue('unstable', cls));
  }
  return out;
}

/** Evenly subsamples `items` down to `max` (keeps the first and spreads the rest). */
function evenly<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  const step = items.length / max;
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor(i * step)] as T);
  return out;
}

export class CalibrationRecorder {
  readonly cls: CalibrationClass;
  readonly startedAt: MonoMs;
  private readonly durationMs: number;
  private readonly settleMs: number;
  private readonly tailMs: number;
  private readonly maxRows: number;
  private readonly kept: Kept[] = [];
  private finished: SituationRecording | null = null;

  constructor(cls: CalibrationClass, startedAt: MonoMs, options: CalibrationRecorderOptions = {}) {
    this.cls = cls;
    this.startedAt = startedAt;
    const num = (v: number | undefined, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
    this.durationMs = Math.max(
      1,
      num(options.durationMs, STUDY_AI_CONSTANTS.calibrationDurationMs),
    );
    this.settleMs = clamp(
      num(options.settleMs, STUDY_AI_CONSTANTS.calibrationSettleMs),
      0,
      this.durationMs,
    );
    this.tailMs = clamp(
      num(options.tailMs, STUDY_AI_CONSTANTS.calibrationTailMs),
      0,
      this.durationMs - this.settleMs,
    );
    this.maxRows = Math.max(1, Math.floor(num(options.maxRows, CLIP_MAX_ROWS)));
  }

  private phaseAt(now: MonoMs): CalibrationProgress['phase'] {
    if (this.finished) return 'done';
    const elapsed = now - this.startedAt;
    if (elapsed < this.settleMs) return 'settling';
    return elapsed < this.durationMs ? 'recording' : 'done';
  }

  /** Adds a frame (ignored while settling or after the end). */
  push(frame: FrameFeatures): CalibrationProgress {
    const t = frame.t;
    if (
      Number.isFinite(t) &&
      this.phaseAt(t) === 'recording' &&
      this.kept.length < CLIP_BUFFER_LIMIT &&
      (this.kept.length === 0 || t > (this.kept[this.kept.length - 1] as Kept).t)
    ) {
      const objects = frame.objects;
      this.kept.push({
        t,
        row: frameToRow(frame),
        face: frame.face !== null,
        person: Number.isFinite(objects?.person?.score) ? (objects?.person?.score as number) : 0,
        luma: frame.luma && Number.isFinite(frame.luma.mean) ? frame.luma.mean : null,
        covered: frame.luma ? frame.luma.covered : null,
        run: objects?.fresh
          ? Number.isFinite(objects.phone?.score)
            ? (objects.phone?.score as number)
            : 0
          : null,
        yaw: frame.face && Number.isFinite(frame.face.pose.yaw) ? frame.face.pose.yaw : null,
        pitch: frame.face && Number.isFinite(frame.face.pose.pitch) ? frame.face.pose.pitch : null,
      });
    }
    return this.progress(t);
  }

  progress(now: MonoMs): CalibrationProgress {
    const elapsed = clamp(now - this.startedAt, 0, this.durationMs);
    const phase = this.phaseAt(now);
    if (this.finished) {
      return {
        cls: this.cls,
        phase: 'done',
        elapsedMs: this.finished.durationMs,
        remainingMs: 0,
        frames: this.finished.rows.length,
        faceRatio: this.finished.faceRatio,
        liveIssues: this.finished.issues.map((i) => i.code),
      };
    }
    const s = stats(this.kept);
    const live = s.rows >= LIVE_MIN_ROWS ? clipIssues(this.cls, s, false).map((i) => i.code) : [];
    return {
      cls: this.cls,
      phase,
      elapsedMs: elapsed,
      remainingMs: Math.max(0, this.durationMs - elapsed),
      frames: s.rows,
      faceRatio: s.faceRatio,
      liveIssues: live,
    };
  }

  /** Trims the tail, runs the per-clip checks and returns the rows. Idempotent. */
  finish(now: MonoMs): SituationRecording {
    if (this.finished) return this.finished;
    const end = Math.min(
      Number.isFinite(now) ? now : this.startedAt,
      this.startedAt + this.durationMs,
    );
    const cut = end - this.tailMs;
    const kept = evenly(
      this.kept.filter((k) => k.t <= cut),
      this.maxRows,
    );
    const s = stats(kept);
    this.finished = Object.freeze({
      cls: this.cls,
      startedAt: this.startedAt,
      durationMs: Math.max(0, end - this.startedAt),
      rows: Object.freeze(kept.map((k) => k.row)),
      faceRatio: s.faceRatio,
      personRatio: s.personRatio,
      issues: Object.freeze(clipIssues(this.cls, s, true)),
    });
    this.kept.length = 0;
    return this.finished;
  }
}
