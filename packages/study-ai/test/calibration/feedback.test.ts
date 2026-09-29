/** «¡Estaba estudiando!»: new examples and a warm retrain, never strikes (DESIGN.md §6.10). */
import { describe, expect, it } from 'vitest';
import { isFeedbackUsable, learnFromFeedback } from '../../src/calibration/feedback';
import { CLASS_INDEX, SRC_CALIBRATION, SRC_FEEDBACK } from '../../src/calibration/train';
import { createPersonalClassifier } from '../../src/classifier/personal';
import { COL } from '../../src/classifier/rows';
import type {
  CalibrationProfile,
  FeedbackEpisode,
  FeedbackFrame,
  FrameFeatures,
} from '../../src/types';
import { PERSONAS } from '../synth';
import {
  LATER,
  NOW,
  activityFrames,
  cpuMs,
  face,
  frame,
  meanStudy,
  postureFrames,
  profileFor,
} from './fixtures';

function episode(
  frames: readonly FrameFeatures[],
  extra: Partial<FeedbackFrame> = {},
  id = 1,
): FeedbackEpisode {
  return {
    ok: true,
    episodeId: id,
    trigger: 'doubt',
    frames: frames.map((f) => ({ frame: f, rel: null, book: false, lookingDown: false, ...extra })),
  };
}

const feedbackRows = (profile: CalibrationProfile, cls: number) =>
  profile.samples.rows.filter(
    (_, i) => profile.samples.src[i] === SRC_FEEDBACK && profile.samples.cls[i] === cls,
  );

