import { describe, expect, it } from 'vitest';
import type { PendingSettingChange } from '@centrate/shared/domain';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  makeExtensionStatus,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import type { UiState } from '../../../src/shared/ui-state';
import { duplicateKeys } from '../../../src/renderer/src/windows/bloqueos/mnemonics';
import type { AjustesView } from '../../../src/renderer/src/windows/ajustes/view';
import {
  AJUSTES_KEYS,
  deleteWordOk,
  deriveAjustesView,
  inLabel,
  isWeakening,
  pairingView,
  pendingNote,
  weakeningNote,
} from '../../../src/renderer/src/windows/ajustes/view';

const NOW = HARNESS_NOW;
const MIN = 60_000;

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

function mainState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'main');
}

function withState(
  state: UiState,
  patch: (
    s: NonNullable<UiState['snapshot']['state']>,
  ) => NonNullable<UiState['snapshot']['state']>,
): UiState {
  const s = state.snapshot.state;
  if (!s) throw new Error('fixture without state');
  return { ...state, snapshot: { ...state.snapshot, state: patch(s) } };
}

/** Every Alt + letter the Ajustes window gives its tiles. */
function ajustesKeys(view: AjustesView): (string | undefined)[] {
  return [
    ...view.general.themeOptions.map((o) => o.mnemonic),
    ...view.bloqueo.modeOptions.map((o) => o.mnemonic),
    AJUSTES_KEYS.repair,
    ...view.sistema.extensions.map((e) => e.guideKey),
    AJUSTES_KEYS.pairingNew,
    ...view.sistema.guides.map((g) => g.mnemonic),
    AJUSTES_KEYS.diagnostics,
    AJUSTES_KEYS.delete,
  ];
}

