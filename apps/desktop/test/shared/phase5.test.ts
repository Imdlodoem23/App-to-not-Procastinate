import { DEFAULT_GUARDIAN_SETTINGS } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { harnessFixture } from '../../src/shared/fixtures';
import { PHASE5_INVOKE_CHANNELS, PHASE5_SEND_CHANNELS } from '../../src/shared/ipc';
import { PHASE5_INVOKE_GUARDS, PHASE5_SEND_GUARDS } from '../../src/shared/ipc-payloads';
import { notImplemented, phase5InvokeStubs, phase5SendStubs } from '../../src/shared/phase5-stubs';
import {
  DEFAULT_FEATURE_PREFS,
  FEATURE_PREF_KEYS,
  SOUND_FILES,
  SOUND_IDS,
  applyFeaturePrefsPatch,
  isAccelerator,
  isFeaturePrefsPatchEntry,
  sanitizeFeaturePrefs,
} from '../../src/shared/prefs';
import {
  bestHours,
  csvField,
  csvLine,
  daysBetween,
  heatmapLevel,
  isoWeekdayIndex,
  shiftAnchor,
  statsPeriod,
} from '../../src/shared/stats';
import {
  DEFAULT_PREFS,
  DETAIL_NAMES,
  applyUiPrefsPatch,
  clonePrefs,
  defaultDetailRequest,
  initialDetailLocal,
  initialMainLocal,
  initialSnapshot,
  isUiWindow,
  onboardingActive,
  onboardingStepNumber,
  onboardingStepStatus,
  snapshotFeature,
} from '../../src/shared/ui-state';
import {
  PHASE5_INVALID_INVOKE,
  PHASE5_INVALID_SEND,
  PHASE5_VALID_INVOKE,
  PHASE5_VALID_SEND,
} from './phase5-payloads';

describe('Phase 5 preferences', () => {
  it('default every field and keep the Phase 1 ones', () => {
    for (const key of FEATURE_PREF_KEYS)
      expect(DEFAULT_PREFS[key]).toEqual(DEFAULT_FEATURE_PREFS[key]);
    expect(DEFAULT_PREFS.onboarding).toEqual({ done: false, step: 'welcome' });
    expect(DEFAULT_PREFS.miniTimer).toEqual({ visible: false, position: null });
    expect(DEFAULT_PREFS.shortcuts['toggle-main']).toBe('CommandOrControl+Alt+C');
    expect(Object.isFrozen(DEFAULT_FEATURE_PREFS.sounds)).toBe(true);
    expect(Object.keys(SOUND_FILES).sort()).toEqual([...SOUND_IDS].sort());
  });

  it('sanitize a damaged prefs.json field by field', () => {
    expect(sanitizeFeaturePrefs(null)).toEqual(DEFAULT_FEATURE_PREFS);
    const out = sanitizeFeaturePrefs({
      osd: 'yes',
      sounds: { ambient: 'rain', volume: 400, autoplay: true, extra: 1 },
      reminders: 'nope',
      shortcuts: { 'toggle-main': 'Q', 'extend-15': 'CommandOrControl+Alt+E' },
      miniTimer: { visible: true, position: { x: -1200, y: 40 } },
      pomodoro: { workMinutes: 50, breakMinutes: 0, cycles: 2 },
      onboarding: { done: true, step: 'nowhere' },
    });
    expect(out.osd).toBe(true);
    expect(out.sounds).toEqual({ ambient: 'rain', volume: 60, autoplay: true });
    expect(out.reminders).toEqual(DEFAULT_FEATURE_PREFS.reminders);
    expect(out.shortcuts).toEqual({
      'toggle-main': 'CommandOrControl+Alt+C',
      'extend-15': 'CommandOrControl+Alt+E',
      'toggle-mini-timer': null,
    });
    expect(out.miniTimer).toEqual({ visible: true, position: { x: -1200, y: 40 } });
    expect(out.pomodoro).toEqual({ workMinutes: 50, breakMinutes: 5, cycles: 2 });
    expect(out.onboarding).toEqual({ done: true, step: 'welcome' });
  });

  it('validate patches strictly and merge nested objects', () => {
    expect(isFeaturePrefsPatchEntry('osd', false)).toBe(true);
    expect(isFeaturePrefsPatchEntry('sounds', { volume: 30 })).toBe(true);
    expect(isFeaturePrefsPatchEntry('sounds', {})).toBe(false);
    expect(isFeaturePrefsPatchEntry('sounds', { volume: 30.5 })).toBe(false);
    expect(isFeaturePrefsPatchEntry('shortcuts', { 'toggle-main': null })).toBe(true);
    expect(isFeaturePrefsPatchEntry('shortcuts', { 'open-devtools': 'Ctrl+Shift+I' })).toBe(false);
    expect(isFeaturePrefsPatchEntry('miniTimer', { position: { x: 1, y: 2, z: 3 } })).toBe(false);
    expect(isFeaturePrefsPatchEntry('onboarding', { step: 'camera' })).toBe(true);
    const next = applyFeaturePrefsPatch(clonePrefs(DEFAULT_PREFS), {
      sounds: { volume: 30 },
      onboarding: { done: true },
    });
    expect(next.sounds).toEqual({ ...DEFAULT_FEATURE_PREFS.sounds, volume: 30 });
    expect(next.onboarding).toEqual({ done: true, step: 'welcome' });
    expect(DEFAULT_PREFS.sounds.volume).toBe(60);
  });

  it('apply a whole prefs:set patch (plain fields and merged objects)', () => {
    const prefs = applyUiPrefsPatch(DEFAULT_PREFS, {
      theme: 'dark',
      miniTimer: { visible: true },
      reminders: { eyeBreaks: true },
    });
    expect(prefs.theme).toBe('dark');
    expect(prefs.miniTimer).toEqual({ visible: true, position: null });
    expect(prefs.reminders.eyeBreaks).toBe(true);
    expect(prefs.reminders.schedules).toBe(true);
    expect(DEFAULT_PREFS.theme).toBe('system');
    const copy = clonePrefs(DEFAULT_PREFS);
    expect(copy).toEqual(DEFAULT_PREFS);
    expect(copy.sounds).not.toBe(DEFAULT_PREFS.sounds);
  });

  it('accept only global accelerators with a real modifier', () => {
    for (const ok of ['CommandOrControl+Alt+C', 'Ctrl+Shift+F12', 'Super+Space', 'Alt+Plus']) {
      expect(isAccelerator(ok), ok).toBe(true);
    }
    for (const bad of ['C', 'Shift+C', 'Ctrl+Ctrl+C', 'Ctrl+', 'Ctrl+Alt', 'Ctrl+Ñ', '', 5]) {
      expect(isAccelerator(bad), String(bad)).toBe(false);
    }
  });
});

