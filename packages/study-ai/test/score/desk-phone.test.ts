/** «¡Estaba estudiando!» for a phone lying on the desk: spots and the observer's mask. */
import { describe, expect, it } from 'vitest';
import { resolveStudyAiSettings } from '../../src/config';
import { CameraObserver } from '../../src/score/camera-observer';
import {
  atSpot,
  isDeskPhoneLearner,
  stayedPut,
  withoutDeskPhone,
  type DeskPhoneSpot,
} from '../../src/score/desk-phone';
import type { Box, FrameFeatures, Observation } from '../../src/types';
import { oracleClassifier } from '../state/harness';
import { frameAt } from './frames';

const W = 320;
const H = 240;
const SETTINGS = resolveStudyAiSettings();
/** A phone lying at the bottom right of the desk: 32 × 19 px. */
const DESK: Box = { cx: 0.8, cy: 0.9, w: 32 / W, h: 19 / H };
const SPOT: DeskPhoneSpot = { box: DESK, width: W, height: H };

/** `box` shifted by (dx, dy) pixels and grown by (dw, dh) pixels. */
function shifted(box: Box, dx: number, dy = 0, dw = 0, dh = 0): Box {
  return { cx: box.cx + dx / W, cy: box.cy + dy / H, w: box.w + dw / W, h: box.h + dh / H };
}

/** A frame with a detector run that saw a phone at `box` (flags as PERCEPTION set them). */
function phoneFrame(t: number, box: Box, flags: { moving?: boolean; nearFace?: boolean } = {}) {
  const frame = frameAt(t, {
    run: { person: 0.9, phone: { score: 0.6, moving: flags.moving ?? true, nearFace: false } },
  });
  const objects = frame.objects as NonNullable<FrameFeatures['objects']>;
  const phone = objects.phone as NonNullable<typeof objects.phone>;
  return {
    ...frame,
    objects: { ...objects, phone: { ...phone, box, nearFace: flags.nearFace ?? false } },
  };
}

function observe(obs: CameraObserver, frame: FrameFeatures): Observation {
  return obs.observe(
    {
      now: frame.t,
      phase: 'work',
      context: { foreground: 'study', idleMs: 60_000 },
      camera: 'ok',
      frame,
    },
    SETTINGS,
  );
}

describe('spots', () => {
  it('detector jitter stays at the spot; a moved or resized box does not', () => {
    expect(atSpot(DESK, SPOT)).toBe(true);
    expect(atSpot(shifted(DESK, 3, -3), SPOT)).toBe(true);
    expect(atSpot(shifted(DESK, 0, 0, 3, 3), SPOT)).toBe(true);
    expect(atSpot(shifted(DESK, 8, 0), SPOT)).toBe(false);
    expect(atSpot(shifted(DESK, 0, -40), SPOT)).toBe(false); // picked up
    expect(atSpot(shifted(DESK, 0, 0, 20, 12), SPOT)).toBe(false); // much bigger (in the hand)
    expect(atSpot({ ...DESK, cx: Number.NaN }, SPOT)).toBe(false);
  });

  it('stayed put: ≥ 3 sightings, ≥ 80 % of them at the median box', () => {
    const jitter = [0, 1, -1, 2, -2, 1, 0, -1, 1, 0].map((d, i) =>
      shifted(DESK, d, (i % 3) - 1, d / 2),
    );
    const spot = stayedPut(jitter, W, H);
    expect(spot).not.toBeNull();
    expect(atSpot(DESK, spot as DeskPhoneSpot)).toBe(true);
    expect(stayedPut(jitter.slice(0, 2), W, H)).toBeNull();
    // Two strays in ten still name the spot; a phone moving in the hand never does.
    const strays = [...jitter.slice(0, 8), shifted(DESK, 0, -60), shifted(DESK, -80, -50)];
    expect(stayedPut(strays, W, H)).not.toBeNull();
    const hand = Array.from({ length: 10 }, (_, i) => shifted(DESK, -60 + 7 * i, -70 + 4 * i));
    expect(stayedPut(hand, W, H)).toBeNull();
    expect(stayedPut(jitter, 0, H)).toBeNull();
  });

  it('removes the phone only at a spot', () => {
    const at = phoneFrame(0, shifted(DESK, 1, 1));
    expect(withoutDeskPhone(at, [SPOT]).objects?.phone).toBeNull();
    expect(withoutDeskPhone(at, [SPOT]).objects?.person).toEqual(at.objects?.person);
    const elsewhere = phoneFrame(0, shifted(DESK, -100, -80));
    expect(withoutDeskPhone(elsewhere, [SPOT])).toBe(elsewhere);
    expect(withoutDeskPhone(at, [])).toBe(at);
  });
});

