/**
 * «¡Estaba estudiando!»: labels the episode frames and warm-retrains (owner: LEARNING).
 * Never touches strikes. DESIGN.md §6.10.
 */
import type {
  CalibrationProfile,
  FeedbackEpisode,
  IsoUtc,
  LearnFromFeedbackResult,
} from '../types';
import { notImplemented } from '../util/not-implemented';

export function learnFromFeedback(
  _profile: CalibrationProfile,
  _episode: FeedbackEpisode,
  _options: { nowIso: IsoUtc },
): LearnFromFeedbackResult {
  return notImplemented('learnFromFeedback');
}
