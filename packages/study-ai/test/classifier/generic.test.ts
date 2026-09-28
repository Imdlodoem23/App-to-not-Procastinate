/** Generic classifier: no profile, other camera, stale profile (DESIGN.md §6.9). */
import { describe, expect, it } from 'vitest';
import {
  createGenericClassifier,
  genericPaperShare,
  genericStudyProbability,
} from '../../src/classifier/generic';
import type { AttentionClassifier, ClassifierObserveHint, FrameFeatures } from '../../src/types';
import { PERSONAS, synthesize, type Activity } from '../synth';
import { face, frame, meanStudy } from '../calibration/fixtures';

const ACTIVE: ClassifierObserveHint = { inputActive: true, distraction: false, phone: false };
const IDLE: ClassifierObserveHint = { inputActive: false, distraction: false, phone: false };

/** Observes `seconds` of frames at 4 fps starting at `t0`; returns the next time. */
function feed(
  clf: AttentionClassifier,
  make: (t: number) => FrameFeatures,
  seconds: number,
  hint: ClassifierObserveHint,
  t0 = 0,
): number {
  let t = t0;
  for (let i = 0; i < seconds * 4; i += 1) {
    clf.observe(make(t), hint);
    t += 250;
  }
  return t;
}

const sum = (p: Readonly<Record<string, number>>): number =>
  Object.values(p).reduce((a, b) => a + b, 0);

