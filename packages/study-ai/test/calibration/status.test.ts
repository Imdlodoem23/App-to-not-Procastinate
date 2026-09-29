/** The wizard checklist «Pendiente → Grabando 12 s → Hecho». */
import { describe, expect, it } from 'vitest';
import { issue } from '../../src/calibration/recorder';
import { calibrationSteps, nextPendingSituation } from '../../src/calibration/status';
import type { CalibrationProgress, SituationRecording } from '../../src/types';
import { profileFor } from './fixtures';

const progress = (over: Partial<CalibrationProgress>): CalibrationProgress => ({
  cls: 'screen',
  phase: 'recording',
  elapsedMs: 0,
  remainingMs: 20_000,
  frames: 0,
  faceRatio: 1,
  liveIssues: [],
  ...over,
});

const recording = (over: Partial<SituationRecording>): SituationRecording => ({
  cls: 'screen',
  startedAt: 0,
  durationMs: 20_000,
  rows: [],
  faceRatio: 1,
  personRatio: 1,
  issues: [],
  ...over,
});

describe('calibrationSteps', () => {
  it('starts with every situation pending, screen first', () => {
    const steps = calibrationSteps({ profile: null, recordings: {}, active: null });
    expect(steps.map((s) => [s.cls, s.state])).toEqual([
      ['screen', 'pending'],
      ['paper', 'pending'],
      ['phone', 'pending'],
      ['away', 'pending'],
      ['absent', 'pending'],
    ]);
    expect(nextPendingSituation(steps)).toBe('screen');
  });

  it('shows the recording one with whole seconds left (settling included)', () => {
    const steps = calibrationSteps({
      profile: null,
      recordings: {},
      active: progress({ cls: 'paper', remainingMs: 11_200 }),
    });
    expect(steps[1]).toEqual({ cls: 'paper', state: 'recording', remainingS: 12, issues: [] });
    const settling = calibrationSteps({
      profile: null,
      recordings: {},
      active: progress({ cls: 'paper', phase: 'settling', remainingMs: 19_000 }),
    });
    expect(settling[1]?.state).toBe('recording');
  });

  it('marks a clean recording done and one with an error pending with its issues', () => {
    const steps = calibrationSteps({
      profile: null,
      recordings: {
        screen: recording({ issues: [issue('unstable', 'screen')] }),
        paper: recording({ cls: 'paper', issues: [issue('no_face', 'paper')] }),
      },
      active: progress({ cls: 'paper', phase: 'done', remainingMs: 0 }),
    });
    expect(steps[0]?.state).toBe('done');
    expect(steps[1]).toMatchObject({ state: 'pending', issues: [{ code: 'no_face' }] });
    expect(nextPendingSituation(steps)).toBe('paper');
  });

  it('counts the saved clips unless recalibrating everything', () => {
    const profile = profileFor('baseline');
    const saved = calibrationSteps({ profile, recordings: {}, active: null });
    expect(saved.every((s) => s.state === 'done')).toBe(true);
    expect(nextPendingSituation(saved)).toBeNull();
    const fresh = calibrationSteps({ profile, recordings: {}, active: null, fresh: true });
    expect(fresh.every((s) => s.state === 'pending')).toBe(true);
  });
});
