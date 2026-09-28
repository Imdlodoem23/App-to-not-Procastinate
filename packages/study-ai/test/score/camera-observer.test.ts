/** CameraObserver: presence, evidence, fusion, eyes, stale profile (DESIGN.md §7.1–7.4). */
import { describe, expect, it } from 'vitest';
import { resolveStudyAiSettings } from '../../src/config';
import { CameraObserver } from '../../src/score/camera-observer';
import type {
  AttentionClassifier,
  CameraStatus,
  ContextSignals,
  FrameFeatures,
  Observation,
  StudyPhase,
} from '../../src/types';
import { oracleClassifier, probs } from '../state/harness';
import { faceOf, frameAt, type FrameOptions } from './frames';

const SETTINGS = resolveStudyAiSettings();

interface Extra {
  camera?: CameraStatus;
  phase?: StudyPhase;
  context?: Partial<ContextSignals>;
  frame?: FrameFeatures | null;
}

function observeAt(
  observer: CameraObserver,
  t: number,
  frame: FrameOptions | null = {},
  extra: Extra = {},
  settings = SETTINGS,
): Observation {
  return observer.observe(
    {
      now: t,
      phase: extra.phase ?? 'work',
      context: { foreground: 'study', idleMs: 60_000, ...extra.context },
      camera: extra.camera ?? 'ok',
      frame: extra.frame !== undefined ? extra.frame : frame === null ? null : frameAt(t, frame),
    },
    settings,
  );
}

function observer(classifier: AttentionClassifier = oracleClassifier(), fallback = null) {
  return new CameraObserver({ classifier, fallback });
}

describe('presence (first match wins)', () => {
  it('camera not ok → camera_lost, whatever the frame', () => {
    for (const camera of ['stalled', 'error', 'starting', 'off'] as const) {
      const o = observeAt(observer(), 0, {}, { camera });
      expect(o.presence, camera).toBe('camera_lost');
      expect(o.study).toBeNull();
    }
  });

  it('covered lens → covered (even while typing), then face → visible', () => {
    const obs = observer();
    const covered = observeAt(
      obs,
      0,
      { face: null, luma: { covered: true } },
      { context: { idleMs: 0 } },
    );
    expect(covered.presence).toBe('covered');
    expect(covered.study).toBeNull();
    expect(covered.hints).toContain('camera_covered');
    expect(observeAt(obs, 300, {}).presence).toBe('visible');
  });

  it('a tracked face beats a «covered» luma (a dim, low-contrast room)', () => {
    const obs = observer();
    const dim = { luma: { covered: true, mean: 0.06, spatialStd: 0.02, lowLight: false } };
    const o = observeAt(obs, 0, dim, { context: { idleMs: 0 } });
    expect(o.presence).toBe('visible');
    expect(o.study).toBeGreaterThan(0.5);
    expect(o.hints).not.toContain('camera_covered');
    // Without a face the same thumbnail still means a covered lens.
    expect(observeAt(obs, 300, { ...dim, face: null }).presence).toBe('covered');
  });

  it('no face but a person in the last 3 runs → hidden, then absent', () => {
    const obs = observer();
    observeAt(obs, 0, { run: { person: 0.9 } });
    expect(observeAt(obs, 1_000, { face: null, run: {} }).presence).toBe('hidden');
    expect(observeAt(obs, 2_000, { face: null, run: {} }).presence).toBe('hidden');
    expect(observeAt(obs, 3_000, { face: null, run: {} }).presence).toBe('absent');
  });

  it('a person under the learned threshold is not someone (a coat on the chair)', () => {
    const obs = observer(oracleClassifier({ thresholds: { person: 0.7 } }));
    observeAt(obs, 0, { face: null, run: { person: 0.6 } });
    expect(observeAt(obs, 300, { face: null }).presence).toBe('absent');
  });

  it('motion near the face counts only if the face was seen ≤ 10 s ago', () => {
    const obs = observer();
    observeAt(obs, 0, {});
    expect(observeAt(obs, 9_000, { face: null, luma: { motionNearFace: 0.03 } }).presence).toBe(
      'hidden',
    );
    expect(observeAt(obs, 10_001, { face: null, luma: { motionNearFace: 0.03 } }).presence).toBe(
      'absent',
    );
  });

  it('a null frame with the camera ok keeps the previous presence and pushes nothing', () => {
    const obs = observer();
    observeAt(obs, 0, { face: null });
    const o = observeAt(obs, 300, null);
    expect(o.presence).toBe('absent');
    expect(o.study).toBeNull();
    expect(o.frame).toBeNull();
    observeAt(obs, 600, {});
    expect(observeAt(obs, 900, null).presence).toBe('visible');
  });
});

