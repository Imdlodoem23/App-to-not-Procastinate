/** Personal classifier built from a calibration profile (DESIGN.md §6.4–6.8, §6.12 personas). */
import { describe, expect, it } from 'vitest';
import { createPersonalClassifier } from '../../src/classifier/personal';
import type { ClassifierObserveHint, FrameFeatures } from '../../src/types';
import { PERSONAS, type Activity, type PersonaId } from '../synth';
import { activityFrames, cpuMs, face, frame, meanStudy, profileFor } from '../calibration/fixtures';

const STUDY: readonly Activity[] = [
  'screen',
  'typing',
  'notebook',
  'readBook',
  'coffeeSip',
  'phoneOnDesk',
];
const ACTIVE: ClassifierObserveHint = { inputActive: true, distraction: false, phone: false };

describe('createPersonalClassifier', () => {
  it('exposes the profile values', () => {
    const profile = profileFor('baseline');
    const clf = createPersonalClassifier(profile);
    expect(clf.kind).toBe('personal');
    expect(clf.ready).toBe(true);
    expect(clf.thresholds).toEqual(profile.thresholds);
    expect(clf.trust).toEqual(profile.trust);
    expect(clf.eyes).toEqual(profile.eyes);
    expect(
      clf.relativePose(face({ ...profile.baseline, pitch: profile.baseline.pitch })),
    ).toMatchObject({
      dyaw: 0,
      dpitch: 0,
      droll: 0,
    });
  });

  describe.each(Object.keys(PERSONAS) as PersonaId[])('persona %s', (id) => {
    const persona = PERSONAS[id];

    it('reads its study activities as study', () => {
      const clf = createPersonalClassifier(profileFor(id));
      // Face frames: a hidden face is capped at 0.2 and judged by DECISION's last-pose rule.
      const predict = (f: FrameFeatures) => (f.face ? clf.predict(f) : null);
      const activities: Activity[] = [...STUDY];
      if (id === 'secondMonitor') activities.push('secondMonitor');
      for (const activity of activities) {
        expect(meanStudy(predict, activityFrames(persona, activity)), activity).toBeGreaterThan(
          0.6,
        );
      }
    });

    it('reads the phone in hand as phone and looking away as not studying', () => {
      const clf = createPersonalClassifier(profileFor(id));
      const predict = (f: FrameFeatures) => clf.predict(f);
      const phone = activityFrames(persona, 'phoneInHand').filter(
        (f) => (f.objects?.phone?.score ?? 0) >= 0.5,
      );
      expect(meanStudy(predict, phone)).toBeLessThan(0.2);
      // With a second screen at +35°, a glance to that side is legitimately ambiguous.
      if (id !== 'secondMonitor') {
        expect(meanStudy(predict, activityFrames(persona, 'lookAway'))).toBeLessThan(0.3);
        expect(meanStudy(predict, activityFrames(persona, 'talkToSomeone'))).toBeLessThan(0.3);
      }
    });

    it('answers null only for empty frames', () => {
      const clf = createPersonalClassifier(profileFor(id));
      for (const f of activityFrames(persona, 'absent', 5, 10_000))
        expect(clf.predict(f)).toBeNull();
      expect(clf.predict(frame({ face: null, person: 0.95 }))).not.toBeNull();
    });
  });

  it('never vouches for studying without a face (DECISION’s last-pose rule decides)', () => {
    const clf = createPersonalClassifier(profileFor('baseline'));
    for (const extra of [{}, { book: 0.8 }]) {
      const p = clf.predict(frame({ face: null, person: 0.95, ...extra }));
      expect((p?.screen ?? 1) + (p?.paper ?? 1)).toBeLessThanOrEqual(0.2 + 1e-12);
      expect(Object.values(p ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    const phone = clf.predict(frame({ face: null, person: 0.95, phone: { score: 0.85 } }));
    expect(phone?.phone ?? 0).toBeGreaterThan(0.5);
  });

  it('looks away on both sides even when calibration saw only one', () => {
    const profile = profileFor('baseline');
    const clf = createPersonalClassifier(profile);
    const b = profile.baseline;
    for (const side of [-1, 1]) {
      const f = frame({
        face: face({ ...b, yaw: b.yaw + side * 50, pitch: b.pitch + 5, gazeX: side * 0.3 }),
      });
      expect(clf.predict(f)?.away ?? 0, `side ${side}`).toBeGreaterThan(0.8);
    }
  });

  it('predicts in ≤ 0.1 ms', () => {
    const clf = createPersonalClassifier(profileFor('baseline'));
    const frames = activityFrames(PERSONAS.baseline, 'screen', 3, 30_000);
    for (const f of frames) clf.predict(f); // warm up
    const rounds = 20;
    const ms = cpuMs(() => {
      for (let r = 0; r < rounds; r += 1) for (const f of frames) clf.predict(f);
    });
    expect(ms / (rounds * frames.length)).toBeLessThan(0.1);
  });

  it('stays finite and normalised for absurd inputs', () => {
    const clf = createPersonalClassifier(profileFor('baseline'));
    for (const v of [1e6, -1e6]) {
      const p = clf.predict(
        frame({
          face: face({ yaw: v, pitch: v, cx: v, h: Math.abs(v), blink: v, gazeX: v }),
          person: v,
        }),
      );
      const values = Object.values(p ?? {});
      expect(values.every(Number.isFinite)).toBe(true);
      expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
  });

  describe('baseline drift (±10°, τ 10 min)', () => {
    const profile = profileFor('baseline');
    const b = profile.baseline;
    const at = (t: number, dyaw: number) => frame({ t, face: face({ ...b, yaw: b.yaw + dyaw }) });

    it('follows a slowly shifted screen pose', () => {
      const clf = createPersonalClassifier(profile);
      for (let t = 0; t <= 30 * 60_000; t += 1_000) clf.observe(at(t, 8), ACTIVE);
      const dyaw = clf.relativePose(at(0, 8).face ?? face())?.dyaw ?? 0;
      // After 3 τ, about 95 % of the 8° offset is absorbed.
      expect(dyaw).toBeGreaterThan(0);
      expect(dyaw).toBeLessThan(1);
    });

    it('never drifts more than 10°', () => {
      const clf = createPersonalClassifier(profile);
      let offset = 0;
      for (let t = 0; t <= 120 * 60_000; t += 1_000) {
        // The user keeps turning a little further as the drift catches up.
        const rel = clf.relativePose(at(t, offset).face ?? face())?.dyaw ?? 0;
        if (Math.abs(rel) < 2) offset += 0.5;
        clf.observe(at(t, offset), ACTIVE);
      }
      const drift = offset - (clf.relativePose(at(0, offset).face ?? face())?.dyaw ?? 0);
      expect(drift).toBeLessThanOrEqual(10 + 1e-9);
      expect(drift).toBeGreaterThan(9);
    });

    it('does not move without input, with a distraction, with a phone, or after a gap', () => {
      for (const hint of [
        { inputActive: false, distraction: false, phone: false },
        { inputActive: true, distraction: true, phone: false },
        { inputActive: true, distraction: false, phone: true },
      ]) {
        const clf = createPersonalClassifier(profile);
        for (let t = 0; t <= 10 * 60_000; t += 1_000) clf.observe(at(t, 8), hint);
        expect(clf.relativePose(at(0, 8).face ?? face())?.dyaw).toBeCloseTo(8, 6);
      }
      const clf = createPersonalClassifier(profile);
      clf.observe(at(0, 8), ACTIVE);
      clf.observe(at(3_600_000, 8), ACTIVE); // one hour later: dt is capped at 1 s
      expect(clf.relativePose(at(0, 8).face ?? face())?.dyaw ?? 0).toBeGreaterThan(7.9);
    });
  });
});
