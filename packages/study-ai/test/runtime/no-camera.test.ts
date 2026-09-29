import { describe, expect, it } from 'vitest';
import { resolveStudyAiSettings } from '../../src/config';
import { NoCameraObserver } from '../../src/runtime/no-camera';
import type { ForegroundClass, StudyPhase, TickInput } from '../../src/types';

const SETTINGS = resolveStudyAiSettings({ noCameraIdleMs: 480_000, focusScoreThreshold: 50 });
const L = 480_000;

function input(
  now: number,
  foreground: ForegroundClass,
  idleMs: number | null,
  phase: StudyPhase = 'work',
): TickInput {
  return { now, phase, context: { foreground, idleMs }, camera: 'off', frame: null };
}

describe('NoCameraObserver', () => {
  it('is always presence no_camera, weight 1, with no frame or eyes', () => {
    const o = new NoCameraObserver().observe(input(0, 'neutral', 1_000), SETTINGS);
    expect(o.presence).toBe('no_camera');
    expect(o.weight).toBe(1);
    expect(o.frame).toBeNull();
    expect(o.rel).toBeNull();
    expect(o.eyes).toEqual({ closed: false, yawn: false });
    expect(o.hints).toEqual([]);
    expect(o.evidence.phone).toBe(false);
  });

  it('gives s_base while active: 1.0 on a study app, 0.85 elsewhere', () => {
    const observer = new NoCameraObserver();
    expect(observer.observe(input(0, 'study', 2_000), SETTINGS).study).toBe(1);
    expect(observer.observe(input(1_000, 'neutral', 2_000), SETTINGS).study).toBe(0.85);
    expect(observer.observe(input(2_000, 'unknown', 2_000), SETTINGS).study).toBe(0.85);
    const o = observer.observe(input(3_000, 'neutral', L - 60_000), SETTINGS);
    expect(o.study).toBe(0.85);
    expect(o.cause).toBeNull();
  });

  it('ramps linearly to 0 over the last minute before L, then reads as idle', () => {
    const observer = new NoCameraObserver();
    const half = observer.observe(input(0, 'neutral', L - 30_000), SETTINGS);
    expect(half.study).toBeCloseTo(0.425, 6);
    expect(half.cause).toBe('idle'); // under θ = 0.5
    const early = observer.observe(input(1_000, 'neutral', L - 50_000), SETTINGS);
    expect(early.study).toBeCloseTo(0.85 * (50 / 60), 6);
    expect(early.cause).toBeNull();
    const idle = observer.observe(input(2_000, 'neutral', L), SETTINGS);
    expect(idle.study).toBe(0);
    expect(idle.cause).toBe('idle');
    expect(observer.observe(input(3_000, 'neutral', L * 3), SETTINGS).study).toBe(0);
  });

  it('allows 1.5 × L of stillness on a study app (reading a PDF)', () => {
    const observer = new NoCameraObserver();
    expect(observer.observe(input(0, 'study', L + 60_000), SETTINGS).study).toBe(1);
    expect(observer.observe(input(1_000, 'study', 1.5 * L - 30_000), SETTINGS).study).toBeCloseTo(
      0.5,
      6,
    );
    expect(observer.observe(input(2_000, 'study', 1.5 * L), SETTINGS).cause).toBe('idle');
  });

  it('treats unknown idle as a neutral 0.85', () => {
    const o = new NoCameraObserver().observe(input(0, 'study', null), SETTINGS);
    expect(o.study).toBe(0.85);
    expect(o.cause).toBeNull();
    expect(o.evidence.inputActive).toBe(false);
  });

  it('confirms a distraction after 5 s: 0.05 with cause distraction_app', () => {
    const observer = new NoCameraObserver();
    expect(observer.observe(input(0, 'distraction', 1_000), SETTINGS).study).toBe(0.85);
    expect(
      observer.observe(input(4_000, 'distraction', 1_000), SETTINGS).evidence.distractionApp,
    ).toBe(false);
    const o = observer.observe(input(5_000, 'distraction', 1_000), SETTINGS);
    expect(o.study).toBe(0.05);
    expect(o.cause).toBe('distraction_app');
    expect(o.evidence.distractionApp).toBe(true);
    // Leaving the distraction resets the confirmation.
    expect(observer.observe(input(6_000, 'study', 1_000), SETTINGS).study).toBe(1);
    expect(observer.observe(input(7_000, 'distraction', 1_000), SETTINGS).study).toBe(0.85);
  });

  it('marks keyboard/mouse activity under 15 s as input active', () => {
    const observer = new NoCameraObserver();
    expect(observer.observe(input(0, 'neutral', 14_999), SETTINGS).evidence.inputActive).toBe(true);
    expect(observer.observe(input(1_000, 'neutral', 15_000), SETTINGS).evidence.inputActive).toBe(
      false,
    );
  });

  it('follows the configured idle limit', () => {
    const short = resolveStudyAiSettings({ noCameraIdleMs: 180_000 });
    const o = new NoCameraObserver().observe(input(0, 'neutral', 180_000), short);
    expect(o.study).toBe(0);
  });

  it('rescore returns the stored value; reset forgets the distraction timer', () => {
    const observer = new NoCameraObserver();
    observer.observe(input(0, 'distraction', 1_000), SETTINGS);
    const o = observer.observe(input(5_000, 'distraction', 1_000), SETTINGS);
    expect(observer.rescore(o, SETTINGS)).toBe(0.05);
    observer.reset();
    expect(observer.observe(input(6_000, 'distraction', 1_000), SETTINGS).study).toBe(0.85);
  });
});