describe('context evidence', () => {
  it('a distraction app counts after 5 s in the foreground, continuously', () => {
    const obs = observer();
    const dist = { context: { foreground: 'distraction' as const } };
    expect(observeAt(obs, 0, {}, dist).evidence.distractionApp).toBe(false);
    expect(observeAt(obs, 4_999, {}, dist).evidence.distractionApp).toBe(false);
    const on = observeAt(obs, 5_000, {}, dist);
    expect(on.evidence.distractionApp).toBe(true);
    expect(on.study).toBeCloseTo(0.1 * 0.9 + 0.05); // screen discounted, paper kept
    expect(on.cause).toBe('distraction_app');
    observeAt(obs, 5_300, {});
    expect(observeAt(obs, 5_600, {}, dist).evidence.distractionApp).toBe(false);
  });

  it('input is active under 15 s of idle; unknown idle is inactive', () => {
    const obs = observer();
    expect(observeAt(obs, 0, {}, { context: { idleMs: 14_999 } }).evidence.inputActive).toBe(true);
    expect(observeAt(obs, 300, {}, { context: { idleMs: 15_000 } }).evidence.inputActive).toBe(
      false,
    );
    expect(observeAt(obs, 600, {}, { context: { idleMs: null } }).evidence.inputActive).toBe(false);
  });
});

describe('looking down', () => {
  it('relative pitch ≤ −12° or eyes down, and not turned', () => {
    const obs = observer(); // baseline pitch −5
    expect(observeAt(obs, 0, { face: faceOf({ pitch: -17 }) }).evidence.lookingDown).toBe(true);
    expect(observeAt(obs, 300, { face: faceOf({ pitch: -16 }) }).evidence.lookingDown).toBe(false);
    expect(observeAt(obs, 600, { face: faceOf({ lookDown: 0.45 }) }).evidence.lookingDown).toBe(
      true,
    );
    expect(
      observeAt(obs, 900, { face: faceOf({ pitch: -40, yaw: 36 }) }).evidence.lookingDown,
    ).toBe(false);
  });

  it('gets the study floor even when the model says away', () => {
    const away = oracleClassifier({ predict: () => probs({ away: 1 }) });
    const o = observeAt(observer(away), 0, { face: faceOf({ pitch: -40 }) });
    expect(o.study).toBeCloseTo(0.7);
    expect(o.cause).toBeNull();
  });

  it('uses absolute pitch ≤ −20° before a baseline exists', () => {
    const noBaseline: AttentionClassifier = {
      ...oracleClassifier(),
      ready: false,
      relativePose: () => null,
    };
    const obs = observer(noBaseline);
    expect(observeAt(obs, 0, { face: faceOf({ pitch: -20 }) }).evidence.lookingDown).toBe(true);
    expect(observeAt(obs, 300, { face: faceOf({ pitch: -19 }) }).evidence.lookingDown).toBe(false);
  });
});

