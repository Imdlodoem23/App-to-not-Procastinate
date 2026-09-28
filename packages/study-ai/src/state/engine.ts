/**
 * Smoothing, hysteresis and the ENFOCADO → DUDA → STRIKE state machine (owner: DECISION).
 * Deterministic: time only comes from `TickInput.now`. DESIGN.md §7.5–7.10.
 */
import type {
  AttentionEngineOptions,
  AttentionEvent,
  AttentionSnapshot,
  AttentionTotals,
  FeedbackEpisodeResult,
  MonoMs,
  Observer,
  SessionTimeline,
  StrikeAck,
  StudyAiSettings,
  TickInput,
  TickOutput,
} from '../types';
import { notImplemented } from '../util/not-implemented';

export class AttentionEngine {
  constructor(_options: AttentionEngineOptions) {}

  tick(_input: TickInput): TickOutput {
    return notImplemented('AttentionEngine.tick');
  }

  /** Guardian answer: a non-counted strike (cooldown) extends the grace. */
  strikeResult(_ack: StrikeAck, _now: MonoMs): void {
    notImplemented('AttentionEngine.strikeResult');
  }

  /** «¡Estaba estudiando!» step 1: the usable frames of the latest episode. */
  feedbackEpisode(_now: MonoMs): FeedbackEpisodeResult {
    return notImplemented('AttentionEngine.feedbackEpisode');
  }

  /**
   * Step 3, after the observer got the retrained classifier: marks the episode used,
   * re-scores the window and clears DUDA only if the new long score is ≥ θ + hysteresis.
   */
  applyFeedback(_now: MonoMs, _episodeId: number): readonly AttentionEvent[] {
    return notImplemented('AttentionEngine.applyFeedback');
  }

  setSettings(_settings: Readonly<StudyAiSettings>): void {
    notImplemented('AttentionEngine.setSettings');
  }

  /** Camera ↔ no-camera switch; resets the window and timers (not the totals). */
  setObserver(_observer: Observer, _now: MonoMs): void {
    notImplemented('AttentionEngine.setObserver');
  }

  /** System resume: same as a gap (timers reset, nothing punished). */
  resume(_now: MonoMs): void {
    notImplemented('AttentionEngine.resume');
  }

  snapshot(): AttentionSnapshot {
    return notImplemented('AttentionEngine.snapshot');
  }

  totals(): AttentionTotals {
    return notImplemented('AttentionEngine.totals');
  }

  timeline(): SessionTimeline {
    return notImplemented('AttentionEngine.timeline');
  }
}
