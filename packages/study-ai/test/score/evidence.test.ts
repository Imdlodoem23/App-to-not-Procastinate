/** Detector evidence persistence (DESIGN.md §7.2). */
import { describe, expect, it } from 'vitest';
import { DetectorEvidence, phoneInHandOn, phoneInUseOn } from '../../src/score/evidence';
import type { FaceFeatures, FrameFeatures } from '../../src/types';

interface RunSpec {
  phone?: { score: number; nearFace?: boolean; moving?: boolean; stillMs?: number } | null;
  book?: number;
  person?: number;
  fresh?: boolean;
}

function run(t: number, spec: RunSpec = {}): FrameFeatures {
  const box = { cx: 0.5, cy: 0.5, w: 0.1, h: 0.1 };
  return {
    t,
    width: 320,
    height: 240,
    face: null,
    luma: null,
    quality: 1,
    objects: {
      ranAt: t,
      ageMs: 0,
      fresh: spec.fresh ?? true,
      phone: spec.phone
        ? {
            score: spec.phone.score,
            box,
            nearFace: spec.phone.nearFace ?? true,
            moving: spec.phone.moving ?? false,
            stillMs: spec.phone.stillMs ?? 0,
          }
        : null,
      book: spec.book === undefined ? null : { score: spec.book, box },
      person: spec.person === undefined ? null : { score: spec.person, box },
    },
  };
}

const TH = { phone: 0.5 };
const PHONE = { phone: { score: 0.8 } };

function feed(ev: DetectorEvidence, runs: readonly [number, RunSpec][]): void {
  for (const [t, spec] of runs) {
    ev.record(run(t, spec), TH);
    ev.update(t);
  }
}

describe('phone in hand on one run', () => {
  it('needs the threshold, near face or moving, and not lying still', () => {
    expect(phoneInHandOn(run(0, PHONE), 0.5)).toBe(true);
    expect(phoneInHandOn(run(0, { phone: { score: 0.49 } }), 0.5)).toBe(false);
    expect(phoneInHandOn(run(0, { phone: { score: 0.8, nearFace: false } }), 0.5)).toBe(false);
    expect(
      phoneInHandOn(run(0, { phone: { score: 0.8, nearFace: false, moving: true } }), 0.5),
    ).toBe(true);
    expect(phoneInHandOn(run(0, { phone: { score: 0.8, stillMs: 20_000 } }), 0.5)).toBe(false);
  });
});

describe('phone in use on one run', () => {
  const FACE: FaceFeatures = {
    pose: { yaw: 0, pitch: -5, roll: 0 },
    box: { cx: 0.5, cy: 0.4, w: 0.22, h: 0.3 },
    truncated: 0,
    blink: 0.1,
    lookDown: 0.1,
    lookUp: 0.05,
    gazeX: 0,
    jawOpen: 0.02,
    jitter: 0.005,
    faces: 1,
  };
  const withFace = (frame: FrameFeatures, box = { cx: 0.62, cy: 0.8, w: 0.07, h: 0.13 }) => {
    const phone = frame.objects?.phone;
    return {
      ...frame,
      face: FACE,
      objects: frame.objects && phone ? { ...frame.objects, phone: { ...phone, box } } : null,
    };
  };

  it('a still phone near a user looking at the screen is not in use (a timer on a stand)', () => {
    const still = withFace(run(0, PHONE));
    expect(phoneInHandOn(still, 0.5)).toBe(true);
    expect(phoneInUseOn(still, 0.5, false)).toBe(false);
  });

  it('in use when it moves, the user looks down, it is at the face, or the face is hidden', () => {
    expect(phoneInUseOn(withFace(run(0, PHONE)), 0.5, true)).toBe(true);
    expect(
      phoneInUseOn(withFace(run(0, { phone: { score: 0.8, moving: true } })), 0.5, false),
    ).toBe(true);
    const atEar = withFace(run(0, PHONE), { cx: 0.62, cy: 0.4, w: 0.06, h: 0.12 });
    expect(phoneInUseOn(atEar, 0.5, false)).toBe(true);
    expect(phoneInUseOn(run(0, PHONE), 0.5, false)).toBe(true); // face out of view
    const covered = { ...withFace(run(0, PHONE)), luma: { covered: true } } as FrameFeatures;
    expect(phoneInUseOn(covered, 0.5, false)).toBe(true);
  });

  it('never without the phone in hand', () => {
    const resting = withFace(run(0, { phone: { score: 0.8, stillMs: 20_000 } }));
    expect(phoneInUseOn(resting, 0.5, true)).toBe(false);
    expect(phoneInUseOn(withFace(run(0, { phone: { score: 0.4 } })), 0.5, true)).toBe(false);
  });

  it('E_phone stays off for a still phone while the user looks at the screen', () => {
    const ev = new DetectorEvidence();
    for (let t = 0; t < 10_000; t += 1_000) {
      ev.record(withFace(run(t, PHONE)), TH, false);
      ev.update(t);
    }
    expect(ev.phone).toBe(false);
    for (let t = 10_000; t < 13_000; t += 1_000) {
      ev.record(withFace(run(t, PHONE)), TH, true);
      ev.update(t);
    }
    expect(ev.phone).toBe(true);
  });
});

