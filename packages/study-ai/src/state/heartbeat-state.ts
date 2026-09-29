/**
 * Mappings to the guardian's vocabulary (owner: DECISION). DESIGN.md §7.8.
 */
import type { AttentionSnapshot, HeartbeatState, LowCause, StrikeCause } from '../types';

/** Informational heartbeat `state` for a snapshot. */
export function heartbeatState(snapshot: AttentionSnapshot): HeartbeatState {
  switch (snapshot.state) {
    case 'warmup':
    case 'focused':
      return snapshot.low || snapshot.drowsy ? 'doubt' : 'focused';
    case 'doubt':
      return 'doubt';
    case 'away':
      return 'away';
    case 'break':
      return 'break';
    case 'paused':
    case 'ended':
      return 'paused';
  }
}

/** Strike cause on the doubt path: phone and distraction app keep theirs, the rest time out. */
export function strikeCauseFor(cause: LowCause | null): StrikeCause {
  if (cause === 'phone') return 'phone';
  if (cause === 'distraction_app') return 'distraction_app';
  return 'doubt_timeout';
}
