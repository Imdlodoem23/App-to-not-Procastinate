/** Generic classifier: no profile, other camera, stale profile (DESIGN.md §6.9). */
import { describe, expect, it } from 'vitest';
import {
  createGenericClassifier,
  genericEyesFrom,
  genericPaperShare,
  genericStudyProbability,
  isCalmFace,
  isFreshInput,
} from '../../src/classifier/generic';
import type { AttentionClassifier, ClassifierObserveHint, FrameFeatures } from '../../src/types';
import { gaussian, mulberry32 } from '../../src/util/rng';
import { PERSONAS, synthesize, type Activity, type Persona } from '../synth';
import { face, frame, meanStudy, type FaceSpec } from '../calibration/fixtures';

/** Legacy hints without `idleMs`: `inputActive` decides. */
const ACTIVE: ClassifierObserveHint = { inputActive: true, distraction: false, phone: false };
const IDLE: ClassifierObserveHint = { inputActive: false, distraction: false, phone: false };
/** The observer's hints: fresh input (idle 0.5 s), recent input (idle 5 s), no input. */
const FRESH: ClassifierObserveHint = { ...ACTIVE, idleMs: 500 };
const RECENT: ClassifierObserveHint = { ...ACTIVE, idleMs: 5_000 };
const NO_INPUT: ClassifierObserveHint = { ...IDLE, idleMs: 60_000 };

/** Frames of a face looking `yaw` degrees to the side (at the screen's height). */
const at =
  (yaw: number, spec: FaceSpec = {}) =>
  (t: number): FrameFeatures =>
    frame({ t, face: face({ ...spec, yaw }) });

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

/** p.screen + p.paper for a face frame at time `t`. */
function studyOf(clf: AttentionClassifier, t: number, spec: FaceSpec): number {
  const p = clf.predict(frame({ t, face: face(spec) }));
  return (p?.screen ?? 0) + (p?.paper ?? 0);
}

