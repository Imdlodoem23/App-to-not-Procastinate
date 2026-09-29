import { GUARDIAN_CAPABILITIES } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  makeHealth,
  makeKeepAwake,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { KEEP_AWAKE_CHOICES } from '../../../src/shared/keep-awake';
import { AJUSTES_GROUPS, type UiState } from '../../../src/shared/ui-state';
import {
  deriveAjustesView,
  keepAwakeDurationIndex,
  keepAwakeDurationLabel,
  keepAwakeGroup,
} from '../../../src/renderer/src/windows/ajustes/view';

const NOW = HARNESS_NOW;
const MIN = 60_000;

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

describe('Ajustes › Mantener despierto', () => {
  it('is a group of its own that a door can open', () => {
    expect(AJUSTES_GROUPS).toContain('despierto');
    expect(harnessFixture('keep-awake-ajustes').detailRequest).toEqual({
      name: 'ajustes',
      group: 'despierto',
    });
  });

  it('says it is off and what it would do', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW).keepAwake;
    expect(view).toEqual({
      title: 'Mantener despierto: desactivado',
      on: false,
      description: 'Que el equipo no se suspenda por inactividad, aunque cierres Céntrate',
      tone: 'muted',
      durationIndex: KEEP_AWAKE_CHOICES.indexOf(null),
      display: true,
    });
  });

  it('shows the end in its title while on', () => {
    const view = deriveAjustesView(detailState('keep-awake-ajustes'), NOW).keepAwake;
    expect(view).toMatchObject({
      title: 'Mantener despierto: hasta las 18:30',
      on: true,
      description: 'Sigue aunque cierres Céntrate o reinicies el equipo',
      durationIndex: KEEP_AWAKE_CHOICES.indexOf(120),
    });
    // Past its end (before the guardian says so) it reads off.
    const later = keepAwakeGroup(harnessFixture('keep-awake-ajustes').snapshot, NOW + 91 * MIN);
    expect(later).toMatchObject({ on: false, title: 'Mantener despierto: desactivado' });
    withLocale('en', () => {
      expect(deriveAjustesView(detailState('keep-awake-ajustes'), NOW).keepAwake?.title).toMatch(
        /^Keep awake: until 6:30\sPM$/,
      );
    });
  });

  it('warns in orange on a machine that cannot, and when it failed', () => {
    const unsupported = deriveAjustesView(detailState('keep-awake-unsupported'), NOW).keepAwake;
    expect(unsupported).toMatchObject({
      on: false,
      tone: 'orange',
      description: 'Este equipo no permite mantenerlo despierto',
    });
    const failed = keepAwakeGroup(harnessFixture('keep-awake-error').snapshot, NOW);
    expect(failed).toMatchObject({
      on: true,
      tone: 'orange',
      description: 'No se ha podido mantener despierto este equipo',
    });
  });

  it('is hidden with a guardian without the capability', () => {
    const base = detailState('ajustes');
    const older: UiState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        health: makeHealth(NOW, {
          capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'keep_awake'),
        }),
      },
    };
    expect(deriveAjustesView(older, NOW).keepAwake).toBeNull();
  });

  it('puts every duration on a slider stop', () => {
    expect(KEEP_AWAKE_CHOICES.map(keepAwakeDurationLabel)).toEqual([
      '30 min',
      '1 h',
      '2 h',
      '4 h',
      'Sin límite',
    ]);
    expect(KEEP_AWAKE_CHOICES.map(keepAwakeDurationIndex)).toEqual([0, 1, 2, 3, 4]);
    // Durations set through the API: the next longer stop, else the longest timed one.
    expect(keepAwakeDurationIndex(5)).toBe(0);
    expect(keepAwakeDurationIndex(90)).toBe(2);
    expect(keepAwakeDurationIndex(1440)).toBe(3);
    const s = harnessFixture('idle').snapshot;
    const custom = s.state
      ? { ...s, state: { ...s.state, keepAwake: makeKeepAwake(null, 90) } }
      : s;
    expect(keepAwakeGroup(custom, NOW)?.durationIndex).toBe(2);
  });
});