describe('phone and book', () => {
  it('a phone in hand in the recent runs caps the value, over looking down and a book', () => {
    const obs = observer();
    const phone = { score: 0.8 };
    observeAt(obs, 0, { face: faceOf({ pitch: -35 }), run: { phone, book: 0.8 } });
    const o = observeAt(obs, 1_000, { face: faceOf({ pitch: -35 }), run: { phone, book: 0.8 } });
    expect(o.evidence.phone).toBe(true);
    expect(o.evidence.book).toBe(true);
    expect(o.study).toBeLessThanOrEqual(0.1); // the model says phone; no floor applies
    expect(o.cause).toBe('phone');
  });

  it('a phone lying still on the desk is not a phone in hand', () => {
    const obs = observer();
    const phone = { score: 0.9, nearFace: false, moving: false, stillMs: 25_000 };
    observeAt(obs, 0, { run: { phone } });
    expect(observeAt(obs, 1_000, { run: { phone } }).evidence.phone).toBe(false);
  });

  it('a book lying in view does not lift a head turned away (TV to the side)', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ yaw: 50 }), run: { book: 0.6 } });
    const o = observeAt(obs, 1_000, { face: faceOf({ yaw: 50 }), run: { book: 0.6 } });
    expect(o.evidence.book).toBe(true);
    expect(o.study).toBeCloseTo(0.1 + 0.1); // the oracle's screen + paper, plus the bonus
    expect(o.cause).toBe('looking_away');
  });

  it('a book lifts a head that could be reading it', () => {
    const unsure = oracleClassifier({
      predict: () => probs({ screen: 0.3, paper: 0.1, phone: 0.35, away: 0.25 }),
    });
    const obs = observer(unsure);
    observeAt(obs, 0, { face: faceOf({ yaw: 20, pitch: 0 }), run: { book: 0.6 } });
    const o = observeAt(obs, 1_000, { face: faceOf({ yaw: 20, pitch: 0 }), run: { book: 0.6 } });
    expect(o.evidence.lookingDown).toBe(false);
    expect(o.study).toBeCloseTo(0.7);
    // Rescoring keeps the rule (the yaw comes from the stored relative pose).
    expect(obs.rescore(o, SETTINGS)).toBeCloseTo(0.7);
  });
});