describe('statistics helpers', () => {
  it('find the day, the ISO week and the month around an anchor', () => {
    expect(isoWeekdayIndex('2026-09-28')).toBe(0); // Monday
    expect(isoWeekdayIndex('2026-10-04')).toBe(6); // Sunday
    expect(statsPeriod('day', '2026-09-28')).toEqual({ from: '2026-09-28', to: '2026-09-28' });
    expect(statsPeriod('week', '2026-10-01')).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(statsPeriod('month', '2026-09-28')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(statsPeriod('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(daysBetween('2026-09-28', '2026-10-02')).toHaveLength(5);
    expect(shiftAnchor('week', '2026-09-28', -1)).toBe('2026-09-21');
    expect(shiftAnchor('month', '2026-09-15', 1)).toBe('2026-10-01');
    expect(shiftAnchor('month', '2026-03-31', -1)).toBe('2026-02-01');
    expect(() => statsPeriod('week', '2026-02-30')).toThrow(RangeError);
  });

  it('grade the heatmap against the goal and pick the best hours', () => {
    expect([0, 10, 15, 30, 59, 60, 200].map((m) => heatmapLevel(m, 60))).toEqual([
      0, 1, 2, 3, 3, 4, 4,
    ]);
    expect(heatmapLevel(5, 0)).toBe(4);
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      focusMinutes: hour === 18 ? 40 : hour === 9 ? 10 : 0,
      blockMinutes: hour === 17 ? 40 : 0,
    }));
    expect(bestHours(hours, 2).map((h) => h.hour)).toEqual([17, 18]);
    expect(bestHours(hours).map((h) => h.hour)).toEqual([17, 18, 9]);
  });

  it('write CSV safely (quotes, line breaks, spreadsheet formulas)', () => {
    expect(csvField('YouTube')).toBe('YouTube');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(-10)).toBe('-10');
    expect(csvField(null)).toBe('');
    expect(csvLine(['2026-09-28', 42, null])).toBe('2026-09-28,42,\r\n');
  });
});