describe('learnFromFeedback', () => {
  const profile = profileFor('baseline');
  const base = profile.baseline;

  it('teaches a new study posture (a tablet on a stand): away before, study after', () => {
    const test = postureFrames(base, 38, -8, 200, 5, 0.15);
    const before = createPersonalClassifier(profile);
    expect(meanStudy((f) => before.predict(f), test)).toBeLessThan(0.2);

    const result = learnFromFeedback(profile, episode(postureFrames(base, 38, -8, 30, 6, 0.15)), {
      nowIso: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(30);
    const after = createPersonalClassifier(result.profile);
    expect(meanStudy((f) => after.predict(f), test)).toBeGreaterThan(0.8);
    // Looking away is still looking away, on both sides.
    for (const seed of [77, 78]) {
      const away = activityFrames(PERSONAS.baseline, 'lookAway', seed);
      expect(meanStudy((f) => after.predict(f), away)).toBeLessThan(0.2);
    }
  });

  it('labels looking down, a book or a hidden face as paper, the rest as screen', () => {
    const frames = postureFrames(base, 0, -30, 10, 7);
    const down = learnFromFeedback(profile, episode(frames, { lookingDown: true }), {
      nowIso: LATER,
    });
    const book = learnFromFeedback(profile, episode(frames, { book: true }), { nowIso: LATER });
    const hidden = learnFromFeedback(profile, episode([frame({ face: null, person: 0.9 })]), {
      nowIso: LATER,
    });
    const screen = learnFromFeedback(profile, episode(frames), { nowIso: LATER });
    for (const r of [down, book, hidden]) {
      expect(r.ok && feedbackRows(r.profile, CLASS_INDEX.paper).length).toBeGreaterThan(0);
      expect(r.ok && feedbackRows(r.profile, CLASS_INDEX.screen)).toEqual([]);
    }
    expect(screen.ok && feedbackRows(screen.profile, CLASS_INDEX.screen)).toHaveLength(10);
  });

  it('never lets a phone in hand, an empty view or a covered lens in', () => {
    const good = postureFrames(base, 0, 0, 5, 8);
    const phone = [
      frame({ phone: { score: 0.9, nearFace: true } }),
      frame({ phone: { score: 0.9, nearFace: false, moving: true } }),
    ];
    const empty = [frame({ face: null, person: null }), frame({ face: null, person: 0.2 })];
    const covered = [frame({ face: null, person: 0.9, luma: { covered: true } })];
    const result = learnFromFeedback(profile, episode([...good, ...phone, ...empty, ...covered]), {
      nowIso: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.added).toBe(5);
    const added = feedbackRows(result.profile, CLASS_INDEX.screen);
    expect(added).toHaveLength(5);
    for (const row of added) expect(row[COL.phone]).toBe(0);
    // A phone lying still on the desk (not in hand) does not spoil a frame.
    expect(
      isFeedbackUsable(
        frame({ phone: { score: 0.9, nearFace: false, moving: false } }),
        profile.thresholds,
      ),
    ).toBe(true);
  });

  it('rejects an episode without usable frames', () => {
    const phoneOnly = [frame({ phone: { score: 0.95 } }), frame({ face: null, person: null })];
    expect(learnFromFeedback(profile, episode(phoneOnly), { nowIso: LATER })).toEqual({
      ok: false,
      reason: 'no_usable_frames',
    });
    expect(learnFromFeedback(profile, episode([]), { nowIso: LATER })).toEqual({
      ok: false,
      reason: 'no_usable_frames',
    });
  });

  it('keeps a FIFO of 300 rows per class and never touches the calibration rows', () => {
    let current = profile;
    for (let i = 0; i < 11; i += 1) {
      const frames = postureFrames(base, 0, 0, 30, 100 + i).map((f, j) => ({
        ...f,
        face: f.face && { ...f.face, jawOpen: (i * 30 + j) / 1_000 },
      }));
      const r = learnFromFeedback(current, episode(frames, {}, i), { nowIso: LATER });
      if (!r.ok) throw new Error('feedback failed');
      current = r.profile;
    }
    const rows = feedbackRows(current, CLASS_INDEX.screen);
    expect(rows).toHaveLength(300);
    // The oldest 30 rows (jawOpen 0.000–0.029) were dropped.
    expect(rows[0]?.[COL.jawOpen]).toBe(0.03);
    expect(rows[299]?.[COL.jawOpen]).toBe(0.329);
    const calibration = (p: CalibrationProfile) =>
      p.samples.rows.filter((_, i) => p.samples.src[i] === SRC_CALIBRATION);
    expect(calibration(current)).toEqual(calibration(profile));
    expect(current.clips).toEqual(profile.clips);
  });

  it('cannot outvote a calibration clip: feedback weight is capped', () => {
    let current = profile;
    const away = activityFrames(PERSONAS.baseline, 'lookAway', 40, 120_000);
    for (let i = 0; i < 10; i += 1) {
      const r = learnFromFeedback(current, episode(away.slice(i * 30, i * 30 + 30), {}, i), {
        nowIso: LATER,
      });
      if (!r.ok) throw new Error('feedback failed');
      current = r.profile;
    }
    const clf = createPersonalClassifier(current);
    const recorded = activityFrames(PERSONAS.baseline, 'lookAway', 41);
    expect(meanStudy((f) => clf.predict(f), recorded)).toBeLessThan(0.5);
  });

  it('updates only updatedAt, the samples and the model; never anything about strikes', () => {
    const result = learnFromFeedback(profile, episode(postureFrames(base, 38, -8, 30, 9)), {
      nowIso: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.profile;
    expect(Object.keys(result).sort()).toEqual(['added', 'ok', 'profile', 'report']);
    expect(next.updatedAt).toBe(LATER);
    expect(next.createdAt).toBe(NOW);
    expect(next.model.lambda).toBe(profile.model.lambda);
    expect(next.model.center).toEqual(profile.model.center);
    expect(next.model.anchors).toEqual(profile.model.anchors);
    expect(next.trust).toEqual(profile.trust);
    expect(next.thresholds).toEqual(profile.thresholds);
    expect(next.baseline).toEqual(profile.baseline);
    expect(next.model.W).not.toEqual(profile.model.W);
    expect(result.report.rows).toEqual({ calibration: profile.samples.rows.length, feedback: 30 });
    expect(result.report.iterations).toBeLessThanOrEqual(300);
  });

  it('retrains within 300 ms', () => {
    const frames = episode(postureFrames(base, 30, -20, 30, 10));
    learnFromFeedback(profile, frames, { nowIso: LATER }); // warm up
    const ms = cpuMs(() => {
      expect(learnFromFeedback(profile, frames, { nowIso: LATER }).ok).toBe(true);
    });
    expect(ms).toBeLessThan(300);
  });

  it('measures its time with an injected clock', () => {
    let now = 0;
    const clock = { now: () => (now += 7) };
    const r = learnFromFeedback(profile, episode([frame({ face: face(base) })]), {
      nowIso: LATER,
      clock,
    });
    expect(r.ok && r.report.ms).toBe(7);
  });

  it('rejects a malformed nowIso', () => {
    expect(() => learnFromFeedback(profile, episode([frame()]), { nowIso: 'now' })).toThrow(
      RangeError,
    );
  });
});
