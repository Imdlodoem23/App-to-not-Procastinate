/**
 * «Resumen» timeline helpers (owner: DECISION). DESIGN.md §7.9.
 */
import type { SessionTimeline, TimelineKind } from '../types';
import { notImplemented } from '../util/not-implemented';

/**
 * Fixed-width buckets for the summary line; each bucket takes the worst kind it overlaps
 * (away > doubt > low > drowsy > focused; break and paused only when nothing else).
 */
export function bucketizeTimeline(
  _timeline: SessionTimeline,
  _buckets: number,
): readonly TimelineKind[] {
  return notImplemented('bucketizeTimeline');
}