describe('E_phone', () => {
  it('turns on with 2 hits in ≥ 40 % of the runs of the last max(5 s, 2 runs)', () => {
    const ev = new DetectorEvidence();
    feed(ev, [[0, PHONE]]);
    expect(ev.phone).toBe(false); // a single run is not enough
    feed(ev, [[1_000, PHONE]]);
    expect(ev.phone).toBe(true);
  });

  it('does not turn on at 1 of 5 runs, nor at 2 of 6; turns on at 2 of 5', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, {}],
      [1_000, {}],
      [2_000, {}],
      [3_000, {}],
      [4_000, PHONE],
    ]);
    expect(ev.phone).toBe(false); // 1/5
    const six = new DetectorEvidence();
    feed(six, [
      [0, PHONE],
      [800, {}],
      [1_600, {}],
      [2_400, {}],
      [3_200, {}],
      [4_000, PHONE],
    ]);
    expect(six.phone).toBe(false); // 2/6 < 40 %
    feed(ev, [[5_000, PHONE]]);
    expect(ev.phone).toBe(true); // 2/5
  });

  it('once on, holds through detector misses for 8 s', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [4_000, PHONE],
      [5_000, PHONE],
    ]);
    expect(ev.phone).toBe(true);
    for (const t of [6_000, 7_000, 8_000, 9_000, 10_000, 11_000, 12_000]) {
      feed(ev, [[t, {}]]);
      expect(ev.phone, `${t}`).toBe(true); // the 5 s hit is still in the last 8 s
    }
    feed(ev, [[13_000, {}]]);
    expect(ev.phone).toBe(false); // eight misses in a row
  });

  it('ignores held (non-fresh) values and repeated runs', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, PHONE],
      [100, { ...PHONE, fresh: false }],
      [200, { ...PHONE, fresh: false }],
    ]);
    expect(ev.phone).toBe(false);
    ev.record(run(0, PHONE), TH);
    ev.update(300);
    expect(ev.phone).toBe(false);
  });

  it('keeps the last runs at slow detector rates and forgets them after 12 s', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, PHONE],
      [4_000, PHONE],
    ]);
    expect(ev.phone).toBe(true);
    feed(ev, [[8_000, {}]]);
    ev.update(11_900);
    expect(ev.phone).toBe(true); // 4 s hit among the last 4 runs
    ev.update(16_001);
    expect(ev.phone).toBe(false); // only the 8 s miss is left
  });

  it('reset forgets everything', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, PHONE],
      [1_000, PHONE],
    ]);
    ev.reset();
    ev.update(1_000);
    expect(ev.phone).toBe(false);
  });
});

describe('E_book and person', () => {
  it('book needs ≥ 50 % of the runs of the last 6 s at score ≥ 0.35', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, { book: 0.5 }],
      [1_000, {}],
      [2_000, { book: 0.3 }],
    ]);
    expect(ev.book(2_000)).toBe(false);
    feed(ev, [[3_000, { book: 0.36 }]]);
    expect(ev.book(3_000)).toBe(true);
  });

  it('a person in any of the last 3 runs', () => {
    const ev = new DetectorEvidence();
    feed(ev, [
      [0, { person: 0.9 }],
      [1_000, {}],
      [2_000, {}],
    ]);
    expect(ev.personSeen(0.5)).toBe(true);
    expect(ev.personSeen(0.95)).toBe(false);
    feed(ev, [[3_000, {}]]);
    expect(ev.personSeen(0.5)).toBe(false);
  });
});