describe('hidden face: last-pose rule', () => {
  it('head down before losing the face → floor (writing)', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    const o = observeAt(obs, 1_500, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('hidden');
    expect(o.study).toBeCloseTo(0.7);
  });

  it('turned before losing it → 0.2 and looking away', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ yaw: 40 }), run: { person: 0.9 } });
    const o = observeAt(obs, 300, { face: null, run: { person: 0.9 } });
    expect(o.study).toBeCloseTo(0.2);
    expect(o.cause).toBe('looking_away');
  });

  it('unknown → θ+5 for 20 s, then not observable (absent); «cannot see you» after 5 s', () => {
    const obs = observer();
    observeAt(obs, 0, { run: { person: 0.9 } });
    let o = observeAt(obs, 2_500, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('hidden');
    expect(o.study).toBeCloseTo(0.55);
    expect(o.hints).not.toContain('camera_cant_see_you');
    o = observeAt(obs, 7_500, { face: null, run: { person: 0.9 } });
    expect(o.hints).toContain('camera_cant_see_you');
    o = observeAt(obs, 22_500, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('hidden');
    expect(o.study).toBeCloseTo(0.55);
    o = observeAt(obs, 22_600, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('absent');
    expect(o.study).toBeNull();
    expect(o.cause).toBeNull();
    expect(o.hints).toContain('camera_cant_see_you');
    // A null frame keeps it; the face back ends it.
    expect(observeAt(obs, 22_900, null).presence).toBe('absent');
    o = observeAt(obs, 23_200, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('absent');
    expect(observeAt(obs, 23_500, { run: { person: 0.9 } }).presence).toBe('visible');
    expect(observeAt(obs, 23_800, { face: null, run: { person: 0.9 } }).study).toBeCloseTo(0.55);
  });

  it('a face that slid out of the frame edge raises «cannot see you» at once', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ truncated: 0.4 }), run: { person: 0.9 } });
    const o = observeAt(obs, 300, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('hidden');
    expect(o.hints).toContain('camera_cant_see_you');
  });

  it('turned away stays observable: 0.2 for as long as it lasts', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ yaw: 40 }), run: { person: 0.9 } });
    let o: Observation | null = null;
    for (let t = 1_000; t <= 120_000; t += 1_000) {
      o = observeAt(obs, t, { face: null, run: { person: 0.9 } });
    }
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.2);
    expect(o?.cause).toBe('looking_away');
  });

  it('a phone or a distraction keeps an unseen stretch observable (their rules apply)', () => {
    const phone = observer();
    observeAt(phone, 0, { run: { person: 0.9 } });
    let o: Observation | null = null;
    for (let t = 1_000; t <= 30_000; t += 1_000) {
      o = observeAt(phone, t, {
        face: null,
        run: { person: 0.9, phone: { score: 0.8, moving: true } },
      });
    }
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.1);
    expect(o?.cause).toBe('phone');

    const dist = observer();
    const ctx = { context: { foreground: 'distraction' as const } };
    observeAt(dist, 0, { run: { person: 0.9 } }, ctx);
    for (let t = 1_000; t <= 30_000; t += 1_000) {
      o = observeAt(dist, t, { face: null, run: { person: 0.9 } }, ctx);
    }
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.1 * 0.1 + 0.1); // p.screen discounted, p.paper kept
    expect(o?.cause).toBe('distraction_app');
  });

  it('low light with recent input holds the neutral value (judged like no-camera)', () => {
    const obs = observer();
    const dark = { face: null, run: { person: 0.9 }, luma: { lowLight: true, mean: 0.12 } };
    observeAt(obs, 0, { run: { person: 0.9 } });
    let o: Observation | null = null;
    for (let t = 1_000; t <= 120_000; t += 1_000) {
      o = observeAt(obs, t, dark, { context: { idleMs: 20_000 } });
    }
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.55);
    expect(o?.hints).toContain('low_light');
    expect(o?.hints).toContain('camera_cant_see_you');
    // Idle past the no-camera limit: not observable any more.
    o = observeAt(obs, 121_000, dark, { context: { idleMs: SETTINGS.noCameraIdleMs } });
    expect(o.presence).toBe('absent');
    // …and in normal light it never held.
    o = observeAt(obs, 122_000, { face: null, run: { person: 0.9 } }, { context: { idleMs: 0 } });
    expect(o.presence).toBe('absent');
  });

  it('head down but hidden for more than 10 min → not observable', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    let t = 300;
    let o: Observation | null = null;
    for (; t <= 600_300; t += 1_000) o = observeAt(obs, t, { face: null, run: { person: 0.9 } });
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.7);
    expect(o?.hints).toContain('camera_cant_see_you'); // hidden > 60 s
    o = observeAt(obs, t + 1_000, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('absent');
    expect(o.study).toBeNull();
  });

  it('rescore keeps the last-pose value of a hidden observation', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    const o = observeAt(obs, 300, { face: null, run: { person: 0.9 } });
    expect(obs.rescore(o, SETTINGS)).toBeCloseTo(0.7);
  });
});

describe('eyes', () => {
  it('closed when blink − fit(dpitch) > closedDelta, eyes not looking down, good frame', () => {
    const obs = observer();
    const closed = observeAt(obs, 0, { face: faceOf({ blink: 0.95 }) });
    expect(closed.eyes.closed).toBe(true);
    expect(closed.study).toBeNull(); // drowsy candidate: out of the window
    // Reading lowers the lids: the fit expects more blink when looking down.
    expect(observeAt(obs, 300, { face: faceOf({ blink: 0.7, pitch: -45 }) }).eyes.closed).toBe(
      false,
    );
    expect(observeAt(obs, 600, { face: faceOf({ blink: 0.95, lookDown: 0.6 }) }).eyes.closed).toBe(
      false,
    );
    expect(observeAt(obs, 900, { face: faceOf({ blink: 0.95 }), quality: 0.4 }).eyes.closed).toBe(
      false,
    );
  });

  it('never with unreliable eyes (glasses glare)', () => {
    const obs = observer(
      oracleClassifier({ eyes: { reliable: false, blinkFit: [0.15, -0.004], closedDelta: 0.45 } }),
    );
    expect(observeAt(obs, 0, { face: faceOf({ blink: 1 }) }).eyes.closed).toBe(false);
  });

  it('a yawn is jawOpen > 0.6 for ≥ 2 s', () => {
    const obs = observer();
    expect(observeAt(obs, 0, { face: faceOf({ jawOpen: 0.7 }) }).eyes.yawn).toBe(false);
    expect(observeAt(obs, 1_999, { face: faceOf({ jawOpen: 0.7 }) }).eyes.yawn).toBe(false);
    expect(observeAt(obs, 2_000, { face: faceOf({ jawOpen: 0.7 }) }).eyes.yawn).toBe(true);
    expect(observeAt(obs, 2_300, { face: faceOf({ jawOpen: 0.1 }) }).eyes.yawn).toBe(false);
  });
});

