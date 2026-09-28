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

  it('a person seen on an image the luma already called «covered» is a dim room', () => {
    const obs = observer();
    const dim = { covered: true, mean: 0.06, spatialStd: 0.02, lowLight: false };
    // Tracked face in the dim room; the detector sees the user on that same image.
    observeAt(obs, 0, { luma: { ...dim, at: 0 }, run: { person: 0.9 } });
    // Landmarker dropout: no face, the latest run (taken while «covered») saw a person.
    const drop = observeAt(obs, 300, { face: null, luma: { ...dim, at: 0 } });
    expect(drop.presence).toBe('hidden');
    expect(drop.hints).not.toContain('camera_covered');
    // Covering the lens: the next run sees no one → covered at once, whatever the earlier
    // runs with a person (the «last 3 runs» rule does not apply to a covered image).
    const lens = observeAt(obs, 1_000, { face: null, luma: { ...dim, at: 1_000 }, run: {} });
    expect(lens.presence).toBe('covered');
  });

  it('a person seen before the lens was covered does not count', () => {
    const obs = observer();
    observeAt(obs, 0, { run: { person: 0.9 } }); // normal light, detector run at 0
    const covered = { covered: true, mean: 0.03, spatialStd: 0.01, at: 300 };
    expect(observeAt(obs, 300, { face: null, luma: covered }).presence).toBe('covered');
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
    // Moderately down or eyes down only: the 35° gate.
    expect(
      observeAt(obs, 900, { face: faceOf({ pitch: -17, yaw: 36 }) }).evidence.lookingDown,
    ).toBe(false);
    expect(
      observeAt(obs, 1_200, { face: faceOf({ lookDown: 0.6, yaw: 36 }) }).evidence.lookingDown,
    ).toBe(false);
  });

  it('a head clearly down (≤ −20°) looks down up to 60° to the side (notebook next to it)', () => {
    const obs = observer(); // baseline pitch −5
    const at = (t: number, yaw: number, pitch: number) =>
      observeAt(obs, t, { face: faceOf({ yaw, pitch }) });
    expect(at(0, 40, -40).evidence.lookingDown).toBe(true);
    expect(at(300, -60, -25).evidence.lookingDown).toBe(true);
    expect(at(600, 61, -40).evidence.lookingDown).toBe(false);
    expect(at(900, 45, -24).evidence.lookingDown).toBe(false); // relative −19°
    // Writing at the side gets the floor even when the model calls it «away».
    const away = observer(oracleClassifier({ predict: () => probs({ away: 1 }) }));
    const o = observeAt(away, 0, { face: faceOf({ yaw: 45, pitch: -40 }) });
    expect(o.study).toBeCloseTo(0.7);
    expect(o.cause).toBeNull();
    // Without a baseline: absolute pitch ≤ −25° to the side.
    const noBaseline = observer({ ...oracleClassifier(), ready: false, relativePose: () => null });
    expect(
      observeAt(noBaseline, 0, { face: faceOf({ yaw: 45, pitch: -25 }) }).evidence.lookingDown,
    ).toBe(true);
    expect(
      observeAt(noBaseline, 300, { face: faceOf({ yaw: 45, pitch: -24 }) }).evidence.lookingDown,
    ).toBe(false);
  });

  it('a phone in hand still caps a head down at the side', () => {
    const obs = observer();
    const frame = { face: faceOf({ yaw: 45, pitch: -40 }), run: { phone: { score: 0.8 } } };
    observeAt(obs, 0, frame);
    const o = observeAt(obs, 1_000, frame);
    expect(o.evidence.phone).toBe(true);
    expect(o.study).toBeLessThanOrEqual(0.1);
    expect(o.cause).toBe('phone');
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

  it('writing at a notebook 40° to the side before losing the face → floor, not turned', () => {
    const obs = observer();
    observeAt(obs, 0, { face: faceOf({ yaw: 40, pitch: -40 }), run: { person: 0.9 } });
    const o = observeAt(obs, 300, { face: null, run: { person: 0.9 } });
    expect(o.presence).toBe('hidden');
    expect(o.study).toBeCloseTo(0.7);
    expect(o.cause).toBeNull();
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
    // Writing: the head moves where the face was.
    const writing = { face: null, run: { person: 0.9 }, luma: { motionNearFace: 0.03 } };
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    let t = 300;
    let o: Observation | null = null;
    for (; t <= 600_300; t += 1_000) o = observeAt(obs, t, writing);
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.7);
    expect(o?.hints).toContain('camera_cant_see_you'); // hidden > 60 s
    o = observeAt(obs, t + 1_000, writing);
    expect(o.presence).toBe('absent');
    expect(o.study).toBeNull();
  });

  it('head down, hidden and still for 90 s: asleep on the desk (drowsy candidate)', () => {
    const obs = observer();
    const still = { face: null, run: { person: 0.9 }, luma: { motionNearFace: 0.002 } };
    const ctx = { context: { idleMs: 200_000 } };
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } }, ctx);
    let o = observeAt(obs, 1_000, still, ctx); // the stretch starts here
    for (let t = 2_000; t < 91_000; t += 1_000) o = observeAt(obs, t, still, ctx);
    expect(o.study).toBeCloseTo(0.7);
    expect(o.eyes.closed).toBe(false);
    o = observeAt(obs, 91_000, still, ctx);
    expect(o.presence).toBe('hidden');
    expect(o.study).toBeNull(); // not pushed: the engine freezes the timers
    expect(o.eyes.closed).toBe(true);
    // A distraction in the foreground does not make a nap a strike.
    o = observeAt(obs, 91_500, still, { context: { idleMs: 200_000, foreground: 'distraction' } });
    expect(o.study).toBeNull();
    expect(o.eyes.closed).toBe(true);
    // Moving again (writing): the floor comes back at once.
    o = observeAt(obs, 92_000, { ...still, luma: { motionNearFace: 0.03 } }, ctx);
    expect(o.study).toBeCloseTo(0.7);
    expect(o.eyes.closed).toBe(false);
    // Asleep again 90 s later; after 20 min of hidden time the absence path takes over.
    for (let t = 93_000; t <= 1_201_000; t += 1_000) o = observeAt(obs, t, still, ctx);
    expect(o.presence).toBe('hidden');
    expect(o.eyes.closed).toBe(true);
    o = observeAt(obs, 1_202_000, still, ctx);
    expect(o.presence).toBe('absent');
  });

  it('keyboard or mouse keeps a hidden head down awake; a phone in hand is never a nap', () => {
    const obs = observer();
    const still = { face: null, run: { person: 0.9 }, luma: { motionNearFace: 0.002 } };
    observeAt(obs, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    let o: Observation | null = null;
    for (let t = 1_000; t <= 300_000; t += 1_000) {
      o = observeAt(obs, t, still, { context: { idleMs: 80_000 } }); // input 80 s ago
    }
    expect(o?.study).toBeCloseTo(0.7);
    expect(o?.eyes.closed).toBe(false);

    const phone = observer();
    const withPhone = { ...still, run: { person: 0.9, phone: { score: 0.8, moving: true } } };
    observeAt(phone, 0, { face: faceOf({ pitch: -40 }), run: { person: 0.9 } });
    for (let t = 1_000; t <= 120_000; t += 1_000) {
      o = observeAt(phone, t, withPhone, { context: { idleMs: 200_000 } });
    }
    expect(o?.eyes.closed).toBe(false);
    expect(o?.study).toBeCloseTo(0.1);
    expect(o?.cause).toBe('phone');
  });

  it('a book held up in front of the face keeps the floor (reading leaning back)', () => {
    const obs = observer();
    const raised = { cx: 0.5, cy: 0.45, w: 0.4, h: 0.35 }; // covers the last face box
    const hiddenBook = (book: number | undefined) => ({
      face: null,
      run: { person: 0.9, ...(book === undefined ? {} : { book }) },
      luma: { motionNearFace: 0.03 },
    });
    const frame = (t: number, book: number | undefined) => {
      const f = frameAt(t, hiddenBook(book));
      const objects = f.objects;
      return objects?.book
        ? { ...f, objects: { ...objects, book: { ...objects.book, box: raised } } }
        : f;
    };
    observeAt(obs, 0, { run: { person: 0.9 } }); // looking at the screen
    let o: Observation | null = null;
    for (let t = 1_000; t <= 300_000; t += 1_000) {
      o = observeAt(obs, t, {}, { frame: frame(t, 0.8) });
    }
    expect(o?.presence).toBe('hidden');
    expect(o?.study).toBeCloseTo(0.7);
    expect(o?.cause).toBeNull();
    expect(obs.rescore(o as Observation, SETTINGS)).toBeCloseTo(0.7);
    // Detector misses for a few seconds: the book pose holds.
    for (let t = 301_000; t <= 305_000; t += 1_000) {
      o = observeAt(obs, t, {}, { frame: frame(t, undefined) });
    }
    expect(o?.study).toBeCloseTo(0.7);
    // A distraction in the foreground turns the rule off (the unknown-pose rule applies).
    const dist = { context: { foreground: 'distraction' as const } };
    for (let t = 306_000; t <= 312_000; t += 1_000) {
      o = observeAt(obs, t, {}, { ...dist, frame: frame(t, 0.8) });
    }
    expect(o?.study).toBeLessThan(0.5);
    expect(o?.cause).toBe('distraction_app');
  });

  it('a book lying on the desk below the face does not count as held up', () => {
    const obs = observer();
    const desk = { cx: 0.5, cy: 0.9, w: 0.35, h: 0.2 };
    observeAt(obs, 0, { run: { person: 0.9 } });
    let o: Observation | null = null;
    for (let t = 1_000; t <= 30_000; t += 1_000) {
      const f = frameAt(t, { face: null, run: { person: 0.9, book: 0.8 } });
      const objects = f.objects;
      const withDesk = objects?.book
        ? { ...f, objects: { ...objects, book: { ...objects.book, box: desk } } }
        : f;
      o = observeAt(obs, t, {}, { frame: withDesk });
    }
    expect(o?.presence).toBe('absent'); // unknown pose past its 20 s: the absence path
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

  it('does not judge without input', () => {
    const personal = oracleClassifier({ predict: () => probs({ away: 0.8, screen: 0.2 }) });
    const fallback = oracleClassifier({ kind: 'generic' });
    const idle = new CameraObserver({ classifier: personal, fallback });
    for (let i = 0; i < 100; i += 1) observeAt(idle, i * 300, {});
    expect(idle.classifier).toBe(personal);
  });

  it('keeps judging all session (rolling): a profile that goes stale later still switches', () => {
    // Calibrated on the laptop; 10 min in, the user types on an external monitor the profile
    // calls «away» while the generic fallback, fed with the fresh input, calls it a screen.
    let external = false;
    const personal = oracleClassifier({
      predict: () => (external ? probs({ away: 0.8, screen: 0.2 }) : probs({ screen: 0.9 })),
    });
    const fallback = oracleClassifier({ kind: 'generic' });
    const obs = new CameraObserver({ classifier: personal, fallback });
    let t = 0;
    for (; t < 600_000; t += 300) observeAt(obs, t, {}, { context: { idleMs: 0 } });
    expect(obs.classifier).toBe(personal);
    external = true;
    const from = t;
    for (; obs.classifier === personal && t < from + 60_000; t += 300) {
      observeAt(obs, t, {}, { context: { idleMs: 0 } });
    }
    expect(obs.classifier).toBe(fallback);
    expect(obs.staleProfile).toBe(true);
    // The last 60 frames (18 s at this rate) had to be ≥ 70 % away: ~13 s after the change.
    expect(t - from).toBeLessThanOrEqual(15_000);
  });

  it('needs 60 frames within 120 s of work, and the fallback to call them study', () => {
    const away = () => probs({ away: 0.8, screen: 0.2 });
    // Sparse typing: 60 frames spread over more than 120 s never decide.
    const sparse = new CameraObserver({
      classifier: oracleClassifier({ predict: away }),
      fallback: oracleClassifier({ kind: 'generic' }),
    });
    for (let i = 0; i < 200; i += 1) {
      observeAt(sparse, i * 3_000, {}, { context: { idleMs: i % 3 === 0 ? 0 : 60_000 } });
    }
    expect(sparse.staleProfile).toBe(false);
    // Both models call it «away» (watching TV while wiggling the mouse): no switch.
    const both = new CameraObserver({
      classifier: oracleClassifier({ predict: away }),
      fallback: oracleClassifier({ kind: 'generic', predict: away }),
    });
    for (let i = 0; i < 200; i += 1) observeAt(both, i * 300, {}, { context: { idleMs: 0 } });
    expect(both.staleProfile).toBe(false);
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
