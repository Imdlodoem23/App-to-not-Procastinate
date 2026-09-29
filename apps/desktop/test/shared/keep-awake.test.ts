import { GUARDIAN_CAPABILITIES } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { HARNESS_NOW, harnessFixture, makeHealth, makeKeepAwake } from '../../src/shared/fixtures';
import { withLocale } from '../../src/shared/i18n/locale';
import {
  KEEP_AWAKE_CHOICES,
  isKeepAwakeChange,
  keepAwakeAvailable,
  keepAwakeChangeFor,
  keepAwakeChoiceLabel,
  keepAwakeChoiceOf,
  keepAwakeDisplayWanted,
  keepAwakeIsOn,
  keepAwakeNextChange,
  keepAwakeOf,
  keepAwakeSummary,
  keepAwakeTrouble,
  keepAwakeTroubleText,
} from '../../src/shared/keep-awake';

const MIN = 60_000;

describe('keep-awake (shared)', () => {
  it('offers 30 min, 1 h, 2 h, 4 h and «Hasta que lo desactive»', () => {
    expect(KEEP_AWAKE_CHOICES).toEqual([30, 60, 120, 240, null]);
    expect(KEEP_AWAKE_CHOICES.map(keepAwakeChoiceLabel)).toEqual([
      '30 min',
      '1 h',
      '2 h',
      '4 h',
      'Hasta que lo desactive',
    ]);
    withLocale('en', () => expect(keepAwakeChoiceLabel(null)).toBe('Until I turn it off'));
  });

  it('turns a choice into the change main sends', () => {
    expect(keepAwakeChangeFor(60)).toEqual({ on: true, durationMinutes: 60 });
    expect(keepAwakeChangeFor(null)).toEqual({ on: true, durationMinutes: null });
    expect(keepAwakeChangeFor('off')).toEqual({ on: false });
  });

  it('accepts only well-formed changes over IPC', () => {
    for (const ok of [
      { on: true },
      { display: false },
      { durationMinutes: null },
      { durationMinutes: 5 },
      { durationMinutes: 1440 },
      { on: true, durationMinutes: 60, display: true },
    ]) {
      expect(isKeepAwakeChange(ok), JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      null,
      [],
      {},
      { on: 1 },
      { display: 'yes' },
      { durationMinutes: 4 },
      { durationMinutes: 1441 },
      { durationMinutes: 60.5 },
      { durationMinutes: '60' },
      { until: null },
      { on: true, since: null },
    ]) {
      expect(isKeepAwakeChange(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads an absent state as off, and needs the capability and a live guardian', () => {
    const idle = harnessFixture('idle').snapshot;
    expect(idle.state?.keepAwake).toBeUndefined();
    expect(keepAwakeOf(idle)).toMatchObject({
      on: false,
      display: true,
      active: false,
      error: null,
    });
    expect(keepAwakeAvailable(idle)).toBe(true);
    const older = {
      ...idle,
      health: makeHealth(HARNESS_NOW, {
        capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'keep_awake'),
      }),
    };
    expect(keepAwakeAvailable(older)).toBe(false);
    expect(keepAwakeAvailable({ ...idle, health: null })).toBe(false);
    expect(keepAwakeAvailable(harnessFixture('protection-broken').snapshot)).toBe(false);
  });

  it('is on until its end, whatever the last poll said', () => {
    const state = makeKeepAwake(HARNESS_NOW - 30 * MIN, 60);
    expect(keepAwakeIsOn(state, HARNESS_NOW)).toBe(true);
    expect(keepAwakeIsOn(state, HARNESS_NOW + 30 * MIN)).toBe(false);
    expect(keepAwakeChoiceOf(state, HARNESS_NOW)).toBe(60);
    expect(keepAwakeChoiceOf(state, HARNESS_NOW + 31 * MIN)).toBeUndefined();
    expect(keepAwakeIsOn(makeKeepAwake(HARNESS_NOW, null), HARNESS_NOW + 10_000 * MIN)).toBe(true);
    expect(keepAwakeIsOn(makeKeepAwake(null, 60), HARNESS_NOW)).toBe(false);
  });

  it('says «Despierto · hasta las 18:30» and what went wrong', () => {
    const until = makeKeepAwake(HARNESS_NOW - 30 * MIN, 120);
    expect(keepAwakeSummary(until)).toBe('Despierto · hasta las 18:30');
    expect(keepAwakeSummary(makeKeepAwake(HARNESS_NOW, null))).toBe('Despierto');
    expect(keepAwakeTrouble(until)).toBeNull();
    const failed = makeKeepAwake(HARNESS_NOW, 60, { active: false, error: 'failed' });
    expect(keepAwakeTrouble(failed)).toBe('failed');
    expect(keepAwakeTroubleText(failed)).toBe('No se ha podido mantener despierto este equipo');
    const unsupported = makeKeepAwake(null, 60, { error: 'unsupported' });
    expect(keepAwakeTrouble(unsupported)).toBe('unsupported');
    expect(keepAwakeTroubleText(unsupported)).toBe('Este equipo no permite mantenerlo despierto');
  });

  it('wants the display on only while on with «pantalla», and wakes at the end', () => {
    const until = harnessFixture('keep-awake-until').snapshot;
    expect(keepAwakeDisplayWanted(until, HARNESS_NOW)).toBe(true);
    expect(keepAwakeNextChange(until, HARNESS_NOW)).toBe(HARNESS_NOW + 90 * MIN);
    expect(keepAwakeDisplayWanted(until, HARNESS_NOW + 90 * MIN)).toBe(false);
    expect(keepAwakeNextChange(until, HARNESS_NOW + 90 * MIN)).toBeNull();
    const forever = harnessFixture('keep-awake').snapshot;
    expect(keepAwakeDisplayWanted(forever, HARNESS_NOW)).toBe(true);
    expect(keepAwakeNextChange(forever, HARNESS_NOW)).toBeNull();
    const idle = harnessFixture('idle').snapshot;
    expect(keepAwakeDisplayWanted(idle, HARNESS_NOW)).toBe(false);
    const dark = {
      ...forever,
      state: forever.state
        ? {
            ...forever.state,
            keepAwake: makeKeepAwake(HARNESS_NOW, null, { display: false }),
          }
        : null,
    };
    expect(keepAwakeDisplayWanted(dark, HARNESS_NOW)).toBe(false);
  });
});
