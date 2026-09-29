import { describe, expect, it } from 'vitest';
import { PHASE1_FEATURES } from '../../../src/shared/features';
import {
  HARNESS_NOW,
  harnessFixture,
  makeHealth,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { GUARDIAN_CAPABILITIES } from '@centrate/shared/guardian-api';
import { withLocale } from '../../../src/shared/i18n/locale';
import { INITIAL_UPDATER, type UpdaterState } from '../../../src/shared/platform';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import {
  deriveFooterView,
  footerAwake,
  footerVersion,
  updateOutcome,
} from '../../../src/renderer/src/sections/footer/view';

function snapshotOf(id: HarnessStateId): UiSnapshot {
  return harnessFixture(id).snapshot;
}

function updater(patch: Partial<UpdaterState>): UpdaterState {
  return { ...INITIAL_UPDATER, ...patch };
}

describe('footer: «Actualizar a vX»', () => {
  it('is plain «v0.1.0» without a new version', () => {
    expect(footerVersion(snapshotOf('idle'))).toEqual({
      label: 'v0.1.0',
      update: false,
      action: null,
    });
  });

  it('installs a downloaded update (the update-available fixture)', () => {
    expect(footerVersion(snapshotOf('update-available'))).toEqual({
      label: 'Actualizar a v0.2.0',
      update: true,
      action: 'install',
    });
  });

  it('downloads an available one, and retries after an error', () => {
    const base = snapshotOf('ajustes-full');
    expect(footerVersion(base)).toEqual({
      label: 'Actualizar a v0.2.0',
      update: true,
      action: 'download',
    });
    const failed = { ...base, updater: updater({ status: 'error', version: '0.2.0' }) };
    expect(footerVersion(failed).action).toBe('download');
  });

  it('shows the download progress as muted text, not a button', () => {
    const base = snapshotOf('update-available');
    const downloading = {
      ...base,
      updater: updater({ status: 'downloading', version: '0.2.0', percent: 45.7 }),
    };
    expect(footerVersion(downloading)).toEqual({
      label: 'Descargando v0.2.0 · 45 %',
      update: false,
      action: null,
    });
    const starting = { ...base, updater: updater({ status: 'downloading', version: '0.2.0' }) };
    expect(footerVersion(starting).label).toBe('Descargando v0.2.0…');
    expect(withLocale('en', () => footerVersion(downloading).label)).toBe(
      'Downloading v0.2.0 · 45%',
    );
  });

  it('turns the answer into one help line', () => {
    expect(updateOutcome('install', updater({ status: 'ready', version: '0.2.0' }))).toEqual({
      text: 'Reiniciando para actualizar. Los bloqueos siguen activos',
      tone: 'muted',
    });
    expect(updateOutcome('download', updater({ status: 'ready', version: '0.2.0' }))).toBeNull();
    expect(updateOutcome('download', updater({ status: 'downloading' }))).toBeNull();
    expect(updateOutcome('download', updater({ status: 'error' }))).toEqual({
      text: 'No se ha podido descargar la actualización',
      tone: 'red',
    });
    expect(updateOutcome('download', updater({ status: 'unsupported' }))?.tone).toBe('red');
    expect(updateOutcome('download', updater({ status: 'available' }))).toEqual({
      text: 'He abierto la página de descarga de la versión nueva',
      tone: 'muted',
    });
  });
});

describe('footer: «Mini temporizador»', () => {
  it('shows pressed while the mini timer is on screen', () => {
    const base = snapshotOf('idle');
    expect(deriveFooterView(base).miniTimerVisible).toBe(false);
    const visible: UiSnapshot = {
      ...base,
      prefs: { ...base.prefs, miniTimer: { visible: true, position: null } },
    };
    expect(deriveFooterView(visible).miniTimerVisible).toBe(true);
    expect(deriveFooterView(visible).buttons).toEqual(['miniTimer', 'settings', 'quit']);
  });

  it('is gone with its flag off (Ajustes… and Salir split the row)', () => {
    const base = snapshotOf('idle');
    const off: UiSnapshot = {
      ...base,
      features: PHASE1_FEATURES,
      prefs: { ...base.prefs, miniTimer: { visible: true, position: null } },
    };
    expect(deriveFooterView(off).buttons).toEqual(['settings', 'quit']);
    expect(deriveFooterView(off).miniTimerVisible).toBe(false);
  });
});

describe('footer: «Despierto» chip (Mantener despierto)', () => {
  it('reads «Despierto · hasta las 18:30» or «Despierto» while on', () => {
    expect(deriveFooterView(snapshotOf('keep-awake-until')).awake).toEqual({
      label: 'Despierto · hasta las 18:30',
      tone: 'blue',
      trouble: null,
    });
    expect(deriveFooterView(snapshotOf('keep-awake')).awake).toEqual({
      label: 'Despierto',
      tone: 'blue',
      trouble: null,
    });
    withLocale('en', () => {
      expect(deriveFooterView(snapshotOf('keep-awake-until')).awake?.label).toMatch(
        /^Awake · until 6:30\sPM$/,
      );
    });
  });

  it('says «Despierto: error» in orange, and why, when the guardian cannot hold it', () => {
    expect(deriveFooterView(snapshotOf('keep-awake-error')).awake).toEqual({
      label: 'Despierto: error',
      tone: 'orange',
      trouble: 'No se ha podido mantener despierto este equipo',
    });
  });

  it('gives the right side to a pending update', () => {
    const base = snapshotOf('keep-awake');
    const update = snapshotOf('update-available');
    const both: UiSnapshot = { ...update, state: base.state };
    expect(deriveFooterView(both).awake).toBeNull();
    expect(deriveFooterView(both).version.action).toBe('install');
    const downloading: UiSnapshot = {
      ...base,
      updater: { ...base.updater, status: 'downloading', version: '0.2.0', percent: 40 },
    };
    expect(deriveFooterView(downloading).awake).toBeNull();
  });

  it('is not there while off, past its end, down or without the capability', () => {
    expect(deriveFooterView(snapshotOf('idle')).awake).toBeNull();
    expect(deriveFooterView(snapshotOf('keep-awake-unsupported')).awake).toBeNull();
    const until = snapshotOf('keep-awake-until');
    expect(footerAwake(until, HARNESS_NOW + 91 * 60_000)).toBeNull();
    expect(footerAwake(until, HARNESS_NOW + 89 * 60_000)).not.toBeNull();
    const down: UiSnapshot = {
      ...until,
      link: { ...until.link, status: 'down', reason: 'unreachable' },
    };
    expect(footerAwake(down, HARNESS_NOW)).toBeNull();
    const older: UiSnapshot = {
      ...until,
      health: makeHealth(HARNESS_NOW, {
        capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'keep_awake'),
      }),
    };
    expect(footerAwake(older, HARNESS_NOW)).toBeNull();
  });
});
