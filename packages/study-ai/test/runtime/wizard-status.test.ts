/**
 * The calibration wizard as Electron main builds it (HANDOFF §6): from the pure entry only,
 * with the saved `profile.json` string and the `calibration_recorded` summaries that cross
 * IPC. Never `parseProfile` (it may retrain: seconds of CPU on main's thread).
 */
import { describe, expect, it } from 'vitest';
import * as pure from '../../src/index';
import { calibrationSteps, nextPendingSituation, profileStatus } from '../../src/index';
import { serializeProfile } from '../../src/calibration/profile';
import type { CalibrationRecordingSummary } from '../../src/types';
import { profileFor } from '../calibration/fixtures';

const PROFILE_JSON = serializeProfile(profileFor('baseline'));

describe('wizard status from the pure entry', () => {
  it('is exported from the pure entry (the one Electron main may import)', () => {
    expect(typeof pure.profileStatus).toBe('function');
    expect(typeof pure.calibrationSteps).toBe('function');
    expect(typeof pure.nextPendingSituation).toBe('function');
  });

  it('reads the saved clips of a profile without training anything', () => {
    const status = profileStatus(PROFILE_JSON);
    expect(status.ok).toBe(true);
    expect(status.clips).toEqual({
      screen: true,
      paper: true,
      phone: true,
      away: true,
      absent: true,
    });
    expect(status.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is fast enough for main: 100 reads of a real profile well under a second', () => {
    const started = performance.now();
    for (let i = 0; i < 100; i += 1) profileStatus(PROFILE_JSON);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reports an absent, broken or foreign file as not calibrated', () => {
    const none = { screen: false, paper: false, phone: false, away: false, absent: false };
    for (const json of [
      null,
      undefined,
      '',
      '{',
      '[]',
      '{"format":"other","version":1}',
      JSON.stringify({ ...JSON.parse(PROFILE_JSON), version: 99 }),
      JSON.stringify({ ...JSON.parse(PROFILE_JSON), camera: { key: 'label: FaceTime' } }),
      'x'.repeat(512 * 1024 + 1),
    ]) {
      expect(profileStatus(json)).toEqual({ ok: false, clips: none, updatedAt: null });
    }
  });

  it('marks a missing clip pending', () => {
    const raw = JSON.parse(PROFILE_JSON) as { clips: Record<string, unknown> };
    raw.clips.away = null;
    const status = profileStatus(JSON.stringify(raw));
    expect(status.ok).toBe(true);
    expect(status.clips.away).toBe(false);
    const steps = calibrationSteps({ profile: status, recordings: {}, active: null });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'pending', 'done']);
    expect(nextPendingSituation(steps)).toBe('away');
  });

  it('re-recording one situation: the saved clips stay «Hecho», the new one follows its summary', () => {
    const status = profileStatus(PROFILE_JSON);
    const phone: CalibrationRecordingSummary = {
      cls: 'phone',
      rows: 12,
      faceRatio: 0.2,
      issues: [{ code: 'too_short', cls: 'phone', severity: 'error' }],
    };
    const steps = calibrationSteps({ profile: status, recordings: { phone }, active: null });
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'pending', 'done', 'done']);
    expect(steps[2]?.issues.map((i) => i.code)).toEqual(['too_short']);
    expect(nextPendingSituation(steps)).toBe('phone');
    // «Recalibrar»: the saved clips no longer count.
    const fresh = calibrationSteps({ profile: status, recordings: {}, active: null, fresh: true });
    expect(fresh.every((s) => s.state === 'pending')).toBe(true);
  });

  it('no profile yet: everything pending, screen first', () => {
    const steps = calibrationSteps({ profile: profileStatus(null), recordings: {}, active: null });
    expect(nextPendingSituation(steps)).toBe('screen');
  });
});