describe('createGenericClassifier', () => {
  it('uses the design defaults for thresholds, trust and eyes', () => {
    const clf = createGenericClassifier();
    expect(clf.kind).toBe('generic');
    expect(clf.thresholds).toEqual({ phone: 0.5, person: 0.5 });
    expect(clf.trust).toEqual({ phone: 0, away: 0 });
    expect(clf.eyes).toEqual({ reliable: true, blinkFit: [0.15, -0.004], closedDelta: 0.45 });
  });

  it('is not ready and answers neutral (p.screen 0.8) before 3 s of face frames', () => {
    const clf = createGenericClassifier();
    expect(clf.ready).toBe(false);
    expect(clf.relativePose(face())).toBeNull();
    const t = feed(clf, (t) => frame({ t }), 2, ACTIVE);
    expect(clf.ready).toBe(false);
    const p = clf.predict(frame({ t, face: face({ yaw: 60 }) }));
    expect(p?.screen).toBeCloseTo(0.8, 10);
    expect(sum(p ?? {})).toBeCloseTo(1, 12);
    feed(clf, (t) => frame({ t }), 2, ACTIVE, t);
    expect(clf.ready).toBe(true);
    expect(clf.relativePose(face())?.dyaw).toBeCloseTo(0, 5);
  });

  it('prefers frames with keyboard/mouse active for its baseline', () => {
    const clf = createGenericClassifier();
    // 10 s writing (idle input, head down), then typing at the screen.
    let t = feed(clf, (t) => frame({ t, face: face({ pitch: -40 }) }), 10, IDLE);
    expect(clf.relativePose(face({ pitch: -40 }))?.dpitch).toBeCloseTo(0, 5);
    t = feed(clf, (t) => frame({ t, face: face({ yaw: 5, pitch: -5 }) }), 4, ACTIVE, t);
    expect(clf.relativePose(face({ yaw: 5, pitch: -5 }))?.dpitch).toBeCloseTo(0, 5);
    // Looking down now reads as study (paper), looking at the screen as screen.
    const down = clf.predict(frame({ t, face: face({ yaw: 5, pitch: -40 }) }));
    expect((down?.paper ?? 0) + (down?.screen ?? 0)).toBeGreaterThan(0.95);
    expect(down?.paper ?? 0).toBeGreaterThan(0.95);
  });

  it('freezes the baseline after 20 s of good frames', () => {
    const clf = createGenericClassifier();
    const t = feed(clf, (t) => frame({ t, face: face({ yaw: 3 }) }), 25, ACTIVE);
    feed(clf, (t) => frame({ t, face: face({ yaw: 40 }) }), 60, ACTIVE, t);
    expect(clf.relativePose(face({ yaw: 3 }))?.dyaw).toBeCloseTo(0, 5);
  });

  it('ignores distraction and phone frames for the preferred baseline', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, (t) => frame({ t, face: face({ yaw: 45 }) }), 10, {
      inputActive: true,
      distraction: true,
      phone: false,
    });
    t = feed(clf, (t) => frame({ t, face: face({ yaw: 0 }) }), 5, ACTIVE, t);
    expect(clf.relativePose(face({ yaw: 0 }))?.dyaw).toBeCloseTo(0, 5);
    const p = clf.predict(frame({ t, face: face({ yaw: 45 }) }));
    expect(p?.away ?? 0).toBeGreaterThan(0.8);
  });

  it('applies the pose rules: down is study, turned or up is not', () => {
    expect(genericStudyProbability(0, 0)).toBe(1);
    expect(genericStudyProbability(10, -60)).toBe(1);
    expect(genericStudyProbability(-50, 0)).toBeLessThan(0.2);
    expect(genericStudyProbability(0, 35)).toBeLessThan(0.05);
    expect(genericStudyProbability(0, 20)).toBeGreaterThan(0.9);
    expect(genericStudyProbability(0, -100)).toBeLessThan(0.1);
    expect(genericPaperShare(0)).toBe(0);
    expect(genericPaperShare(-12)).toBeCloseTo(0.5, 10);
    expect(genericPaperShare(-30)).toBe(1);
  });

  it('gives a visible phone in hand 0.9, but not a phone lying still on the desk', () => {
    const clf = createGenericClassifier();
    const t = feed(clf, (t) => frame({ t }), 5, ACTIVE);
    const inHand = clf.predict(frame({ t, face: face({ pitch: -35 }), phone: { score: 0.8 } }));
    expect(inHand?.phone).toBeCloseTo(0.9, 10);
    const onDesk = clf.predict(
      frame({ t, phone: { score: 0.8, nearFace: false, moving: false, stillMs: 60_000 } }),
    );
    expect(onDesk?.phone).toBe(0);
    const weak = clf.predict(frame({ t, phone: { score: 0.4 } }));
    expect(weak?.phone).toBe(0);
  });

  it('returns null for an empty frame and a low study share for a hidden face', () => {
    const clf = createGenericClassifier();
    const t = feed(clf, (t) => frame({ t }), 5, ACTIVE);
    expect(clf.predict(frame({ t, face: null, person: null }))).toBeNull();
    expect(clf.predict(frame({ t, face: null, person: 0.3 }))).toBeNull();
    const hidden = clf.predict(frame({ t, face: null, person: 0.9 }));
    expect(hidden).not.toBeNull();
    expect((hidden?.screen ?? 0) + (hidden?.paper ?? 0)).toBeCloseTo(0.2, 10);
    expect(sum(hidden ?? {})).toBeCloseTo(1, 12);
  });

  it('stays finite for absurd inputs', () => {
    const clf = createGenericClassifier();
    const t = feed(clf, (t) => frame({ t }), 5, ACTIVE);
    const p = clf.predict(frame({ t, face: face({ yaw: 1e6, pitch: -1e6 }) }));
    expect(Object.values(p ?? {}).every(Number.isFinite)).toBe(true);
    expect(sum(p ?? {})).toBeCloseTo(1, 12);
  });

  describe.each(Object.values(PERSONAS))('synth persona $id', (persona) => {
    it('reads study activities as study and looking away as not', () => {
      const script: [Activity, number][] = [
        ['typing', 30_000],
        ['notebook', 60_000],
        ['readBook', 60_000],
        ['screen', 30_000],
        ['lookAway', 30_000],
        ['talkToSomeone', 30_000],
      ];
      const ticks = synthesize(script, { persona, seed: 21 });
      const clf = createGenericClassifier();
      const byActivity = new Map<Activity, FrameFeatures[]>();
      for (const tick of ticks) {
        if (!tick.frame) continue;
        clf.observe(tick.frame, {
          inputActive: (tick.context.idleMs ?? Infinity) < 15_000,
          distraction: false,
          phone: false,
        });
        const list = byActivity.get(tick.activity) ?? [];
        list.push(tick.frame);
        byActivity.set(tick.activity, list);
      }
      // Face frames only: a hidden face is left to DECISION's last-pose rule (0.2 here).
      const predict = (f: FrameFeatures) => (f.face ? clf.predict(f) : null);
      for (const study of ['notebook', 'readBook', 'screen'] as const) {
        expect(meanStudy(predict, byActivity.get(study) ?? []), study).toBeGreaterThan(0.75);
      }
      expect(meanStudy(predict, byActivity.get('lookAway') ?? [])).toBeLessThan(0.4);
      expect(meanStudy(predict, byActivity.get('talkToSomeone') ?? [])).toBeLessThan(0.5);
    });
  });
});
