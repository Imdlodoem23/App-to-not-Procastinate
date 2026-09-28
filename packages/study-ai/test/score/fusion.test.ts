/** Fusion rules of DESIGN.md §7.3, one at a time. */
import { describe, expect, it } from 'vitest';
import { STUDY_AI_CONSTANTS } from '../../src/config';
import { fuse, hiddenValue, studyFloor, type FusionInput } from '../../src/score/fusion';
import type { ObservationEvidence } from '../../src/types';
import { NO_EVIDENCE, probs } from '../state/harness';

const C = STUDY_AI_CONSTANTS;
const DISTRACTION_KEEP = 0.1;

function input(over: Partial<FusionInput> & { ev?: Partial<ObservationEvidence> } = {}) {
  const { ev, ...rest } = over;
  return {
    presence: 'visible' as const,
    p: probs({ screen: 1 }),
    trust: { phone: 0, away: 0 },
    evidence: { ...NO_EVIDENCE, ...ev },
    hidden: null,
    threshold: 50,
    eyesClosed: false,
    ...rest,
  } satisfies FusionInput;
}

describe('study floor', () => {
  it('stays at least θ + hysteresis above the threshold for every sensitivity', () => {
    for (let theta = 30; theta <= 80; theta += 1) {
      const floor = studyFloor(theta) * 100;
      expect(floor).toBeGreaterThanOrEqual(theta + C.hysteresis);
      expect(floor).toBeLessThanOrEqual(95);
    }
    expect(studyFloor(50)).toBeCloseTo(0.7);
    expect(studyFloor(80)).toBeCloseTo(0.95);
  });
});

describe('base value (visible)', () => {
  it('is p.screen + p.paper without trust', () => {
    expect(fuse(input({ p: probs({ screen: 0.3, paper: 0.4, away: 0.3 }) })).study).toBeCloseTo(
      0.7,
    );
  });

  it('adds π.away·p.away and π.phone·p.phone (the latter only without E_phone)', () => {
    const p = probs({ screen: 0.2, phone: 0.4, away: 0.4 });
    const trust = { phone: 0.5, away: 0.25 };
    expect(fuse(input({ p, trust })).study).toBeCloseTo(0.2 + 0.1 + 0.2);
    // With E_phone the phone share is not trusted and the phone cap applies.
    expect(fuse(input({ p, trust, ev: { phone: true } })).study).toBeCloseTo(0.1);
  });

  it('a distraction app discounts only the «looking at the screen» share', () => {
    const screen = fuse(input({ p: probs({ screen: 1 }), ev: { distractionApp: true } }));
    expect(screen.study).toBeCloseTo(DISTRACTION_KEEP);
    expect(screen.cause).toBe('distraction_app');
    const paper = fuse(input({ p: probs({ paper: 1 }), ev: { distractionApp: true } }));
    expect(paper.study).toBeCloseTo(1);
    expect(paper.cause).toBeNull();
  });

  it('uses a neutral value when a visible frame has no answer', () => {
    expect(fuse(input({ p: null })).study).toBeCloseTo(0.55);
  });
});