describe('classifier learning and the stale-profile check', () => {
  it('lets the classifier and the fallback learn only while working', () => {
    const personal = oracleClassifier();
    const fallback = oracleClassifier({ kind: 'generic' });
    const obs = new CameraObserver({ classifier: personal, fallback });
    observeAt(obs, 0, {});
    observeAt(obs, 300, {}, { phase: 'break' });
    expect(personal.observed).toBe(1);
    expect(fallback.observed).toBe(1);
  });

  it('switches to the fallback when ≥ 70 % of 60 typing frames look away', () => {
    const personal = oracleClassifier({ predict: () => probs({ away: 0.8, screen: 0.2 }) });
    const fallback = oracleClassifier({ kind: 'generic' });
    const obs = new CameraObserver({ classifier: personal, fallback });
    let o: Observation | null = null;
    for (let i = 0; i < 60; i += 1) {
      o = observeAt(obs, i * 300, {}, { context: { idleMs: 0 } });
    }
    expect(obs.classifier).toBe(fallback);
    expect(obs.staleProfile).toBe(true);
    expect(o?.hints).toContain('recalibrate');
    obs.reset();
    expect(observeAt(obs, 30_000, {}).hints).toContain('recalibrate'); // sticky
  });

  it('does not judge without input, and stops judging after 120 s', () => {
    const personal = oracleClassifier({ predict: () => probs({ away: 0.8, screen: 0.2 }) });
    const fallback = oracleClassifier({ kind: 'generic' });
    const idle = new CameraObserver({ classifier: personal, fallback });
    for (let i = 0; i < 100; i += 1) observeAt(idle, i * 300, {});
    expect(idle.classifier).toBe(personal);

    const late = new CameraObserver({ classifier: personal, fallback });
    for (let t = 0; t <= 121_000; t += 1_000) observeAt(late, t, { face: null });
    for (let i = 0; i < 80; i += 1)
      observeAt(late, 122_000 + i * 300, {}, { context: { idleMs: 0 } });
    expect(late.classifier).toBe(personal);
  });

  it('setClassifier swaps the classifier used by observe and rescore', () => {
    const obs = observer(oracleClassifier({ predict: () => probs({ away: 1 }) }));
    const o = observeAt(obs, 0, {});
    expect(o.study).toBeCloseTo(0);
    obs.setClassifier(oracleClassifier({ predict: () => probs({ screen: 1 }) }));
    expect(obs.rescore(o, SETTINGS)).toBeCloseTo(1);
    expect(obs.classifier.predict(frameAt(0))?.screen).toBe(1);
  });
});

describe('hints', () => {
  it('low light and a truncated face', () => {
    const obs = observer();
    expect(observeAt(obs, 0, { luma: { lowLight: true } }).hints).toContain('low_light');
    expect(observeAt(obs, 300, { face: faceOf({ truncated: 0.31 }) }).hints).toContain(
      'camera_cant_see_you',
    );
    expect(observeAt(obs, 600, {}).hints).toEqual([]);
  });

  it('observations carry only numbers (no image fields)', () => {
    const o = observeAt(observer(), 0, { run: { person: 0.9 } });
    const walk = (v: unknown): void => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')
        return;
      expect(typeof v).toBe('object');
      for (const x of Object.values(v as object)) walk(x);
    };
    walk(o);
  });
});
