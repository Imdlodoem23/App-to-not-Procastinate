import { describe, expect, it } from 'vitest';
import type { PendingSettingChange } from '@centrate/shared/domain';
import type { SettingsResponse } from '@centrate/shared/guardian-api';
import { PHASE1_FEATURES } from '../../../src/shared/features';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  makeExtensionStatus,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import type { UpdaterState } from '../../../src/shared/platform';
import type { UiState } from '../../../src/shared/ui-state';
import { duplicateKeys } from '../../../src/renderer/src/windows/bloqueos/mnemonics';
import { AJUSTES_EN, AJUSTES_ES } from '../../../src/renderer/src/windows/ajustes/i18n';
import {
  AJUSTES_KEYS,
  ajustesTileKeys,
  deleteWordOk,
  deriveAjustesView,
  inLabel,
  isWeakening,
  pairingView,
  pendingNote,
  updaterRow,
  weakeningNote,
  type AjustesView,
} from '../../../src/renderer/src/windows/ajustes/view';

const NOW = HARNESS_NOW;
const MIN = 60_000;

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

function mainState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'main');
}

/** The guardian settings the fixture's fake guardian answers (`settings:get`). */
function settingsOf(id: HarnessStateId): SettingsResponse {
  return harnessFixture(id).fake.settings;
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

function withSnapshot(state: UiState, patch: Partial<UiState['snapshot']>): UiState {
  return { ...state, snapshot: { ...state.snapshot, ...patch } };
}

/** The same state with the `study` flag on (the Study Mode group and the camera row). */
function withStudy(state: UiState): UiState {
  return withSnapshot(state, { features: { ...state.snapshot.features, study: true } });
}

/** The Study Mode group (the `study` flag must be on). */
function studyOf(view: AjustesView): NonNullable<AjustesView['study']> {
  if (!view.study) throw new Error('no Study Mode group');
  return view.study;
}

/** The full window: the `ajustes-full` fixture with its guardian settings read. */
function fullView(): AjustesView {
  return deriveAjustesView(detailState('ajustes-full'), NOW, settingsOf('ajustes-full'));
}

/** The full window with every flag this wave can turn on (Study Mode included). */
function fullStudyView(): AjustesView {
  return deriveAjustesView(withStudy(detailState('ajustes-full')), NOW, settingsOf('ajustes-full'));
}

describe('Ajustes view per fixture', () => {
  it('shows every group with the current values (ajustes, before the settings answer)', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW);
    expect(view.general.title).toBe('General: tema del sistema');
    expect(view.general.theme).toBe('system');
    expect(view.general.themeOptions.map((o) => o.label)).toEqual(['Sistema', 'Claro', 'Oscuro']);
    expect(view.general.autostart).toBe(true);
    // The goal comes from the state until the guardian settings answer: no tiles yet.
    expect(view.general.dailyGoal).toEqual({
      value: '60 min',
      note: null,
      options: null,
      selected: 60,
    });
    expect(view.bloqueo.title).toBe('Bloqueo: Normal por defecto');
    expect(view.bloqueo.modeOptions.map((o) => [o.label, o.tone])).toEqual([
      ['Normal', 'blue'],
      ['Estricto', 'orange'],
      ['Hardcore', 'red'],
    ]);
    expect(view.bloqueo.guardianSettings).toEqual([]);
    expect(view.bloqueo.settingsStatus).toBe('Leyendo…');
    // No Study Mode yet: no group and no camera row (hidden, never greyed out).
    expect(view.study).toBeNull();
    expect(view.sistema.camera).toBeNull();
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
    expect(view.sistema.activeWindow).toEqual({
      status: 'En espera',
      tone: 'neutral',
      description: 'Durante un bloqueo, mira qué ventana tienes delante',
      allowKey: null,
    });
    expect(view.sistema.updater).toMatchObject({ status: 'al día', tone: 'green' });
    expect(view.sistema.diagnostics).toEqual({
      description: 'Para pedir ayuda: sin tus webs, motivos ni nombre',
      tone: 'muted',
    });
    expect(view.datos).toMatchObject({
      deleteEnabled: false,
      deleteHelp: 'Escribe BORRAR para poder borrar',
    });
    expect(view.datos.export).not.toBeNull();
  });

  it('shows the guardian settings once read (ajustes)', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW, settingsOf('ajustes'));
    const goal = view.general.dailyGoal;
    expect(goal?.options?.map((o) => [o.label, o.help])).toEqual([
      ['30 min', 'Bajarlo se aplicará en 24 h'],
      ['45 min', 'Bajarlo se aplicará en 24 h'],
      ['60 min', 'Tu objetivo ahora'],
      ['90 min', 'Subirlo se aplica al momento'],
    ]);
    expect(goal?.selected).toBe(60);
    expect(view.bloqueo.settingsStatus).toBeNull();
    expect(view.bloqueo.guardianSettings.map((r) => [r.title, r.value, r.description])).toEqual([
      ['Penalizaciones', true, 'Cada intento resta puntos; quitarlas tarda 24 h'],
      [
        'Cerrar navegadores sin extensión',
        false,
        'Durante un bloqueo, cierra los navegadores que no la tengan activa',
      ],
    ]);
    expect(view.study).toBeNull();
  });

  it('shows the Study Mode group and the camera only with the study flag', () => {
    const before = deriveAjustesView(withStudy(detailState('ajustes')), NOW);
    expect(studyOf(before)).toMatchObject({
      title: 'Study Mode: castigo',
      levels: null,
      duration: null,
    });
    const view = deriveAjustesView(withStudy(detailState('ajustes')), NOW, settingsOf('ajustes'));
    const study = studyOf(view);
    // No level is «better»: neutral tiles, Nuclear in red (never the Estricto orange).
    expect(study.levels?.map((o) => [o.label, o.tone])).toEqual([
      ['1 · Distracciones', 'neutral'],
      ['2 · Lista blanca', 'neutral'],
      ['Nuclear', 'red'],
    ]);
    expect(study.level).toBe('distractions');
    expect(study.levelDesc).toBe('Tras 3 strikes, durante 60 min; se aplica al momento');
    expect(study.nuclear).toBe(false);
    expect(study.duration).toEqual({ minutes: 60, min: 15, max: 120, step: 15 });
    expect(view.sistema.camera).toEqual({
      status: 'Sin usar',
      description: 'La pedirá el Study Mode; ninguna imagen sale de tu ordenador',
    });
    expect(ajustesTileKeys(view)).toEqual(expect.arrayContaining(['1', '2', 'a']));
  });

  it('lists what costs points, read-only', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW, settingsOf('ajustes'));
    expect(view.bloqueo.values).toEqual([
      { label: 'Intento bloqueado', value: '−10; si repites en 5 min, −20, −40… hasta −80' },
      { label: 'Strike del Study Mode', value: '−15' },
      { label: 'Castigo', value: '−100' },
      {
        label: 'Desbloqueo de emergencia',
        value: '−200 o la mitad del saldo si es más, y la racha',
      },
    ]);
    const off = settingsOf('ajustes');
    const view2 = deriveAjustesView(detailState('ajustes'), NOW, {
      ...off,
      settings: { ...off.settings, attemptPenalties: false },
    });
    expect(view2.bloqueo.values[0]?.value).toBe('Nada mientras las penalizaciones estén quitadas');
    expect(view2.bloqueo.guardianSettings[0]?.description).toBe('Los intentos no restan puntos');
  });

  it('shows the pending weakening changes, the shortcuts and the update (ajustes-full)', () => {
    const view = fullView();
    expect(view.general.dailyGoal).toMatchObject({
      value: '60 min',
      note: 'Pasará a 45 min en 24 h',
      // The tiles show what was asked for; 60 stays pressable and cancels the wait.
      selected: 45,
    });
    expect(view.general.dailyGoal?.options?.map((o) => o.help)).toEqual([
      'Bajarlo se aplicará en 24 h',
      'Ya pedido: se aplicará en 24 h',
      'Tu objetivo ahora: anula el cambio pedido',
      'Subirlo se aplica al momento',
    ]);
    expect(view.bloqueo.guardianSettings[0]).toMatchObject({
      field: 'attemptPenalties',
      // The switch shows «No» (asked for), the note when it applies; still on until then.
      value: false,
      effective: true,
      note: 'Se desactivará en 22 h',
    });
    expect(view.general.sounds).toMatchObject({
      ambient: 'rain',
      volume: 60,
      volumeLabel: '60 %',
      autoplay: true,
    });
    expect(view.general.osd).toBe(true);
    expect(view.general.shortcuts.map((r) => [r.title, r.label, r.description, r.tone])).toEqual([
      [
        'Atajo: mostrar Céntrate',
        'Ctrl+Alt+C',
        'Muestra u oculta la ventana desde cualquier app',
        'muted',
      ],
      ['Atajo: ampliar 15 min', 'Ctrl+Alt+E', 'Otra app ya usa este atajo: elige otro', 'orange'],
      ['Atajo: mini temporizador', '', 'Muestra u oculta el reloj pequeño', 'muted'],
    ]);
    expect(view.bloqueo.reminders).toEqual({
      schedules: true,
      schedulesDesc: '«Es tu hora de estudiar» 10 min antes de cada horario',
      eyeBreaks: true,
    });
    expect(view.sistema.title).toBe('Sistema: hay una versión nueva');
    expect(view.sistema.titleTone).toBe('blue');
    expect(view.sistema.updater).toEqual({
      status: 'nueva versión',
      tone: 'blue',
      description: 'v0.2.0 disponible; tienes la v0.1.0',
      action: { kind: 'download', label: 'Descargar ya', disabled: false, key: 'y' },
    });
    expect(view.sistema.activeWindow.status).toBe('Vigilando');
  });

  it('says how to record while a shortcut records', () => {
    const base = detailState('ajustes-full');
    const state = {
      ...base,
      detail: {
        ...base.detail,
        ajustes: { ...base.detail.ajustes, capturing: 'extend-15' as const },
      },
    };
    const row = deriveAjustesView(state, NOW).general.shortcuts[1];
    expect(row).toMatchObject({
      capturing: true,
      description: 'Pulsa la combinación · Retroceso lo quita · Esc cancela',
      tone: 'muted',
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

  it('offers «Instalar» without a guardian and says why its settings are missing (not-installed)', () => {
    const view = deriveAjustesView(mainState('not-installed'), NOW, null, {
      settingsError: 'El guardián no está instalado',
    });
    expect(view.sistema.title).toBe('Sistema: guardián no instalado');
    expect(view.sistema.guardian).toMatchObject({ status: 'No instalado', repair: 'Instalar' });
    expect(view.general.dailyGoal).toBeNull();
    expect(view.sistema.extensions).toEqual([]);
    expect(view.bloqueo.settingsStatus).toBe('El guardián no está instalado');
    expect(view.study).toBeNull();
    const study = deriveAjustesView(withStudy(mainState('not-installed')), NOW, null, {
      settingsError: 'El guardián no está instalado',
    });
    expect(studyOf(study).levelDesc).toBe('El guardián no está instalado');
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
    const view = deriveAjustesView(state, NOW, settingsOf('ajustes'));
    const rows = view.sistema.extensions;
    expect(rows.map((r) => [r.title, r.status, r.guide])).toEqual([
      ['Extensión en Firefox', 'Desconectada', 'extension-firefox'],
      ['Extensión en Edge', 'Sin permiso', 'extension-chromium'],
      ['Extensión en Brave', 'Falta incógnito', 'extension-incognito'],
    ]);
    // Three «Guía…» tiles, three different keys, none taken by another tile.
    expect(new Set(rows.map((r) => r.guideKey)).size).toBe(3);
    expect(duplicateKeys(ajustesTileKeys(view))).toEqual([]);
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
      withSnapshot(base, {
        prefs: { ...base.snapshot.prefs, theme: 'dark', autostart: false, defaultMode: 'strict' },
      }),
      NOW,
    );
    expect(view.general.theme).toBe('dark');
    expect(view.general.title).toBe('General: tema oscuro');
    expect(view.general.autostart).toBe(false);
    expect(view.bloqueo.title).toBe('Bloqueo: Estricto por defecto');
  });

  it('shows Nuclear with its honest note', () => {
    const settings = settingsOf('ajustes');
    const view = deriveAjustesView(withStudy(detailState('ajustes')), NOW, {
      ...settings,
      settings: { ...settings.settings, punishment: { level: 'nuclear', minutes: 90 } },
    });
    const study = studyOf(view);
    expect(study.level).toBe('nuclear');
    expect(study.nuclear).toBe(true);
    expect(study.levelDesc).toBe('Tras 3 strikes, durante 90 min; se aplica al momento');
    expect(study.duration?.minutes).toBe(90);
  });

  it('asks for Screen Recording when macOS withholds it, and names the last match', () => {
    const base = detailState('ajustes');
    const denied = deriveAjustesView(
      withSnapshot(base, { activeWindow: { status: 'needs-permission', lastMatch: null } }),
      NOW,
    );
    expect(denied.sistema.activeWindow).toEqual({
      status: 'Sin permiso',
      tone: 'orange',
      description: 'macOS pide el permiso de Grabación de pantalla',
      allowKey: 'v',
    });
    const matched = deriveAjustesView(
      withSnapshot(base, {
        activeWindow: { status: 'ok', lastMatch: { serviceId: 'youtube', at: NOW - 2 * MIN } },
      }),
      NOW,
    );
    expect(matched.sistema.activeWindow.description).toBe('Último intento: YouTube a las 16:58');
  });

  it('hides what the flags hide (Phase 1 flags)', () => {
    const base = detailState('ajustes-full');
    const view = deriveAjustesView(
      withSnapshot(base, { features: PHASE1_FEATURES }),
      NOW,
      settingsOf('ajustes-full'),
    );
    expect(view.general.sounds).toBeNull();
    expect(view.general.osd).toBeNull();
    expect(view.general.shortcuts.map((r) => r.action)).toEqual(['toggle-main', 'extend-15']);
    expect(view.bloqueo.reminders).toBeNull();
    expect(view.sistema.updater).toBeNull();
    expect(view.sistema.onboardingKey).toBeNull();
    expect(view.datos.export).toBeNull();
    expect(view.sistema.title).toBe('Sistema: todo en orden');
  });
});

describe('Ajustes updates row', () => {
  const base: UpdaterState = {
    status: 'idle',
    version: null,
    percent: null,
    checkedAt: null,
    error: null,
  };

  it('says each status and offers the next step', () => {
    const rows = (
      [
        { ...base },
        { ...base, status: 'checking' },
        { ...base, status: 'current', checkedAt: NOW - 30 * MIN },
        { ...base, status: 'available', version: '0.2.0' },
        { ...base, status: 'downloading', version: '0.2.0', percent: 45 },
        { ...base, status: 'ready', version: '0.2.0', percent: 100 },
        { ...base, status: 'error', error: 'network' },
        { ...base, status: 'unsupported' },
      ] satisfies UpdaterState[]
    ).map((u) => updaterRow(u, '0.1.0'));
    expect(rows.map((r) => [r.status, r.description, r.action?.label ?? null])).toEqual([
      ['sin comprobar', 'Tienes la v0.1.0', 'Comprobar ya'],
      ['comprobando…', 'Tienes la v0.1.0', 'Comprobando…'],
      ['al día', 'v0.1.0 es la última · comprobado a las 16:30', 'Comprobar ya'],
      ['nueva versión', 'v0.2.0 disponible; tienes la v0.1.0', 'Descargar ya'],
      ['descargando', 'Descargando v0.2.0 · 45 %', 'Descargando…'],
      [
        'lista para instalar',
        'v0.2.0 se instala al reiniciar; los bloqueos siguen',
        'Reiniciar y actualizar',
      ],
      [
        'no se ha podido comprobar',
        'Sin conexión o sin respuesta; prueba más tarde',
        'Comprobar ya',
      ],
      ['las gestiona tu sistema', 'Esta instalación se actualiza por su cuenta', null],
    ]);
    expect(rows.map((r) => r.action?.disabled ?? null)).toEqual([
      false,
      true,
      false,
      false,
      true,
      false,
      false,
      null,
    ]);
    expect(rows[5]?.action?.kind).toBe('install');
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
    expect(deriveAjustesView(state, NOW).general.dailyGoal).toMatchObject({
      value: '60 min',
      note: 'Pasará a 30 min en 23 h',
    });
  });

  it('only weakening changes wait 24 h', () => {
    expect(inLabel(24 * 60 * MIN)).toBe('en 24 h');
    // A change made just now: 24 h plus the guardian's whole-second stamp.
    expect(inLabel(24 * 60 * MIN + 900)).toBe('en 24 h');
    expect(inLabel(23 * 60 * MIN + 30 * MIN)).toBe('en 24 h');
    expect(inLabel(20_000)).toBe('en 1 min');
    expect(isWeakening('dailyGoalMinutes', 60, 30)).toBe(true);
    expect(isWeakening('dailyGoalMinutes', 30, 60)).toBe(false);
    expect(isWeakening('punishment', { level: 'nuclear' }, { level: 'distractions' })).toBe(false);
    expect(weakeningNote('closeBrowsersWithoutExtension', true, false)).toBe('Se aplicará en 24 h');
    expect(weakeningNote('closeBrowsersWithoutExtension', false, true)).toBeNull();
    expect(weakeningNote('attemptPenalties', true, false)).toBe('Se aplicará en 24 h');
  });

  it('says beforehand that switching a protection off waits', () => {
    const settings = settingsOf('ajustes');
    const rows = deriveAjustesView(detailState('ajustes'), NOW, {
      ...settings,
      settings: { ...settings.settings, closeBrowsersWithoutExtension: true },
    }).bloqueo.guardianSettings;
    expect(rows.map((r) => [r.title, r.value, r.description, r.note])).toEqual([
      ['Penalizaciones', true, 'Cada intento resta puntos; quitarlas tarda 24 h', null],
      [
        'Cerrar navegadores sin extensión',
        true,
        'Los cierra durante un bloqueo; quitarlo tarda 24 h',
        null,
      ],
    ]);
  });
});

describe('Ajustes Alt + letter', () => {
  it('gives every tile its own key, a letter of its label for the choices', () => {
    const view = fullView();
    expect(view.general.themeOptions.map((o) => [o.label, o.mnemonic])).toEqual([
      ['Sistema', 's'],
      ['Claro', 'c'],
      ['Oscuro', 'o'],
    ]);
    expect(view.general.languageOptions.map((o) => [o.label, o.mnemonic])).toEqual([
      ['Sistema', 't'],
      ['Español', 'p'],
      ['English', 'g'],
    ]);
    expect(view.bloqueo.modeOptions.map((o) => o.mnemonic)).toEqual(['n', 'e', 'h']);
    expect(view.general.dailyGoal?.options?.map((o) => o.mnemonic)).toEqual(['3', '4', '6', '9']);
    expect(view.study).toBeNull();
    expect(studyOf(fullStudyView()).levels?.map((o) => o.mnemonic)).toEqual(['1', '2', 'a']);
    expect(duplicateKeys(ajustesTileKeys(fullStudyView()))).toEqual([]);
    expect(view.sistema.guides.map((g) => [g.label, g.mnemonic])).toEqual([
      ['Chrome y Edge', 'm'],
      ['Firefox', 'f'],
      ['Incógnito', 'i'],
    ]);
    const keys = ajustesTileKeys(view);
    expect(keys.every((k) => typeof k === 'string' && k.length === 1)).toBe(true);
    expect(duplicateKeys(keys)).toEqual([]);
  });

  it('gives every English tile its own key, a letter of its label for the choices', () => {
    const view = withLocale('en', () => fullStudyView());
    for (const o of [
      ...view.general.themeOptions,
      ...view.general.languageOptions,
      ...view.bloqueo.modeOptions,
      ...(view.general.dailyGoal?.options ?? []),
      ...(view.study?.levels ?? []),
      ...view.sistema.guides,
    ]) {
      expect(o.label.toLowerCase(), o.label).toContain(o.mnemonic);
    }
    expect(duplicateKeys(ajustesTileKeys(view))).toEqual([]);
  });

  it('keeps the fixed letters in their labels where the label has one free', () => {
    for (const [locale, A] of [
      ['es', AJUSTES_ES],
      ['en', AJUSTES_EN],
    ] as const) {
      withLocale(locale, () => {
        const K = AJUSTES_KEYS;
        const inLabel = (label: string, key: string): void =>
          expect(label.toLowerCase(), `${locale}: ${label}`).toContain(key);
        inLabel(A.sistema.repair, K.repair);
        inLabel(A.sistema.pairingNew, K.pairingNew);
        inLabel(A.sistema.activeWindow.allow, K.activeWindow);
        inLabel(A.sistema.updater.actions.check, K.updater);
        inLabel(A.sistema.updater.actions.download, K.updater);
        inLabel(A.sistema.updater.actions.install, K.updater);
        inLabel(A.sistema.onboarding.action, K.onboarding);
        inLabel(A.sistema.diagnosticsCopy, K.diagnostics);
        inLabel(A.datos.exportEvents, K.exportEvents);
        inLabel(A.datos.deleteButton, K.delete);
      });
    }
  });

  it('shows the language row and saves the choice (Sistema by default)', () => {
    const view = deriveAjustesView(detailState('ajustes'), NOW);
    expect(view.general.language).toBe('system');
    expect(view.general.languageOptions.map((o) => o.value)).toEqual(['system', 'es', 'en']);
    const en = withLocale('en', () => deriveAjustesView(detailState('ajustes'), NOW));
    expect(en.general.title).toBe('General: system theme');
    expect(en.sistema.title).toBe('System: all good');
  });
});

describe('Ajustes rows stay 48 px (one line of description)', () => {
  it('keeps the descriptions beside three or four tiles short', () => {
    for (const locale of ['es', 'en'] as const) {
      const view = withLocale(locale, () => fullView());
      for (const o of [
        ...view.general.themeOptions,
        ...view.general.languageOptions,
        ...view.bloqueo.modeOptions,
        ...(view.general.dailyGoal?.options ?? []),
      ]) {
        expect(o.help.length, `${locale}: ${o.label}`).toBeLessThanOrEqual(56);
      }
      expect((view.general.dailyGoal?.note ?? '').length).toBeLessThanOrEqual(46);
    }
  });

  it('keeps the other descriptions to one line beside their control', () => {
    for (const locale of ['es', 'en'] as const) {
      const view = withLocale(locale, () => fullView());
      const texts = [
        ...view.general.shortcuts.map((r) => r.description),
        ...view.bloqueo.guardianSettings.map((r) => r.description),
        view.bloqueo.reminders?.schedulesDesc ?? '',
        view.sistema.activeWindow.description,
        view.sistema.updater?.description ?? '',
        ...view.bloqueo.values.map((v) => `${v.label}  ${v.value}`),
      ];
      for (const text of texts) expect(text.length, `${locale}: ${text}`).toBeLessThanOrEqual(80);
    }
  });
});