describe('Phase 5 payload guards', () => {
  it('cover every Phase 5 channel', () => {
    expect(Object.keys(PHASE5_INVOKE_GUARDS).sort()).toEqual([...PHASE5_INVOKE_CHANNELS].sort());
    expect(Object.keys(PHASE5_SEND_GUARDS).sort()).toEqual([...PHASE5_SEND_CHANNELS].sort());
  });

  it('accept the valid payloads and refuse the rest', () => {
    for (const channel of PHASE5_INVOKE_CHANNELS) {
      expect(PHASE5_INVOKE_GUARDS[channel](PHASE5_VALID_INVOKE[channel]), channel).toBe(true);
      for (const bad of PHASE5_INVALID_INVOKE[channel] ?? []) {
        expect(PHASE5_INVOKE_GUARDS[channel](bad), `${channel} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
    for (const channel of PHASE5_SEND_CHANNELS) {
      expect(PHASE5_SEND_GUARDS[channel](PHASE5_VALID_SEND[channel]), channel).toBe(true);
      for (const bad of PHASE5_INVALID_SEND[channel]) {
        expect(PHASE5_SEND_GUARDS[channel](bad), `${channel} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });

  it('validate settings with the guardian validators (full settings only)', () => {
    const settings = { ...DEFAULT_GUARDIAN_SETTINGS, timezone: 'Europe/Madrid' };
    expect(PHASE5_INVOKE_GUARDS['settings:put']({ settings })).toBe(true);
    expect(
      PHASE5_INVOKE_GUARDS['settings:put']({ settings: { ...settings, dailyGoalMinutes: 5 } }),
    ).toBe(false);
  });
});

describe('Phase 5 stubs', () => {
  it('answer not_implemented outside the harness, except the camera placeholder', async () => {
    const stubs = phase5InvokeStubs(
      () => null,
      () => 0,
    );
    for (const channel of PHASE5_INVOKE_CHANNELS) {
      const answer = await Promise.resolve(
        (stubs[channel] as (req: unknown) => unknown)(PHASE5_VALID_INVOKE[channel]),
      );
      if (channel === 'onboarding:test-camera') {
        expect(answer).toEqual({ ok: true, value: { outcome: 'unavailable' } });
      } else {
        expect(answer, channel).toEqual({ ok: false, error: notImplemented() });
      }
    }
    const sends = phase5SendStubs();
    for (const channel of PHASE5_SEND_CHANNELS) expect(typeof sends[channel]).toBe('function');
  });

  it('follow the fixture loaded now (the harness switches fixtures in place)', () => {
    let current = harnessFixture('rewards');
    const stubs = phase5InvokeStubs(
      () => current,
      () => current.nowMs,
    );
    const first = stubs['rewards:redeem']({ intentId: 'i-1', offerId: 'youtube-15' });
    expect(first.ok && first.value.balanceAfter).toBe(1090);
    current = harnessFixture('rewards-short-points');
    const second = stubs['rewards:redeem']({ intentId: 'i-2', offerId: 'youtube-15' });
    expect(second.ok ? null : second.error.details).toEqual({
      balance: 110,
      cost: 150,
      shortBy: 40,
    });
    const heat = stubs['stats:heatmap']({ end: null, weeks: 4 });
    expect(heat.ok && heat.value.cells.length).toBeLessThanOrEqual(28);
    const events = stubs['stats:events']({ filter: 'attempts', before: null, limit: 50 });
    expect(events.ok && events.value.entries.every((e) => e.type === 'attempt')).toBe(true);
  });
});

describe('Phase 5 state model', () => {
  it('names every window and detail view', () => {
    for (const w of ['main', 'detail', 'mini-timer', 'osd', 'nuclear'])
      expect(isUiWindow(w)).toBe(true);
    expect(isUiWindow('camera')).toBe(false);
    for (const name of DETAIL_NAMES) expect(defaultDetailRequest(name).name).toBe(name);
    expect(defaultDetailRequest('estadisticas')).toEqual({ name: 'estadisticas', range: null });
  });

  it('starts empty: no progress, updater idle, no OSD, overlay hidden', () => {
    const app = {
      version: '0.1.0',
      platform: 'win32' as const,
      packaged: true,
      updateVersion: null,
      systemLocale: 'es' as const,
    };
    const s = initialSnapshot(app, 0);
    expect(s.progress).toBeNull();
    expect(s.updater.status).toBe('idle');
    expect(s.osd).toBeNull();
    expect(s.nuclear.overlay).toBe('hidden');
    expect(s.shortcuts.failed).toEqual([]);
    expect(onboardingActive(s)).toBe(true);
    expect(
      onboardingActive({
        ...s,
        prefs: { ...s.prefs, onboarding: { done: true, step: 'welcome' } },
      }),
    ).toBe(false);
    expect(snapshotFeature(s, 'study')).toBe(false);
    expect(initialMainLocal().onboarding).toEqual({ pairing: null, installing: false });
    expect(initialDetailLocal().estadisticas.range).toBe('week');
  });

  it('numbers the onboarding steps and reads their status from the snapshot', () => {
    expect(onboardingStepNumber('welcome')).toBe(1);
    expect(onboardingStepNumber('first-block')).toBe(5);
    const ok = harnessFixture('one-block').snapshot;
    expect(onboardingStepStatus(ok, 'guardian')).toBe('done');
    expect(onboardingStepStatus(ok, 'extension')).toBe('done');
    expect(onboardingStepStatus(ok, 'first-block')).toBe('done');
    expect(onboardingStepStatus(harnessFixture('idle').snapshot, 'first-block')).toBe('todo');
  });
});
