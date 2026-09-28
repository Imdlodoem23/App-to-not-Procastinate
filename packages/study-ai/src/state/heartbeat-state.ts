/**
 * Mappings to the guardian's vocabulary (owner: DECISION). DESIGN.md §7.8.
 */
import type { AttentionSnapshot, HeartbeatState, LowCause, StrikeCause } from '../types';
import { notImplemented } from '../util/not-implemented';

/** Informational heartbeat `state` for a snapshot. */
export function heartbeatState(_snapshot: AttentionSnapshot): HeartbeatState {
  return notImplemented('heartbeatState');
}

/** Strike cause on the doubt path: phone and distraction app keep theirs, the rest time out. */
export function strikeCauseFor(_cause: LowCause | null): StrikeCause {
  return notImplemented('strikeCauseFor');
}
