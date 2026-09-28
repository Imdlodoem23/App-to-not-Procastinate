/**
 * «Resumen» timeline helpers (owner: DECISION). DESIGN.md §7.9.
 *
 * Segments are relative to the session start. Neighbours of the same kind are merged and
 * pieces shorter than 5 s are absorbed into the previous segment, so storage stays small
 * (at most one segment per 5 s) and the summary line does not flicker. Time that was not
 * observed (a suspend) leaves a hole.
 */
import type {
  SessionTimeline,
  StrikeCause,
  TimelineKind,
  TimelineMark,
  TimelineSegment,
} from '../types';
import { TIMELINE_MIN_PIECE_MS } from './constants';

interface MutableSegment {
  startMs: number;
  endMs: number;
  kind: TimelineKind;
}

/** Appends one closed piece to `segments`, absorbing short ones and merging neighbours. */
function appendPiece(segments: MutableSegment[], piece: MutableSegment): void {
  if (piece.endMs <= piece.startMs) return;
  const last = segments.at(-1);
  const contiguous = last !== undefined && last.endMs === piece.startMs;
  if (last && contiguous && last.kind === piece.kind) {
    last.endMs = piece.endMs;
    return;
  }
  if (last && contiguous && piece.endMs - piece.startMs < TIMELINE_MIN_PIECE_MS) {
    last.endMs = piece.endMs;
    return;
  }
  segments.push({ ...piece });
}

export class TimelineBuilder {
  private readonly segments: MutableSegment[] = [];
  private open: MutableSegment | null = null;
  private readonly marks: TimelineMark[] = [];

  /** Covers [fromMs, toMs] (relative to the start) with `kind`. */
  add(kind: TimelineKind, fromMs: number, toMs: number): void {
    if (!(toMs > fromMs)) return;
    const open = this.open;
    if (open && open.kind === kind && open.endMs === fromMs) {
      open.endMs = toMs;
      return;
    }
    if (open) appendPiece(this.segments, open);
    // Re-open the last closed segment when the kind comes back right after it.
    const last = this.segments.at(-1);
    if (last && last.kind === kind && last.endMs === fromMs) {
      this.segments.pop();
      last.endMs = toMs;
      this.open = last;
      return;
    }
    this.open = { startMs: fromMs, endMs: toMs, kind };
  }

  mark(kind: TimelineMark['kind'], atMs: number, cause: StrikeCause | null): void {
    this.marks.push({ atMs: Math.max(0, atMs), kind, cause });
  }

  build(durationMs: number): SessionTimeline {
    const segments = this.segments.map((s) => ({ ...s }));
    if (this.open) appendPiece(segments, { ...this.open });
    return {
      durationMs: Math.max(0, durationMs),
      segments: segments.map((s): TimelineSegment => ({ ...s })),
      marks: this.marks.map((m) => ({ ...m })),
    };
  }
}

/** Worst first: a bucket takes the worst kind it overlaps. */
const SEVERITY: readonly TimelineKind[] = ['away', 'doubt', 'low', 'drowsy', 'focused'];

/**
 * Fixed-width buckets for the summary line; each bucket takes the worst kind it overlaps
 * (away > doubt > low > drowsy > focused; break and paused only when nothing else). A
 * bucket that no segment covers (time not observed) reads as `paused`.
 */
export function bucketizeTimeline(
  timeline: SessionTimeline,
  buckets: number,
): readonly TimelineKind[] {
  const n = Math.floor(buckets);
  const duration = timeline.durationMs;
  if (!(n >= 1) || !Number.isFinite(n) || !(duration > 0)) return [];
  const width = duration / n;
  const out: TimelineKind[] = [];
  for (let b = 0; b < n; b += 1) {
    const from = b * width;
    const to = b === n - 1 ? duration : (b + 1) * width;
    const overlap = new Map<TimelineKind, number>();
    for (const s of timeline.segments) {
      const o = Math.min(to, s.endMs) - Math.max(from, s.startMs);
      if (o > 0) overlap.set(s.kind, (overlap.get(s.kind) ?? 0) + o);
    }
    const worst = SEVERITY.find((kind) => overlap.has(kind));
    if (worst) {
      out.push(worst);
    } else {
      const brk = overlap.get('break') ?? 0;
      const paused = overlap.get('paused') ?? 0;
      out.push(brk > paused ? 'break' : 'paused');
    }
  }
  return out;
}
