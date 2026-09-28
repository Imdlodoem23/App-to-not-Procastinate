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
    faceYaw: 0,
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
  it('1. looking down or a book the head could be reading raise the value to the floor', () => {
    const away = probs({ away: 1 });
    const unsure = probs({ screen: 0.3, paper: 0.1, away: 0.25, phone: 0.35 });
    expect(fuse(input({ p: away, ev: { lookingDown: true } })).study).toBeCloseTo(0.7);
    expect(fuse(input({ p: away, faceYaw: 60, ev: { lookingDown: true } })).study).toBeCloseTo(0.7);
    expect(fuse(input({ p: unsure, ev: { book: true } })).study).toBeCloseTo(0.7);
    expect(fuse(input({ p: unsure, threshold: 80, ev: { book: true } })).study).toBeCloseTo(0.95);
    // Never lowers a higher value.
    expect(fuse(input({ p: probs({ screen: 0.9, away: 0.1 }), ev: { book: true } })).study).toBe(
      0.9,
    );
  });

  it('1b. a book is a bounded bonus when the head cannot be reading it', () => {
    const away = probs({ away: 0.9, screen: 0.1 });
    // Model says away (TV to the side with a textbook on the desk): +0.10, still low.
    const tv = fuse(input({ p: away, ev: { book: true } }));
    expect(tv.study).toBeCloseTo(0.2);
    expect(tv.cause).toBe('looking_away');
    // Turned ≥ 35° from the screen: no floor even if the model is unsure.
    const unsure = probs({ screen: 0.3, paper: 0.1, away: 0.25, phone: 0.35 });
    expect(fuse(input({ p: unsure, faceYaw: 35, ev: { book: true } })).study).toBeCloseTo(0.5);
    expect(fuse(input({ p: unsure, faceYaw: -50, ev: { book: true } })).study).toBeCloseTo(0.5);
    expect(fuse(input({ p: unsure, faceYaw: 34.9, ev: { book: true } })).study).toBeCloseTo(0.7);
    // No yaw known on a visible frame: only the bonus.
    expect(fuse(input({ p: unsure, faceYaw: null, ev: { book: true } })).study).toBeCloseTo(0.5);
    // Capped at 1, and not with a phone in hand.
    expect(fuse(input({ p: probs({ screen: 0.95 }), faceYaw: 50, ev: { book: true } })).study).toBe(
      1,
    );
    expect(fuse(input({ p: away, ev: { book: true, phone: true } })).study).toBeCloseTo(0.1);
  });

  it('1c. hidden: a book lifts only a head lost while looking down', () => {
    const p = probs({ screen: 0.1, paper: 0.1, away: 0.8 });
    const hidden = (pose: 'down' | 'turned' | 'unknown', value: number) =>
      input({ presence: 'hidden', p, faceYaw: null, hidden: { value, pose }, ev: { book: true } });
    expect(fuse(hidden('down', 0.7)).study).toBeCloseTo(0.7);
    expect(fuse(hidden('turned', 0.2)).study).toBeCloseTo(0.3);
    expect(fuse(hidden('unknown', 0.55)).study).toBeCloseTo(0.65);
  });

  it('1d. a book up to 60° to the side lifts a face looking down at it', () => {
    const away = probs({ away: 0.84, screen: 0.16 }); // generic at 45°
    const side = (faceYaw: number, facingDown: boolean) =>
      fuse(input({ p: away, faceYaw, facingDown, ev: { book: true } })).study;
    expect(side(45, true)).toBeCloseTo(0.7);
    expect(side(-59, true)).toBeCloseTo(0.7);
    expect(side(60, true)).toBeCloseTo(0.26); // past 60°: the bonus only
    expect(side(45, false)).toBeCloseTo(0.26); // level head and eyes (TV to the side)
    // Never over a phone in hand.
    expect(
      fuse(input({ p: away, faceYaw: 45, facingDown: true, ev: { book: true, phone: true } }))
        .study,
    ).toBeCloseTo(0.1);
  });

  it('1e. hidden: a book held up in front of the face gets the floor', () => {
    const p = probs({ screen: 0.1, paper: 0.1, away: 0.8 });
    const book = fuse(
      input({
        presence: 'hidden',
        p,
        faceYaw: null,
        hidden: { value: studyFloor(50), pose: 'book' },
        ev: { book: true },
      }),
    );
    expect(book.study).toBeCloseTo(0.7);
    expect(book.cause).toBeNull();
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
        hidden: { value: studyFloor(50), pose: 'down' },
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
      fuse(input({ presence: 'hidden', p, hidden: { value: 0.7, pose: 'down' } })).study,
    ).toBeCloseTo(0.7);
    expect(
      fuse(input({ presence: 'hidden', p, hidden: { value: 0.1, pose: 'unknown' } })).study,
    ).toBeCloseTo(0.2);
    const turned = fuse(input({ presence: 'hidden', p, hidden: { value: 0.2, pose: 'turned' } }));
    expect(turned.study).toBeCloseTo(0.2);
    expect(turned.cause).toBe('looking_away');
  });

  it('last-pose values: down → floor for 10 min, turned → 0.2, unknown → θ+5 for 20 s', () => {
    expect(hiddenValue('down', 0, 50)).toBeCloseTo(0.7);
    expect(hiddenValue('down', 600_000, 50)).toBeCloseTo(0.7);
    expect(hiddenValue('book', 600_000, 60)).toBeCloseTo(0.8);
    expect(hiddenValue('book', 600_001, 60)).toBeNull();
    expect(hiddenValue('turned', 0, 50)).toBeCloseTo(0.2);
    expect(hiddenValue('turned', 3_600_000, 50)).toBeCloseTo(0.2);
    expect(hiddenValue('unknown', 20_000, 60)).toBeCloseTo(0.65);
  });

  it('past the allowance a hidden stretch is not observable (null), not «not studying»', () => {
    expect(hiddenValue('down', 600_001, 50)).toBeNull();
    expect(hiddenValue('unknown', 20_001, 60)).toBeNull();
    // Low light with recent input: the unknown pose keeps its neutral value.
    expect(hiddenValue('unknown', 3_600_000, 60, true)).toBeCloseTo(0.65);
    expect(hiddenValue('down', 600_001, 50, true)).toBeNull();
  });

  it('a distraction discounts the unknown-pose value like p.screen, not head down', () => {
    const p = probs({ away: 1 });
    const ev = { distractionApp: true };
    const unknown = fuse(
      input({ presence: 'hidden', p, faceYaw: null, hidden: { value: 0.55, pose: 'unknown' }, ev }),
    );
    expect(unknown.study).toBeCloseTo(0.055);
    expect(unknown.cause).toBe('distraction_app');
    const down = fuse(
      input({ presence: 'hidden', p, faceYaw: null, hidden: { value: 0.7, pose: 'down' }, ev }),
    );
    expect(down.study).toBeCloseTo(0.7);
    const model = fuse(
      input({ presence: 'hidden', p: probs({ screen: 0.8, paper: 0.1 }), hidden: null, ev }),
    );
    expect(model.study).toBeCloseTo(0.18);
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