describe('createGenericClassifier', () => {
  it('uses the design defaults for thresholds, trust and eyes', () => {
    const clf = createGenericClassifier();
    expect(clf.kind).toBe('generic');
    expect(clf.thresholds).toEqual({ phone: 0.5, person: 0.5 });
    expect(clf.trust).toEqual({ phone: 0, away: 0 });
    // Eyes not judged yet: no drowsiness from eyes it has not seen.
    expect(clf.eyes).toEqual({ reliable: false, blinkFit: [0.15, -0.004], closedDelta: 0.45 });
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

  it('keeps its first screen when the user types on a second one', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, (t) => frame({ t, face: face({ yaw: 3 }) }), 25, ACTIVE);
    t = feed(clf, (t) => frame({ t, face: face({ yaw: 40 }) }), 60, ACTIVE, t);
    expect(clf.relativePose(face({ yaw: 3 }))?.dyaw).toBeCloseTo(0, 5);
    expect(clf.relativePose(face({ yaw: 40 }))?.dyaw).toBeCloseTo(0, 5);
    expect(studyOf(clf, t, { yaw: 40 })).toBeGreaterThan(0.95);
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
          idleMs: tick.context.idleMs,
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

describe('generic study directions (one per screen)', () => {
  it('tells fresh input from recent input, and calm frames from looking down', () => {
    expect(isFreshInput({ ...ACTIVE, idleMs: 0 })).toBe(true);
    expect(isFreshInput({ ...ACTIVE, idleMs: 1_999 })).toBe(true);
    expect(isFreshInput({ ...ACTIVE, idleMs: 2_000 })).toBe(false);
    expect(isFreshInput({ ...ACTIVE, idleMs: null })).toBe(false);
    expect(isFreshInput({ ...ACTIVE, idleMs: -1 })).toBe(false);
    expect(isFreshInput({ ...ACTIVE, idleMs: Number.NaN })).toBe(false);
    expect(isFreshInput(ACTIVE)).toBe(true);
    expect(isFreshInput(IDLE)).toBe(false);
    expect(isCalmFace(face())).toBe(true);
    expect(isCalmFace(face({ lookDown: 0.45 }))).toBe(false);
    expect(isCalmFace(face({ pitch: -20 }))).toBe(false);
    expect(isCalmFace(face({ pitch: -19, lookDown: 0.44 }))).toBe(true);
  });

  it('learns a second screen from 3 s of fresh input, never from a glance', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    // Input still "active" (idle 5 s) while the head is turned: a glance, not a screen.
    t = feed(clf, at(45), 20, RECENT, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    t = feed(clf, at(45), 2, FRESH, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    t = feed(clf, at(45), 2, FRESH, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeGreaterThan(0.95);
    expect(studyOf(clf, t, { yaw: 0 })).toBeGreaterThan(0.95);
    expect(studyOf(clf, t, { yaw: -50 })).toBeLessThan(0.1);
    expect(studyOf(clf, t, { yaw: 100 })).toBeLessThan(0.1);
    expect(clf.relativePose(face({ yaw: 45 }))?.dyaw).toBeCloseTo(0, 5);
    expect(clf.relativePose(face({ yaw: 3 }))?.dyaw).toBeCloseTo(3, 5);
    // Writing in front of the second screen is paper relative to it.
    const down = clf.predict(frame({ t, face: face({ yaw: 45, pitch: -40, lookDown: 0.6 }) }));
    expect(down?.paper ?? 0).toBeGreaterThan(0.95);
  });

  it('measures a pose below every screen from the highest one, not a typing direction under it', () => {
    const clf = createGenericClassifier();
    // The screen at eye level (−5°) watched without input, then typing while looking at the
    // keyboard (−18°, eyes a little down, 2° to the side): two study directions.
    let t = feed(clf, at(0), 20, NO_INPUT);
    t = feed(clf, at(-2, { pitch: -18, lookDown: 0.3 }), 5, FRESH, t);
    // Looking at either one is not «down».
    expect(clf.relativePose(face())?.dpitch).toBeCloseTo(0, 5);
    expect(clf.relativePose(face({ yaw: -2, pitch: -18 }))?.dpitch).toBeCloseTo(0, 5);
    // Up to 6° under the typing direction is still that direction.
    expect(clf.relativePose(face({ yaw: -2, pitch: -23 }))?.dpitch).toBeCloseTo(-5, 5);
    // A notebook further down is measured from the screen, also when the head is turned a
    // little more than the 10° free yaw of the screen but not of the typing direction.
    expect(clf.relativePose(face({ pitch: -28 }))?.dpitch).toBeCloseTo(-23, 5);
    expect(clf.relativePose(face({ yaw: -11, pitch: -28 }))?.dpitch).toBeCloseTo(-23, 5);
    const p = clf.predict(frame({ t, face: face({ yaw: -11, pitch: -28, lookDown: 0.35 }) }));
    expect(p?.paper ?? 0).toBeGreaterThan(0.99);
    // Turned far to the side stays measured from the direction that fits best.
    expect(clf.relativePose(face({ yaw: 50, pitch: -28 }))?.dyaw).toBeCloseTo(50, 5);
    expect(studyOf(clf, t, { yaw: 50, pitch: -28 })).toBeLessThan(0.1);
  });

  it('starts a candidate screen over after a 5 s gap in fresh input', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    t = feed(clf, at(45), 2, FRESH, t);
    t = feed(clf, at(0), 6, NO_INPUT, t);
    t = feed(clf, at(45), 2, FRESH, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    t = feed(clf, at(45), 1.5, FRESH, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeGreaterThan(0.95);
  });

  it('keeps at most three screens and drops the one looked at least recently', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    t = feed(clf, at(45), 5, FRESH, t);
    t = feed(clf, at(-45), 5, FRESH, t);
    // Looking at the first two (no input needed) keeps them fresh.
    t = feed(clf, at(0), 30, NO_INPUT, t);
    t = feed(clf, at(45), 30, NO_INPUT, t);
    for (const yaw of [0, 45, -45]) {
      expect(studyOf(clf, t, { yaw }), `${yaw}°`).toBeGreaterThan(0.95);
    }
    t = feed(clf, at(90), 5, FRESH, t);
    for (const yaw of [0, 45, 90]) {
      expect(studyOf(clf, t, { yaw }), `${yaw}°`).toBeGreaterThan(0.95);
    }
    expect(studyOf(clf, t, { yaw: -45 })).toBeLessThan(0.2);
  });

  it('keeps learning: a screen that drifts is followed, never frozen', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    // The head settles 20° to the side over five minutes of typing.
    const n = 5 * 60 * 4;
    for (let i = 0; i < n; i += 1) {
      clf.observe(at((20 * i) / n)(t), FRESH);
      t += 250;
    }
    t = feed(clf, at(20), 20, FRESH, t);
    expect(Math.abs(clf.relativePose(face({ yaw: 20 }))?.dyaw ?? 99)).toBeLessThan(1);
    expect(studyOf(clf, t, { yaw: 70 })).toBeLessThan(0.1);
  });

  it('merges two screens whose centres drift together', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    t = feed(clf, at(25), 5, FRESH, t);
    // The second one creeps back towards the first until they are one screen.
    for (let yaw = 25; yaw >= 5; yaw -= 1) t = feed(clf, at(yaw), 5, FRESH, t);
    t = feed(clf, at(-45), 5, FRESH, t);
    t = feed(clf, at(45), 5, FRESH, t);
    // Merged into one: 0°, −45° and 45° all fit in the three slots.
    for (const yaw of [0, -45, 45]) {
      expect(studyOf(clf, t, { yaw }), `${yaw}°`).toBeGreaterThan(0.95);
    }
  });

  it('is not poisoned by writing right after the click on «Empezar»', () => {
    const clf = createGenericClassifier();
    const notebook: FaceSpec = { pitch: -40, lookDown: 0.6, blink: 0.4 };
    // The click leaves input "active" (idle < 15 s) while the user already writes.
    const hintAt = (t: number): ClassifierObserveHint => ({
      inputActive: t < 15_000,
      distraction: false,
      phone: false,
      idleMs: t,
    });
    let t = 0;
    for (; t < 40_000; t += 250) clf.observe(frame({ t, face: face(notebook) }), hintAt(t));
    // Then a lecture on the screen, with no input at all.
    for (const end = t + 10_000; t < end; t += 250) clf.observe(at(0)(t), hintAt(t));
    expect(clf.relativePose(face())?.dpitch).toBeCloseTo(0, 5);
    expect(studyOf(clf, t, {})).toBeGreaterThan(0.95);
    expect(clf.predict(frame({ t, face: face(notebook) }))?.paper ?? 0).toBeGreaterThan(0.95);
  });

  it('never learns a screen from looking down, a distraction or a phone', () => {
    const hints: ClassifierObserveHint[] = [
      { ...FRESH, distraction: true },
      { ...FRESH, phone: true },
    ];
    for (const hint of hints) {
      const clf = createGenericClassifier();
      const t = feed(clf, at(45), 10, hint, feed(clf, at(0), 20, FRESH));
      expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    }
    const makers = [
      (t: number) => frame({ t, face: face({ yaw: 45 }), phone: { score: 0.9 } }),
      at(45, { pitch: -30 }),
      at(45, { lookDown: 0.6 }),
    ];
    for (const make of makers) {
      const clf = createGenericClassifier();
      const t = feed(clf, make, 10, FRESH, feed(clf, at(0), 20, FRESH));
      expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    }
  });

  it('needs a known idle time: null is never fresh, a missing field uses inputActive', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    t = feed(clf, at(45), 10, { ...FRESH, idleMs: null }, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeLessThan(0.2);
    t = feed(clf, at(45), 4, ACTIVE, t);
    expect(studyOf(clf, t, { yaw: 45 })).toBeGreaterThan(0.95);
  });

  it('predicts in well under 0.1 ms with three screens', () => {
    const clf = createGenericClassifier();
    let t = feed(clf, at(0), 20, FRESH);
    t = feed(clf, at(45), 5, FRESH, t);
    t = feed(clf, at(-45), 5, FRESH, t);
    const frames = Array.from({ length: 200 }, (_, i) => at(i - 100)(t));
    const n = 20_000;
    const start = performance.now();
    for (let i = 0; i < n; i += 1) clf.predict(frames[i % frames.length] as FrameFeatures);
    expect((performance.now() - start) / n).toBeLessThan(0.1);
  });

  describe.each(Object.values(PERSONAS))('synth persona $id', (persona) => {
    it.each([40, 45])('reads a second monitor at %i° the user types on as study', (yaw) => {
      const p: Persona = { ...persona, secondScreenYaw: yaw };
      const ticks = synthesize(
        [
          ['typing', 60_000],
          ['secondMonitor', 120_000],
          ['lookAway', 30_000],
        ],
        { persona: p, seed: 23 },
      );
      const clf = createGenericClassifier();
      const second: FrameFeatures[] = [];
      const away: FrameFeatures[] = [];
      for (const tick of ticks) {
        if (!tick.frame) continue;
        clf.observe(tick.frame, {
          inputActive: (tick.context.idleMs ?? Infinity) < 15_000,
          distraction: false,
          phone: false,
          idleMs: tick.context.idleMs,
        });
        // The second minute on the second monitor: the direction is learned by then.
        if (tick.activity === 'secondMonitor' && tick.now >= 120_000) second.push(tick.frame);
        if (tick.activity === 'lookAway') away.push(tick.frame);
      }
      // Looking away on the second monitor's side is looking at it: judge the other side.
      const otherSide = away.map((f) => {
        const pose = f.face?.pose;
        if (!f.face || !pose) return f;
        const yaw = p.screen.yaw - Math.abs(pose.yaw - p.screen.yaw);
        return { ...f, face: { ...f.face, pose: { ...pose, yaw } } };
      });
      const predict = (f: FrameFeatures) => (f.face ? clf.predict(f) : null);
      expect(meanStudy(predict, second)).toBeGreaterThan(0.9);
      expect(meanStudy(predict, otherSide)).toBeLessThan(0.4);
    });
  });
});

describe('generic online eye model', () => {
  const rng = mulberry32(7);
  /** 30 s of calm frames at the screen with blink values from `blink(i)`. */
  function eyesAfter(blink: (i: number) => number, hint: ClassifierObserveHint = FRESH) {
    const clf = createGenericClassifier();
    for (let i = 0; i < 120; i += 1) {
      clf.observe(frame({ t: i * 250, face: face({ blink: blink(i) }) }), hint);
    }
    return clf.eyes;
  }

  it('applies the profile rule: median > 0.5 or spread > 0.15 is glare', () => {
    const values = (m: number, s: number) =>
      Float64Array.from({ length: 100 }, () => m + gaussian(rng, 0, s));
    expect(genericEyesFrom(values(0.12, 0.03)).reliable).toBe(true);
    expect(genericEyesFrom(values(0.55, 0.03)).reliable).toBe(false);
    expect(genericEyesFrom(values(0.3, 0.2)).reliable).toBe(false);
    expect(genericEyesFrom(values(0.12, 0.03).subarray(0, 19)).reliable).toBe(false);
  });

  it('trusts the eyes of an ordinary user and fits their resting blink', () => {
    const plain = eyesAfter(() => 0.12 + gaussian(rng, 0, 0.03));
    expect(plain.reliable).toBe(true);
    expect(plain.blinkFit[0]).toBe(0.15);
    expect(plain.blinkFit[1]).toBe(-0.004);
    expect(plain.closedDelta).toBe(0.45);
    const narrow = eyesAfter(() => 0.3 + gaussian(rng, 0, 0.03));
    expect(narrow.reliable).toBe(true);
    expect(narrow.blinkFit[0]).toBeCloseTo(0.3, 1);
  });

  it.each([0.55, 0.65])('switches drowsiness off with glasses glare at blink %f', (blink) => {
    expect(eyesAfter(() => blink + gaussian(rng, 0, 0.05)).reliable).toBe(false);
  });

  it('switches it off when the blink value is noisy', () => {
    expect(eyesAfter(() => Math.max(0, 0.3 + gaussian(rng, 0, 0.2))).reliable).toBe(false);
  });

  it('is not fooled by real blinks or eyes closed right after the last keystroke', () => {
    const eyes = eyesAfter((i) => (i % 20 === 0 || (i >= 100 && i < 108) ? 0.95 : 0.12));
    expect(eyes.reliable).toBe(true);
  });

  it('uses the calm frames of the opening baseline when the user does not type', () => {
    expect(eyesAfter(() => 0.6, NO_INPUT).reliable).toBe(false);
    expect(eyesAfter(() => 0.12, NO_INPUT).reliable).toBe(true);
  });

  it('does not judge the eyes on fewer than 20 values', () => {
    const clf = createGenericClassifier();
    feed(clf, at(0), 4, FRESH);
    expect(clf.eyes.reliable).toBe(false);
    feed(clf, at(0), 2, FRESH, 4_000);
    expect(clf.eyes.reliable).toBe(true);
  });
});