describe('CameraObserver.vouchDeskPhone', () => {
  /** A desk phone misread as moving on every run: E_phone on after two runs. */
  function withDeskPhoneOn(): { obs: CameraObserver; t: number } {
    const obs = new CameraObserver({ classifier: oracleClassifier(), fallback: null });
    let t = 0;
    for (; t < 6_000; t += 1_000) observe(obs, phoneFrame(t, DESK));
    return { obs, t };
  }

  it('is duck-typed by the engine', () => {
    expect(isDeskPhoneLearner(withDeskPhoneOn().obs)).toBe(true);
    expect(isDeskPhoneLearner({})).toBe(false);
    expect(isDeskPhoneLearner(null)).toBe(false);
  });

  it('drops E_phone at once and ignores the phone while it stays at the spot', () => {
    const { obs, t } = withDeskPhoneOn();
    const before = observe(obs, phoneFrame(t, DESK));
    expect(before.evidence.phone).toBe(true);
    expect(before.cause).toBe('phone');
    obs.vouchDeskPhone({ ...SPOT, from: 0, to: t });
    let o: Observation | null = null;
    for (let k = t + 1_000; k < t + 120_000; k += 1_000) {
      o = observe(obs, phoneFrame(k, shifted(DESK, k % 3_000 === 0 ? 2 : -1, 1)));
      expect(o.evidence.phone).toBe(false);
    }
    expect(o?.frame?.objects?.phone).toBeNull(); // not in the feedback ring either
    expect(o?.study).toBeGreaterThan(0.5);
    expect(obs.deskPhoneSpots).toHaveLength(1);
  });

  it('a phone picked up leaves the spot and counts again', () => {
    const { obs, t } = withDeskPhoneOn();
    obs.vouchDeskPhone({ ...SPOT, from: 0, to: t });
    const hand: Box = { cx: 0.5, cy: 0.7, w: 0.12, h: 0.18 };
    let o: Observation | null = null;
    for (let k = t; k < t + 4_000; k += 1_000) {
      o = observe(
        obs,
        phoneFrame(k, shifted(hand, (k / 1_000) % 2 === 0 ? 8 : -8), { nearFace: true }),
      );
    }
    expect(o?.evidence.phone).toBe(true);
    expect(o?.cause).toBe('phone');
  });

  it('forgets the spot once the phone was not seen there for 60 s of observed time', () => {
    const { obs, t } = withDeskPhoneOn();
    obs.vouchDeskPhone({ ...SPOT, from: 0, to: t });
    // A break of 10 min (reset, camera off) does not count as time away from the spot.
    obs.reset();
    let k = t + 600_000;
    observe(obs, phoneFrame(k, DESK));
    expect(obs.deskPhoneSpots).toHaveLength(1);
    // Phone gone from the desk for 61 s: forgotten; put back there, it counts again.
    for (k += 1_000; k <= t + 600_000 + 61_000; k += 1_000) observe(obs, frameAt(k, { run: {} }));
    expect(obs.deskPhoneSpots).toHaveLength(0);
    let o: Observation | null = null;
    for (let j = 0; j < 3; j += 1, k += 1_000) o = observe(obs, phoneFrame(k, DESK));
    expect(o?.evidence.phone).toBe(true);
  });

  it('keeps at most two spots, the newest ones', () => {
    const { obs, t } = withDeskPhoneOn();
    obs.vouchDeskPhone({ ...SPOT, from: 0, to: t });
    obs.vouchDeskPhone({ ...SPOT, box: shifted(DESK, -150, 0), from: 0, to: t });
    obs.vouchDeskPhone({ ...SPOT, box: shifted(DESK, -250, 0), from: 0, to: t });
    expect(obs.deskPhoneSpots.map((s) => Math.round(s.box.cx * W))).toEqual([106, 6]);
  });

  it('rescore ignores the phone evidence of the vouched span only', () => {
    const { obs, t } = withDeskPhoneOn();
    const inSpan = observe(obs, phoneFrame(t, DESK));
    expect(inSpan.study).toBeLessThanOrEqual(0.1);
    obs.vouchDeskPhone({ ...SPOT, from: 0, to: t });
    expect(obs.rescore(inSpan, SETTINGS)).toBeGreaterThan(0.8);
    // An observation outside the span with a phone in hand elsewhere keeps its cap.
    const later: Observation = {
      ...inSpan,
      at: t + 30_000,
      frame: phoneFrame(t + 30_000, { cx: 0.5, cy: 0.7, w: 0.12, h: 0.18 }, { nearFace: true }),
    };
    expect(obs.rescore(later, SETTINGS)).toBeLessThanOrEqual(0.1);
  });
});