describe('rules in order', () => {
  it('1. looking down or a book raise the value to the floor', () => {
    const away = probs({ away: 1 });
    expect(fuse(input({ p: away, ev: { lookingDown: true } })).study).toBeCloseTo(0.7);
    expect(fuse(input({ p: away, ev: { book: true } })).study).toBeCloseTo(0.7);
    expect(fuse(input({ p: away, threshold: 80, ev: { book: true } })).study).toBeCloseTo(0.95);
    // Never lowers a higher value.
    expect(fuse(input({ p: probs({ screen: 0.9, away: 0.1 }), ev: { book: true } })).study).toBe(
      0.9,
    );
  });

  it('2. keyboard and mouse add a weak +0.10 (capped at 1), not with a distraction or phone', () => {
    const p = probs({ screen: 0.3, away: 0.7 });
    expect(fuse(input({ p, ev: { inputActive: true } })).study).toBeCloseTo(0.4);
    expect(fuse(input({ p: probs({ screen: 0.95 }), ev: { inputActive: true } })).study).toBe(1);
    expect(fuse(input({ p, ev: { inputActive: true, distractionApp: true } })).study).toBeCloseTo(
      0.03,
    );
    expect(fuse(input({ p, ev: { inputActive: true, phone: true } })).study).toBeCloseTo(0.1);
  });

  it('3. a phone in hand caps the value over every floor', () => {
    const all = { phone: true, book: true, lookingDown: true, inputActive: true };
    expect(fuse(input({ p: probs({ paper: 1 }), ev: all })).study).toBeCloseTo(C.phoneCap);
    const hidden = fuse(
      input({
        presence: 'hidden',
        p: null,
        hidden: { value: studyFloor(50), turned: false },
        ev: { phone: true },
      }),
    );
    expect(hidden.study).toBeCloseTo(C.phoneCap);
    expect(hidden.cause).toBe('phone');
  });

  it('4. closed eyes keep the frame out of the window, unless a phone or distraction', () => {
    expect(fuse(input({ eyesClosed: true })).study).toBeNull();
    expect(fuse(input({ eyesClosed: true, ev: { phone: true } })).study).toBeCloseTo(0.1);
    expect(fuse(input({ eyesClosed: true, ev: { distractionApp: true } })).study).toBeCloseTo(0.1);
  });

  it('pushes nothing without someone in view', () => {
    for (const presence of ['absent', 'covered', 'camera_lost', 'no_camera'] as const) {
      expect(fuse(input({ presence, ev: { inputActive: true, book: true } }))).toEqual({
        study: null,
        cause: null,
      });
    }
  });
});

describe('hidden face', () => {
  it('takes the larger of the model share and the last-pose rule', () => {
    const p = probs({ screen: 0.1, paper: 0.1, away: 0.8 });
    expect(
      fuse(input({ presence: 'hidden', p, hidden: { value: 0.7, turned: false } })).study,
    ).toBeCloseTo(0.7);
    expect(
      fuse(input({ presence: 'hidden', p, hidden: { value: 0.1, turned: false } })).study,
    ).toBeCloseTo(0.2);
    const turned = fuse(input({ presence: 'hidden', p, hidden: { value: 0.2, turned: true } }));
    expect(turned.study).toBeCloseTo(0.2);
    expect(turned.cause).toBe('looking_away');
  });

  it('last-pose values: down → floor for 10 min, turned → 0.2, unknown → θ+5 for 20 s', () => {
    expect(hiddenValue('down', 0, 50)).toBeCloseTo(0.7);
    expect(hiddenValue('down', 600_000, 50)).toBeCloseTo(0.7);
    expect(hiddenValue('down', 600_001, 50)).toBeCloseTo(0.2);
    expect(hiddenValue('turned', 0, 50)).toBeCloseTo(0.2);
    expect(hiddenValue('unknown', 20_000, 60)).toBeCloseTo(0.65);
    expect(hiddenValue('unknown', 20_001, 60)).toBeCloseTo(0.2);
  });
});

describe('cause (only under θ)', () => {
  it('follows phone → distraction app → looking away → unknown', () => {
    const away = probs({ away: 0.9, screen: 0.1 });
    expect(fuse(input({ p: away })).cause).toBe('looking_away');
    expect(fuse(input({ p: away, ev: { distractionApp: true } })).cause).toBe('distraction_app');
    expect(fuse(input({ p: away, ev: { distractionApp: true, phone: true } })).cause).toBe('phone');
    expect(
      fuse(input({ p: probs({ screen: 0.3, paper: 0.1, phone: 0.35, away: 0.25 }) })).cause,
    ).toBe('unknown');
    expect(fuse(input({ p: probs({ screen: 0.8 }) })).cause).toBeNull();
  });

  it('clamps non-finite probabilities', () => {
    const r = fuse(input({ p: probs({ screen: Number.NaN, paper: Number.POSITIVE_INFINITY }) }));
    expect(r.study).not.toBeNull();
    expect(Number.isFinite(r.study as number)).toBe(true);
  });
});
