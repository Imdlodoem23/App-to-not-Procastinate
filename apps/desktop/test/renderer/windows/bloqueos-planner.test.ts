/**
 * Phase 5 of the Bloqueos window (PLANNER): the schedule editor (guards, weakening, the request
 * body, the guardian's refusals), the exam whitelist (checks with the shared helpers, the full
 * settings body that keeps pending changes, pending additions with their date) and the view of
 * both per fixture, in Spanish and English.
 */
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@centrate/shared/domain';
import { emptyAllow, emptyTargets, type SettingsResponse } from '@centrate/shared/guardian-api';
import {
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  fixtureUiState,
  harnessFixture,
  makeSchedules,
  makeSettings,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { uiError, type UiState } from '../../../src/shared/ui-state';
import {
  editorFor,
  formAddsTargets,
  mergeTargets,
  newScheduleInput,
  scheduleAutoName,
  scheduleChips,
  scheduleDeleteLock,
  scheduleEditWeakens,
  scheduleErrorText,
  scheduleFrozenStart,
  scheduleProblem,
  scheduleProblemText,
  scheduleToInput,
  scheduleWindowLabel,
  toScheduleRequest,
  upsertSchedule,
  withDay,
  withScheduleCategory,
  withScheduleMode,
  withoutSchedule,
  withoutScheduleTarget,
} from '../../../src/renderer/src/windows/bloqueos/schedule-editor';
import {
  clockLabel,
  parseClockText,
  scheduleRow,
  scheduleSummary,
} from '../../../src/renderer/src/windows/bloqueos/schedules';
import {
  addedNotice,
  checkWhitelistDomain,
  checkWhitelistProcess,
  targetSettings,
  whitelistErrorText,
  whitelistLists,
  whitelistSuggestions,
  whitelistView,
  withWhitelistEntry,
  withoutWhitelistEntry,
} from '../../../src/renderer/src/windows/bloqueos/whitelist';
import {
  BLOQUEOS_KEYS,
  deriveBloqueosView,
  type BloqueosData,
  type BloqueosView,
} from '../../../src/renderer/src/windows/bloqueos/view';
import { duplicateKeys } from '../../../src/renderer/src/windows/bloqueos/mnemonics';

const NOW = HARNESS_NOW;
const MIN = 60_000;

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

function readyData(id: HarnessStateId): BloqueosData {
  const fixture = harnessFixture(id);
  return {
    schedules: { status: 'ready', list: fixture.fake.schedules },
    pendingSchedules: {},
    processNames: fixture.fake.processNames,
    settings: { status: 'ready', value: fixture.fake.settings },
  };
}

function evening(): Schedule {
  const [first] = makeSchedules(NOW);
  if (!first) throw new Error('fixture without schedules');
  return first;
}

/** `evening()` whose next occurrence starts in `minutes`. */
function startingIn(minutes: number): Schedule {
  const s = evening();
  return {
    ...s,
    nextOccurrence: {
      startsAt: new Date(NOW + minutes * MIN).toISOString(),
      endsAt: new Date(NOW + (minutes + 120) * MIN).toISOString(),
    },
  };
}

describe('schedule clock times', () => {
  it('reads what people type as HH:MM', () => {
    expect(parseClockText('16:00')).toBe('16:00');
    expect(parseClockText(' 9 ')).toBe('09:00');
    expect(parseClockText('1630')).toBe('16:30');
    expect(parseClockText('16.30')).toBe('16:30');
    expect(parseClockText('16h30')).toBe('16:30');
    expect(parseClockText('4 PM')).toBe('16:00');
    expect(parseClockText('4:30 pm')).toBe('16:30');
    expect(parseClockText('12 am')).toBe('00:00');
    expect(parseClockText('12 p.m.')).toBe('12:00');
    for (const bad of ['', '24:00', '16:60', '13 pm', 'tarde', '7:5']) {
      expect(parseClockText(bad), bad).toBeNull();
    }
  });

  it('shows the locale clock', () => {
    expect(clockLabel('16:00')).toBe('16:00');
    withLocale('en', () => expect(clockLabel('16:00')).toBe('4:00 PM'));
    expect(clockLabel('abc')).toBe('abc');
  });

  it('says how long the window lasts, overnight too', () => {
    expect(scheduleWindowLabel({ start: '16:00', end: '19:00' })).toBe('Dura 3 h');
    expect(scheduleWindowLabel({ start: '22:00', end: '06:30' })).toBe(
      'Dura 8 h 30 min: acaba al día siguiente',
    );
    expect(scheduleWindowLabel({ start: '16:00', end: '16:00' })).toBeNull();
    expect(scheduleWindowLabel({ start: 'x', end: '16:00' })).toBeNull();
  });
});

describe('schedule editor input', () => {
  it('opens a new schedule as «L–V 16:00–19:00» with the form’s targets', () => {
    const social = { ...emptyTargets(), categoryIds: ['social' as const] };
    const input = newScheduleInput({ timezone: 'Europe/Madrid', mode: 'strict', targets: social });
    expect(input).toMatchObject({
      name: '',
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: '16:00',
      end: '19:00',
      timezone: 'Europe/Madrid',
      mode: 'strict',
      whitelistOnly: false,
      acknowledgeNoEmergency: false,
    });
    expect(input.targets.categoryIds).toEqual(['social']);
    expect(input.targets).not.toBe(social);
    expect(scheduleSummary(input)).toBe('L–V 16:00–19:00 · Redes sociales');
    expect(newScheduleInput({ timezone: 'UTC', mode: 'normal' }).targets).toEqual(emptyTargets());
  });

  it('copies a saved schedule field by field', () => {
    const s = evening();
    const input = scheduleToInput(s);
    expect(input).toMatchObject({ name: 'Tardes de estudio', start: '18:00', end: '20:00' });
    expect(input.days).not.toBe(s.days);
    expect(editorFor(s)).toEqual({ id: s.id, input, error: null });
  });

  it('edits days, categories, extras and the mode', () => {
    let input = newScheduleInput({ timezone: 'UTC', mode: 'normal' });
    input = withDay(input, 7, true);
    input = withDay(input, 1, false);
    expect(input.days).toEqual([2, 3, 4, 5, 7]);
    expect(withDay(input, 2, true)).toBe(input);
    input = withScheduleCategory(input, 'video', true);
    expect(input.targets.categoryIds).toEqual(['video']);
    input = {
      ...input,
      targets: mergeTargets(input.targets, {
        ...emptyTargets(),
        serviceIds: ['youtube', 'instagram'],
        customDomains: ['apuntes.es'],
        appIds: ['discord'],
      }),
    };
    // YouTube is already in «Vídeo y streaming».
    expect(input.targets.serviceIds).toEqual(['instagram']);
    expect(scheduleChips(input.targets).map((c) => c.label)).toEqual([
      'Instagram',
      'Discord',
      'apuntes.es',
    ]);
    input = withoutScheduleTarget(input, {
      kind: 'domain',
      key: 'apuntes.es',
      label: 'apuntes.es',
    });
    expect(input.targets.customDomains).toEqual([]);
    expect(formAddsTargets(input.targets, { ...emptyTargets(), serviceIds: ['instagram'] })).toBe(
      false,
    );
    expect(formAddsTargets(input.targets, { ...emptyTargets(), serviceIds: ['netflix'] })).toBe(
      false,
    );
    expect(formAddsTargets(input.targets, { ...emptyTargets(), serviceIds: ['twitch'] })).toBe(
      false,
    );
    expect(formAddsTargets(input.targets, { ...emptyTargets(), customDomains: ['a.es'] })).toBe(
      true,
    );
    const exam = withScheduleMode(input, 'exam');
    expect(exam.whitelistOnly).toBe(true);
    expect(scheduleSummary(exam)).toBe('M–V, D 16:00–19:00 · Todo salvo la lista blanca');
    expect(withScheduleMode(exam, 'hardcore').whitelistOnly).toBe(false);
  });

  it('names a schedule left without a name', () => {
    const input = newScheduleInput({
      timezone: 'UTC',
      mode: 'normal',
      targets: { ...emptyTargets(), categoryIds: ['social'] },
    });
    expect(scheduleAutoName(input)).toBe('Redes sociales · L–V');
    expect(scheduleAutoName({ ...input, days: [] })).toBe('Redes sociales · sin días');
  });
});

describe('schedule guards', () => {
  it('finds the 10 minutes before a start', () => {
    expect(scheduleFrozenStart(evening(), NOW)).toBeNull();
    expect(scheduleFrozenStart(startingIn(10), NOW)).toBe(NOW + 10 * MIN);
    expect(scheduleFrozenStart(startingIn(11), NOW)).toBeNull();
    expect(scheduleFrozenStart({ ...startingIn(5), enabled: false }, NOW)).toBeNull();
  });

  it('tells weakening edits from strengthening ones', () => {
    const s = evening();
    const same = scheduleToInput(s);
    expect(scheduleEditWeakens(s, same)).toBe(false);
    // Strengthening: a day more, a longer window, more targets, a stricter mode, a new name.
    expect(scheduleEditWeakens(s, { ...same, days: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(scheduleEditWeakens(s, { ...same, start: '17:00', end: '21:00' })).toBe(false);
    expect(scheduleEditWeakens(s, withScheduleCategory(same, 'games', true))).toBe(false);
    expect(scheduleEditWeakens(s, { ...same, mode: 'strict' })).toBe(false);
    expect(scheduleEditWeakens(s, { ...same, name: 'Otro', reason: 'x' })).toBe(false);
    expect(scheduleEditWeakens(s, withScheduleMode(same, 'exam'))).toBe(false);
    // Weakening.
    expect(scheduleEditWeakens(s, { ...same, enabled: false })).toBe(true);
    expect(scheduleEditWeakens(s, { ...same, days: [1, 2, 3, 4] })).toBe(true);
    expect(scheduleEditWeakens(s, { ...same, start: '18:30' })).toBe(true);
    expect(scheduleEditWeakens(s, { ...same, end: '19:59' })).toBe(true);
    expect(scheduleEditWeakens(s, withScheduleCategory(same, 'social', false))).toBe(true);
    expect(scheduleEditWeakens({ ...s, mode: 'strict' }, same)).toBe(true);
    expect(scheduleEditWeakens(s, { ...same, timezone: 'UTC' })).toBe(true);
    // A service replaced by its category is not a loss.
    const yt: Schedule = { ...s, targets: { ...emptyTargets(), serviceIds: ['youtube'] } };
    expect(
      scheduleEditWeakens(yt, {
        ...scheduleToInput(yt),
        targets: { ...emptyTargets(), categoryIds: ['video'] },
      }),
    ).toBe(false);
    // Leaving an exam schedule, or allowing more in it.
    const exam: Schedule = {
      ...s,
      mode: 'exam',
      whitelistOnly: true,
      targets: emptyTargets(),
      allow: emptyAllow(),
    };
    expect(scheduleEditWeakens(exam, { ...scheduleToInput(exam), mode: 'hardcore' })).toBe(true);
    expect(
      scheduleEditWeakens(exam, {
        ...scheduleToInput(exam),
        allow: { customDomains: ['a.es'], customProcesses: [] },
      }),
    ).toBe(true);
  });

  it('refuses in the editor what the guardian would refuse, input first', () => {
    const s = evening();
    const input = scheduleToInput(s);
    expect(scheduleProblem(input, s, NOW, 2)).toBeNull();
    expect(scheduleProblem({ ...input, days: [] }, s, NOW, 2)).toBe('no_days');
    expect(scheduleProblem({ ...input, start: '25' }, s, NOW, 2)).toBe('bad_start');
    expect(scheduleProblem({ ...input, end: 'luego' }, s, NOW, 2)).toBe('bad_end');
    expect(scheduleProblem({ ...input, end: '18:00' }, s, NOW, 2)).toBe('same_time');
    expect(scheduleProblem({ ...input, end: '18:04' }, s, NOW, 2)).toBe('too_short');
    expect(scheduleProblem({ ...input, targets: emptyTargets() }, s, NOW, 2)).toBe('no_targets');
    expect(
      scheduleProblem(withScheduleMode({ ...input, targets: emptyTargets() }, 'exam'), s, NOW, 2),
    ).toBeNull();
    expect(scheduleProblem({ ...input, name: 'x'.repeat(61) }, s, NOW, 2)).toBe('name_long');
    const running = { ...s, activeBlockId: 'blk_fixture0000000001' as const };
    expect(scheduleProblem(input, running, NOW, 2)).toBe('running');
    const soon = startingIn(8);
    expect(scheduleProblem({ ...scheduleToInput(soon), days: [1] }, soon, NOW, 2)).toBe(
      'starting_soon',
    );
    expect(scheduleProblemText('starting_soon', soon, NOW)).toBe(
      'Empieza a las 17:08: a menos de 10 min solo se puede endurecer',
    );
    // Strengthening goes through even then.
    expect(
      scheduleProblem({ ...scheduleToInput(soon), mode: 'hardcore' }, soon, NOW, 2),
    ).toBeNull();
    expect(scheduleProblem(input, null, NOW, 50)).toBe('full');
    expect(scheduleProblemText('full', null, NOW)).toBe(
      'Ya tienes 50 horarios: borra alguno antes',
    );
  });

  it('locks «Borrar» while running and in the last 10 minutes', () => {
    expect(scheduleDeleteLock(evening(), NOW)).toBeNull();
    expect(scheduleDeleteLock({ ...evening(), activeBlockId: 'blk_fixture0000000001' }, NOW)).toBe(
      'En curso: podrás cambiarlo cuando acabe',
    );
    expect(scheduleDeleteLock(startingIn(3), NOW)).toBe(
      'Empieza a las 17:03: a menos de 10 min ya no se puede borrar',
    );
  });

  it('marks the row being edited and locks «Editar» while it runs', () => {
    const s = evening();
    expect(scheduleRow(s, NOW, undefined, { editing: true, editKey: 'l' })).toMatchObject({
      description: 'Editando…',
      editing: true,
      editKey: 'l',
      editLock: null,
    });
    expect(
      scheduleRow({ ...s, activeBlockId: 'blk_fixture0000000001' }, NOW, undefined).editLock,
    ).toBe('En curso: podrás cambiarlo cuando acabe');
  });
});

describe('schedule requests and answers', () => {
  it('sends clean HH:MM times, an exam as a whitelist, and the acknowledgement', () => {
    const input = {
      ...newScheduleInput({
        timezone: 'Europe/Madrid',
        mode: 'hardcore',
        targets: { ...emptyTargets(), categoryIds: ['games'] },
      }),
      start: '9',
      end: '1330',
      days: [5, 1, 5] as Schedule['days'],
      reason: '  estudiar  ',
    };
    const body = toScheduleRequest(input, true);
    expect(body).toMatchObject({
      name: 'Juegos · L, V',
      start: '09:00',
      end: '13:30',
      days: [1, 5],
      reason: 'estudiar',
      whitelistOnly: false,
      acknowledgeNoEmergency: true,
    });
    expect(toScheduleRequest({ ...input, mode: 'normal' }, true).acknowledgeNoEmergency).toBe(
      false,
    );
    expect(toScheduleRequest(input, false).acknowledgeNoEmergency).toBe(false);
    const exam = toScheduleRequest(withScheduleMode(input, 'exam'), true);
    expect(exam).toMatchObject({ mode: 'exam', whitelistOnly: true, targets: emptyTargets() });
    expect(exam.acknowledgeNoEmergency).toBe(true);
  });

  it('turns the guardian’s refusals into what to do', () => {
    const inProgress = uiError('rejected', 'schedule_in_progress', 409, {
      blockId: 'blk_x',
      endsAt: new Date(NOW + 120 * MIN).toISOString(),
    });
    expect(scheduleErrorText(inProgress, NOW)).toBe(
      'En curso hasta las 19:00: podrás cambiarlo cuando acabe',
    );
    const soon = uiError('rejected', 'schedule_starting_soon', 409, {
      startsAt: new Date(NOW + 6 * MIN).toISOString(),
    });
    expect(scheduleErrorText(soon, NOW)).toBe(
      'Empieza a las 17:06: a menos de 10 min solo se puede endurecer',
    );
    expect(scheduleErrorText(soon, NOW, 'delete')).toBe(
      'Empieza a las 17:06: a menos de 10 min ya no se puede borrar',
    );
    expect(scheduleErrorText(uiError('rejected', 'too_many_targets', 422), NOW)).toBe(
      'Tus horarios ya tienen demasiadas webs propias',
    );
    expect(scheduleErrorText(uiError('timeout'), NOW)).toBe('El guardián no responde');
    expect(scheduleErrorText(uiError('internal', 'not_implemented', 501), NOW)).toBe(
      'Algo ha fallado en el guardián',
    );
    withLocale('en', () =>
      expect(scheduleErrorText(soon, NOW)).toBe(
        'Starts at 5:06 PM: under 10 min before, it can only be made stricter',
      ),
    );
  });

  it('keeps the list in step with the writes', () => {
    const list = makeSchedules(NOW);
    const [a, b] = list as [Schedule, Schedule];
    const changed = { ...a, name: 'Cambiado' };
    expect(upsertSchedule(list, changed).map((s) => s.name)).toEqual([
      'Cambiado',
      'Sábados sin juegos',
    ]);
    const added = { ...a, id: 'sch_new00000000000001' as const };
    expect(upsertSchedule(list, added)).toHaveLength(3);
    expect(withoutSchedule(list, b.id)).toEqual([a]);
  });
});

const EXAM = harnessFixture('exam-whitelist').fake.settings;

describe('exam whitelist', () => {
  it('builds the PUT from the settings as they will be (pending changes kept)', () => {
    const response = makeSettings({ dailyGoalMinutes: 60 }, [
      { field: 'dailyGoalMinutes', value: 45, effectiveAt: new Date(NOW + 60 * MIN).toISOString() },
      ...EXAM.pending,
    ]);
    const target = targetSettings(response);
    expect(target.dailyGoalMinutes).toBe(45);
    expect(target.studyWhitelist.extraDomains).toEqual([
      'wikipedia.org',
      'khanacademy.org',
      'geogebra.org',
    ]);
    // The response itself is never changed.
    expect(response.settings.dailyGoalMinutes).toBe(60);
    const added = withWhitelistEntry(EXAM, 'domain', 'deepl.com');
    expect(added.studyWhitelist.extraDomains).toEqual([
      'wikipedia.org',
      'khanacademy.org',
      'geogebra.org',
      'deepl.com',
    ]);
    expect(added.studyWhitelist.extraProcesses).toEqual(['WINWORD.EXE']);
    // Removing a pending addition sends the effective list: the guardian cancels it.
    expect(
      withoutWhitelistEntry(EXAM, 'domain', 'geogebra.org').studyWhitelist.extraDomains,
    ).toEqual(EXAM.settings.studyWhitelist.extraDomains);
    expect(
      withoutWhitelistEntry(EXAM, 'process', 'WINWORD.EXE').studyWhitelist.extraProcesses,
    ).toEqual([]);
  });

  it('shows the extras, the pending one dashed with its date', () => {
    const view = whitelistView({ status: 'ready', value: EXAM }, NOW);
    expect(view.title).toBe('Tu lista blanca: 3 extras · 1 esperando');
    expect(view.entries.map((e) => [e.label, e.pendingWhen])).toEqual([
      ['wikipedia.org', null],
      ['khanacademy.org', null],
      ['geogebra.org · desde mañana 16:10', 'mañana 16:10'],
      ['WINWORD.EXE', null],
    ]);
    expect(view.entries[2]?.removeLabel).toBe('Quitar geogebra.org (se permitiría mañana 16:10)');
    expect(whitelistView({ status: 'loading' }, NOW).title).toBe('Tu lista blanca: cargando…');
    const failed = whitelistView({ status: 'error', error: uiError('timeout') }, NOW);
    expect(failed.title).toBe('Tu lista blanca: sin conexión');
    expect(failed.error?.kind).toBe('timeout');
    expect(whitelistView({ status: 'ready', value: makeSettings() }, NOW).title).toBe(
      'Tu lista blanca: solo la de estudio',
    );
  });

  it('checks webs with the shared helpers and refuses distractions with the reason', () => {
    const lists = whitelistLists(EXAM);
    expect(checkWhitelistDomain('https://www.Apuntes-Ejemplo.es/tema', lists)).toEqual({
      ok: true,
      value: 'www.apuntes-ejemplo.es',
    });
    // Already a study site (the fixture's «deepl.com» too).
    expect(checkWhitelistDomain('deepl.com', lists)).toEqual({
      ok: false,
      error: 'Ya está en la lista de estudio',
    });
    expect(checkWhitelistDomain('youtube.com', lists)).toEqual({
      ok: false,
      error: 'youtube.com es de YouTube: una distracción no puede ir en la lista blanca',
    });
    expect(checkWhitelistDomain('m.youtube.com', lists)).toMatchObject({ ok: false });
    expect(checkWhitelistDomain('googleapis.com', lists)).toEqual({
      ok: false,
      error: 'googleapis.com incluye YouTube: escribe una web más concreta',
    });
    expect(checkWhitelistDomain('co.uk', lists)).toEqual({
      ok: false,
      error: 'co.uk es demasiado general: escribe una web concreta',
    });
    expect(checkWhitelistDomain('no es una web', lists)).toEqual({
      ok: false,
      error: 'Eso no parece una web: prueba con wikipedia.org',
    });
    expect(checkWhitelistDomain('moodle.org', lists)).toEqual({
      ok: false,
      error: 'Ya está en la lista de estudio',
    });
    const own = { domains: ['apuntes-ejemplo.es'], processes: [] };
    expect(checkWhitelistDomain('apuntes-ejemplo.es', own)).toEqual({
      ok: false,
      error: 'Ya está en tu lista',
    });
    expect(checkWhitelistDomain('tema1.apuntes-ejemplo.es', own)).toEqual({
      ok: false,
      error: 'Ya la permite apuntes-ejemplo.es',
    });
    expect(checkWhitelistDomain('windowsupdate.com', lists)).toEqual({
      ok: false,
      error: 'Eso ya se permite siempre: el sistema lo necesita',
    });
  });

  it('checks apps, refusing distraction apps and what the system needs', () => {
    const lists = whitelistLists(EXAM);
    expect(checkWhitelistProcess('Mathematica.exe', lists, 'win')).toEqual({
      ok: true,
      value: 'Mathematica.exe',
    });
    expect(checkWhitelistProcess('GeoGebra.exe', lists, 'win')).toEqual({
      ok: false,
      error: 'Ya está en la lista de estudio',
    });
    expect(checkWhitelistProcess('steam.exe', lists, 'win')).toEqual({
      ok: false,
      error: 'Steam es una distracción: no puede ir en la lista blanca',
    });
    expect(
      checkWhitelistProcess(
        'mathematica.EXE',
        { domains: [], processes: ['Mathematica.exe'] },
        'win',
      ),
    ).toEqual({ ok: false, error: 'Ya está en tu lista' });
    expect(checkWhitelistProcess('explorer.exe', lists, 'win')).toEqual({
      ok: false,
      error: 'Ese programa ya se permite siempre: el sistema lo necesita',
    });
    expect(checkWhitelistProcess('a/b.exe', lists, 'win')).toEqual({
      ok: false,
      error: 'Escribe el nombre del programa, por ejemplo WINWORD.EXE',
    });
  });

  it('suggests running programs that pass every check', () => {
    const lists = whitelistLists(EXAM);
    const running = [
      'steam.exe',
      'Mathematica.exe',
      'mathematica.exe',
      'explorer.exe',
      'GeoGebra.exe',
    ];
    expect(whitelistSuggestions('', running, lists, 'win')).toEqual([]);
    expect(whitelistSuggestions('mat', running, lists, 'win')).toEqual(['Mathematica.exe']);
    // Distractions, system programs and study apps are never offered.
    expect(whitelistSuggestions('e', running, lists, 'win')).toEqual(['Mathematica.exe']);
  });

  it('says whether an addition applies now or waits its 24 h', () => {
    const now = makeSettings({
      studyWhitelist: { extraDomains: ['deepl.com'], extraProcesses: [] },
    });
    expect(addedNotice(now, 'domain', 'deepl.com', NOW)).toEqual({
      text: 'Permitida: deepl.com',
      tone: 'green',
    });
    const waiting: SettingsResponse = makeSettings({}, [
      {
        field: 'studyWhitelist.extraDomains',
        value: ['deepl.com'],
        effectiveAt: new Date(NOW + 24 * 60 * MIN).toISOString(),
      },
    ]);
    expect(addedNotice(waiting, 'domain', 'deepl.com', NOW)).toEqual({
      text: 'deepl.com se permitirá mañana 17:00: lo que afloja espera 24 h',
      tone: 'muted',
    });
  });

  it('turns the guardian’s refusal into its reason', () => {
    const refused = uiError('rejected', 'allow_distraction', 422, {
      path: 'studyWhitelist.extraDomains[3]',
      reason: 'service_domain',
      serviceId: 'tiktok',
      appId: null,
    });
    expect(whitelistErrorText(refused, 'tiktok.com')).toBe(
      'tiktok.com es de TikTok: una distracción no puede ir en la lista blanca',
    );
    expect(whitelistErrorText(uiError('rejected', 'allow_distraction', 422, {}), 'x.es')).toBe(
      'x.es es una distracción: no puede ir en la lista blanca',
    );
    expect(whitelistErrorText(uiError('timeout'), 'x.es')).toBe('El guardián no responde');
  });
});

/** Every Alt + letter a Bloqueos view shows at once. */
function visibleKeys(view: BloqueosView): (string | undefined)[] {
  const editor = view.schedules.editor;
  return [
    BLOQUEOS_KEYS.addDomain,
    BLOQUEOS_KEYS.addApp,
    ...view.duration.presets.map((p) => p.mnemonic),
    ...view.mode.options.map((o) => o.mnemonic),
    BLOQUEOS_KEYS.save,
    BLOQUEOS_KEYS.block,
    ...view.templates.rows.flatMap((r) => [r.useKey, r.removeKey]),
    ...view.schedules.rows.map((r) => r.editKey),
    view.schedules.canCreate ? BLOQUEOS_KEYS.newSchedule : undefined,
    ...(editor
      ? [
          ...editor.modes.map((m) => m.mnemonic),
          editor.keys.save,
          editor.remove ? editor.keys.remove : undefined,
          editor.keys.cancel,
        ]
      : []),
    ...view.exam.tiles.map((t) => t.mnemonic),
    BLOQUEOS_KEYS.customize,
    BLOQUEOS_KEYS.allowDomain,
    BLOQUEOS_KEYS.allowApp,
  ];
}

describe('Bloqueos view with the planner', () => {
  it('opens the new schedule of the `schedules` fixture', () => {
    const view = deriveBloqueosView(detailState('schedules'), NOW, readyData('schedules'));
    expect(view.schedules.canCreate).toBe(false);
    const editor = view.schedules.editor;
    expect(editor).toMatchObject({
      id: null,
      title: 'Nuevo horario: L–V 16:00–19:00 · Redes sociales',
      name: 'Tardes sin redes',
      start: '16:00',
      end: '19:00',
      times: { text: 'Dura 3 h', tone: 'muted' },
      whitelist: null,
      mode: 'normal',
      consequence: null,
      problem: null,
      error: null,
      remove: null,
    });
    expect(editor?.days.map((d) => d.checked)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(editor?.days[2]).toMatchObject({ short: 'X', long: 'miércoles' });
    expect(editor?.categories.filter((c) => c.checked).map((c) => c.name)).toEqual([
      'Redes sociales',
    ]);
    expect(editor?.chips).toEqual([]);
    expect(editor?.fromForm).toBe(false);
  });

  it('edits a saved schedule: its row says so and «Borrar» joins', () => {
    const state = detailState('bloqueos');
    const s = evening();
    const editing: UiState = {
      ...state,
      detail: { ...state.detail, bloqueos: { ...state.detail.bloqueos, schedule: editorFor(s) } },
    };
    const view = deriveBloqueosView(editing, NOW, readyData('bloqueos'));
    expect(view.schedules.rows[0]).toMatchObject({ editing: true, description: 'Editando…' });
    expect(view.schedules.editor).toMatchObject({
      id: s.id,
      title: 'Editar: L–V 18:00–20:00 · Redes sociales',
      remove: {
        lock: null,
        consequence: 'Se borra «Tardes de estudio»; lo que ya empezó sigue hasta el final',
      },
    });
    const hardcore: UiState = {
      ...editing,
      detail: {
        ...editing.detail,
        bloqueos: {
          ...editing.detail.bloqueos,
          schedule: {
            ...editorFor(s),
            input: { ...scheduleToInput(s), mode: 'hardcore' },
            error: uiError('rejected', 'schedule_starting_soon', 409, {
              startsAt: new Date(NOW + 4 * MIN).toISOString(),
            }),
          },
        },
      },
    };
    const hard = deriveBloqueosView(hardcore, NOW, {
      ...readyData('bloqueos'),
      scheduleSaving: true,
    });
    expect(hard.schedules.editor).toMatchObject({
      consequence: 'Cuando empiece, no podrás cancelarlo de ninguna forma hasta que acabe',
      error: 'Empieza a las 17:04: a menos de 10 min solo se puede endurecer',
      saving: true,
    });
  });

  it('reports bad times on the times line', () => {
    const state = detailState('schedules');
    const editor = state.detail.bloqueos.schedule;
    if (!editor) throw new Error('fixture without an editor');
    const bad: UiState = {
      ...state,
      detail: {
        ...state.detail,
        bloqueos: {
          ...state.detail.bloqueos,
          schedule: { ...editor, input: { ...editor.input, end: '99' } },
        },
      },
    };
    const view = deriveBloqueosView(bad, NOW, readyData('schedules'));
    expect(view.schedules.editor?.times).toEqual({
      text: 'Escribe la hora de fin así: 19:00',
      tone: 'orange',
    });
    expect(view.schedules.editor?.problem).toBe('Escribe la hora de fin así: 19:00');
  });

  it('shows the exam whitelist of `exam-whitelist`, with suggestions from running programs', () => {
    const state = detailState('exam-whitelist');
    const view = deriveBloqueosView(state, NOW, readyData('exam-whitelist'));
    expect(view.exam.whitelist.title).toBe('Tu lista blanca: 3 extras · 1 esperando');
    expect(view.exam.whitelist.entries).toHaveLength(4);
    expect(view.exam.whitelist.saving).toBe(false);
    const typing: UiState = {
      ...state,
      detail: {
        ...state.detail,
        bloqueos: { ...state.detail.bloqueos, exam: { domainInput: '', processInput: 'spo' } },
      },
    };
    const suggested = deriveBloqueosView(typing, NOW, readyData('exam-whitelist'));
    expect(suggested.exam.whitelist.suggestions).toEqual(['Spotify.exe']);
    // Loading until the settings arrive (the root carries `data-loading` meanwhile).
    const loading = deriveBloqueosView(state, NOW, {
      ...readyData('exam-whitelist'),
      settings: undefined,
    });
    expect(loading.exam.whitelist.status).toBe('loading');
  });

  it('gives every visible tile a key, unique in the window, in every fixture and language', () => {
    for (const locale of ['es', 'en'] as const) {
      withLocale(locale, () => {
        for (const id of HARNESS_STATE_IDS) {
          const view = deriveBloqueosView(detailState(id), NOW, readyData(id));
          const keys = visibleKeys(view);
          expect(duplicateKeys(keys), `${locale} ${id}`).toEqual([]);
          expect(
            view.schedules.rows.every((r) => r.editKey),
            `${locale} ${id}: «Editar» keys`,
          ).toBe(true);
          const editor = view.schedules.editor;
          if (editor) {
            expect(
              editor.modes.every((m) => m.mnemonic),
              `${locale} ${id}: modes`,
            ).toBe(true);
            expect(editor.keys.save && editor.keys.cancel, `${locale} ${id}`).toBeTruthy();
          }
        }
      });
    }
  });

  it('speaks English', () => {
    withLocale('en', () => {
      const view = deriveBloqueosView(detailState('schedules'), NOW, readyData('schedules'));
      expect(view.schedules.editor?.title).toBe(
        'New schedule: Mo–Fr 4:00 PM–7:00 PM · Social media',
      );
      expect(view.schedules.editor?.times.text).toBe('Lasts 3 h');
      const exam = deriveBloqueosView(
        detailState('exam-whitelist'),
        NOW,
        readyData('exam-whitelist'),
      );
      expect(exam.exam.whitelist.title).toBe('Your allowlist: 3 extras · 1 waiting');
      expect(exam.exam.whitelist.entries[2]?.label).toBe('geogebra.org · from tomorrow 4:10 PM');
    });
  });
});