describe('Ajustes view per fixture', () => {
  it('shows every group with the current values (ajustes)', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW);
    expect(view.general.title).toBe('General: tema del sistema');
    expect(view.general.theme).toBe('system');
    expect(view.general.themeOptions.map((o) => o.label)).toEqual(['Sistema', 'Claro', 'Oscuro']);
    expect(view.general.autostart).toBe(true);
    expect(view.general.dailyGoal).toEqual({ value: '60 min', note: null });
    expect(view.bloqueo.title).toBe('Bloqueo: Normal por defecto');
    expect(view.bloqueo.modeOptions.map((o) => [o.label, o.tone])).toEqual([
      ['Normal', 'blue'],
      ['Estricto', 'orange'],
      ['Hardcore', 'red'],
    ]);
    expect(view.bloqueo.guardianSettings).toEqual([]);
    expect(view.sistema.title).toBe('Sistema: todo en orden');
    expect(view.sistema.titleTone).toBe('default');
    expect(view.sistema.guardian).toEqual({
      status: 'Activo',
      tone: 'green',
      description: 'Versión 0.1.0 · archivo hosts: bien · vigilante de apps: bien',
      repair: null,
    });
    expect(view.sistema.extensions).toEqual([
      {
        id: 'ext_fixture0000000001',
        title: 'Extensión en Chrome',
        status: 'Conectada',
        tone: 'green',
        description: 'Bloquea al instante, también en incógnito',
        guide: null,
      },
    ]);
    expect(view.sistema.missing).toEqual([]);
    expect(view.sistema.pairing).toEqual({ kind: 'none', expired: false });
    expect(view.sistema.guides.map((g) => [g.id, g.label])).toEqual([
      ['extension-chromium', 'Chrome y Edge'],
      ['extension-firefox', 'Firefox'],
      ['extension-incognito', 'Incógnito'],
    ]);
    expect(view.sistema.diagnostics).toEqual({
      description: 'Para pedir ayuda: sin tus webs, motivos ni nombre',
      tone: 'muted',
    });
    expect(view.datos).toEqual({
      deleteEnabled: false,
      deleteHelp: 'Escribe BORRAR para poder borrar',
    });
  });

  it('shows the pairing code until it expires (ajustes-pairing)', () => {
    const state = detailState('ajustes-pairing');
    expect(deriveAjustesView(state, NOW).sistema.pairing).toEqual({
      kind: 'code',
      code: '482913',
      expiresAtMs: NOW + 4 * MIN + 20_000,
      port: null,
    });
    const later = NOW + 4 * MIN + 20_000;
    expect(deriveAjustesView(state, later).sistema.pairing).toEqual({
      kind: 'none',
      expired: true,
    });
    const pairing = state.detail.ajustes.pairing;
    if (!pairing) throw new Error('fixture without pairing');
    expect(pairingView({ ...pairing, port: 47601 }, NOW)).toMatchObject({ port: 'Puerto: 47601' });
  });

  it('enables «Borrar todos mis datos» once BORRAR is typed (ajustes-delete)', () => {
    expect(deriveAjustesView(detailState('ajustes-delete'), NOW).datos.deleteEnabled).toBe(true);
    expect(deleteWordOk(' borrar ')).toBe(true);
    expect(deleteWordOk('BORRA')).toBe(false);
    expect(deleteWordOk('BORRAR YA')).toBe(false);
    expect(deleteWordOk('')).toBe(false);
  });

  it('offers «Reparar» when the guardian stopped (protection-broken)', () => {
    const view = deriveAjustesView(mainState('protection-broken'), NOW);
    expect(view.sistema.title).toBe('Sistema: guardián detenido');
    expect(view.sistema.titleTone).toBe('red');
    expect(view.sistema.guardian).toMatchObject({
      status: 'Detenido',
      tone: 'red',
      repair: 'Reparar',
    });
  });

  it('offers «Instalar» without a guardian and hides the goal it cannot read (not-installed)', () => {
    const view = deriveAjustesView(mainState('not-installed'), NOW);
    expect(view.sistema.title).toBe('Sistema: guardián no instalado');
    expect(view.sistema.guardian).toMatchObject({ status: 'No instalado', repair: 'Instalar' });
    expect(view.general.dailyGoal).toBeNull();
    expect(view.sistema.extensions).toEqual([]);
  });

  it('points at the extension when a browser lacks it (extension-missing)', () => {
    const view = deriveAjustesView(mainState('extension-missing'), NOW);
    expect(view.sistema.title).toBe('Sistema: revisa la extensión');
    expect(view.sistema.titleTone).toBe('orange');
    expect(view.sistema.missing).toEqual([{ id: 'chrome', title: 'Chrome no tiene la extensión' }]);
  });

  it('names what each extension misses and the guide that fixes it', () => {
    const state = withState(detailState('ajustes'), (s) => ({
      ...s,
      protection: {
        ...s.protection,
        extensions: [
          makeExtensionStatus('firefox', NOW, { connected: false }),
          makeExtensionStatus('edge', NOW, { hostPermission: false }),
          makeExtensionStatus('brave', NOW, { incognitoAllowed: false }),
        ],
      },
    }));
    const view = deriveAjustesView(state, NOW);
    const rows = view.sistema.extensions;
    expect(rows.map((r) => [r.title, r.status, r.guide])).toEqual([
      ['Extensión en Firefox', 'Desconectada', 'extension-firefox'],
      ['Extensión en Edge', 'Sin permiso', 'extension-chromium'],
      ['Extensión en Brave', 'Falta incógnito', 'extension-incognito'],
    ]);
    // Three «Guía…» tiles, three different keys, none taken by another tile.
    expect(rows.map((r) => r.guideKey)).toEqual(['g', 'a', 'd']);
    expect(duplicateKeys(ajustesKeys(view))).toEqual([]);
  });

  it('shows «Copiado» after copying the diagnostics', () => {
    const base = detailState('ajustes');
    const copied = deriveAjustesView(
      {
        ...base,
        detail: { ...base.detail, ajustes: { ...base.detail.ajustes, diagnostics: 'fallback' } },
      },
      NOW,
    );
    expect(copied.sistema.diagnostics).toEqual({
      description: 'Copiado: el guardián no responde, va lo que ve la app',
      tone: 'green',
    });
  });

  it('follows the preferences', () => {
    const base = detailState('ajustes');
    const view = deriveAjustesView(
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          prefs: { ...base.snapshot.prefs, theme: 'dark', autostart: false, defaultMode: 'strict' },
        },
      },
      NOW,
    );
    expect(view.general.theme).toBe('dark');
    expect(view.general.title).toBe('General: tema oscuro');
    expect(view.general.autostart).toBe(false);
    expect(view.bloqueo.title).toBe('Bloqueo: Estricto por defecto');
  });
});

