/**
 * «¡Estaba estudiando!»: labels the episode frames and warm-retrains (owner: LEARNING).
 * Never touches strikes. DESIGN.md §6.10.
 *
 * Each usable frame becomes a feedback row labelled `paper` (looking down, a book, or a
 * hidden face: head down writing) or `screen`. Frames with a phone in hand, nobody in view or
 * a covered lens never get in, whatever DECISION selected. Rows go into a FIFO of 300 per
 * class; the model is warm-retrained with fixed λ, standardisation and anchors. Nothing here
 * reads or writes strikes: the guardian never refunds one.
 */
import { frameHasSomeone } from '../classifier/personal';
import { frameToRow } from '../classifier/rows';
import { STUDY_AI_CONSTANTS } from '../config';
import { CALIBRATION_CLASSES } from '../types';
import type {
  CalibrationProfile,
  ClassifierThresholds,
  Clock,
  FeedbackEpisode,
  FeatureRow,
  FrameFeatures,
  IsoUtc,
  LearnFromFeedbackResult,
} from '../types';
import { canonicalProfile, isIsoUtc } from './profile';
import { CLASS_INDEX, SRC_CALIBRATION, SRC_FEEDBACK, trainWarm } from './train';

/** A frame the user may vouch for: someone in view, lens not covered, no phone in hand. */
export function isFeedbackUsable(frame: FrameFeatures, thresholds: ClassifierThresholds): boolean {
  if (!frameHasSomeone(frame, thresholds.person)) return false;
  if (frame.luma?.covered) return false;
  const phone = frame.objects?.phone;
  if (phone && phone.score >= thresholds.phone && (phone.nearFace || phone.moving)) return false;
  return true;
}

export function learnFromFeedback(
  profile: CalibrationProfile,
  episode: FeedbackEpisode,
  options: { nowIso: IsoUtc; clock?: Clock },
): LearnFromFeedbackResult {
  if (!isIsoUtc(options.nowIso))
    throw new RangeError('learnFromFeedback: nowIso must be an IsoUtc');
  const fresh: { screen: FeatureRow[]; paper: FeatureRow[] } = { screen: [], paper: [] };
  for (const item of episode.frames.slice(0, STUDY_AI_CONSTANTS.feedbackMaxFrames)) {
    if (!isFeedbackUsable(item.frame, profile.thresholds)) continue;
    const paper = item.lookingDown || item.book || item.frame.face === null;
    fresh[paper ? 'paper' : 'screen'].push(frameToRow(item.frame));
  }
  const added = fresh.screen.length + fresh.paper.length;
  if (added === 0) return { ok: false, reason: 'no_usable_frames' };

  // Calibration rows unchanged; feedback rows per class, oldest dropped past the cap.
  const cls: number[] = [];
  const src: number[] = [];
  const rows: FeatureRow[] = [];
  const s = profile.samples;
  s.rows.forEach((row, i) => {
    if (s.src[i] !== SRC_CALIBRATION) return;
    cls.push(s.cls[i] as number);
    src.push(SRC_CALIBRATION);
    rows.push(row);
  });
  for (const name of CALIBRATION_CLASSES) {
    const c = CLASS_INDEX[name];
    const kept: FeatureRow[] = [];
    s.rows.forEach((row, i) => {
      if (s.src[i] === SRC_FEEDBACK && s.cls[i] === c) kept.push(row);
    });
    if (name === 'screen' || name === 'paper') kept.push(...fresh[name]);
    for (const row of kept.slice(-STUDY_AI_CONSTANTS.feedbackRowsPerClass)) {
      cls.push(c);
      src.push(SRC_FEEDBACK);
      rows.push(row);
    }
  }
  const samples = { cls, src, rows };
  const retrained = trainWarm(
    samples,
    profile.baseline,
    profile.thresholds,
    profile.model,
    options.clock ?? null,
  );
  const next: CalibrationProfile = {
    ...profile,
    updatedAt: options.nowIso,
    samples,
    model: retrained.model,
  };
  return { ok: true, profile: canonicalProfile(next), added, report: retrained.train };
}
