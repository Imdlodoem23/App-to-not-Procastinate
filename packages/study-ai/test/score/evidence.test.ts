/** Detector evidence persistence (DESIGN.md §7.2). */
import { describe, expect, it } from 'vitest';
import { DetectorEvidence, phoneInHandOn } from '../../src/score/evidence';
import type { FrameFeatures } from '../../src/types';

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