describe('Ajustes weakening delay', () => {
  const goal: PendingSettingChange = {
    field: 'dailyGoalMinutes',
    value: 30,
    effectiveAt: new Date(NOW + 22 * 60 * MIN + 10 * MIN).toISOString(),
  };

  it('says when a pending change applies', () => {
    expect(pendingNote(goal, NOW)).toBe('Pasará a 30 min en 23 h');
    expect(
      pendingNote(
        {
          field: 'closeBrowsersWithoutExtension',
          value: false,
          effectiveAt: new Date(NOW + 45 * MIN).toISOString(),
        },
        NOW,
      ),
    ).toBe('Se desactivará en 45 min');
    const state = withState(detailState('ajustes'), (s) => ({ ...s, pendingSettings: [goal] }));
    expect(deriveAjustesView(state, NOW).general.dailyGoal).toEqual({
      value: '60 min',
      note: 'Pasará a 30 min en 23 h',
    });
  });

  it('only weakening changes wait 24 h', () => {
    expect(inLabel(24 * 60 * MIN)).toBe('en 24 h');
    expect(isWeakening('dailyGoalMinutes', 60, 30)).toBe(true);
    expect(isWeakening('dailyGoalMinutes', 30, 60)).toBe(false);
    expect(weakeningNote('closeBrowsersWithoutExtension', true, false)).toBe('Se aplicará en 24 h');
    expect(weakeningNote('closeBrowsersWithoutExtension', false, true)).toBeNull();
    expect(weakeningNote('attemptPenalties', true, false)).toBe('Se aplicará en 24 h');
  });

  it('lists the guardian settings once the app can read them', () => {
    const fixture = harnessFixture('ajustes');
    const settings = {
      ...fixture.fake.settings,
      settings: { ...fixture.fake.settings.settings, closeBrowsersWithoutExtension: true },
    };
    const rows = deriveAjustesView(detailState('ajustes'), NOW, settings).bloqueo.guardianSettings;
    expect(rows.map((r) => [r.title, r.value, r.note])).toEqual([
      ['Cerrar navegadores sin extensión', true, 'Se aplicará en 24 h'],
      ['Penalizaciones', true, 'Se aplicará en 24 h'],
    ]);
  });
});

describe('Ajustes Alt + letter', () => {
  it('gives every tile its own key, a letter of its label', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW);
    expect(view.general.themeOptions.map((o) => [o.label, o.mnemonic])).toEqual([
      ['Sistema', 's'],
      ['Claro', 'c'],
      ['Oscuro', 'o'],
    ]);
    expect(view.bloqueo.modeOptions.map((o) => o.mnemonic)).toEqual(['n', 'e', 'h']);
    expect(view.sistema.guides.map((g) => [g.label, g.mnemonic])).toEqual([
      ['Chrome y Edge', 'm'],
      ['Firefox', 'f'],
      ['Incógnito', 'i'],
    ]);
    expect(duplicateKeys(ajustesKeys(view))).toEqual([]);
  });

  it('keeps the description beside the tiles to one line of help per option', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW);
    for (const o of [...view.general.themeOptions, ...view.bloqueo.modeOptions]) {
      expect(o.help.length, o.label).toBeLessThanOrEqual(56);
    }
  });
});
