import { describe, expect, it } from 'vitest';
import { emptyTargets } from '@centrate/shared/guardian-api';
import type { Schedule } from '@centrate/shared/domain';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  makeSchedules,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withMode, type UiState } from '../../../src/shared/ui-state';
import {
  addCustomDomain,
  addProcessEntry,
  appSuggestions,
  catalogGroups,
  customEntries,
  searchCatalog,
  selectedCount,
  withCategory,
  withService,
  withoutEntry,
} from '../../../src/renderer/src/windows/bloqueos/catalog';
import {
  durationFields,
  parseDurationText,
  parseUntilText,
  selectedPreset,
} from '../../../src/renderer/src/windows/bloqueos/duration';
import {
  daysLabel,
  scheduleLock,
  scheduleRow,
} from '../../../src/renderer/src/windows/bloqueos/schedules';
import {
  deriveBloqueosView,
  suggestedTemplateName,
  templateNameProblem,
  type BloqueosData,
} from '../../../src/renderer/src/windows/bloqueos/view';

const NOW = HARNESS_NOW;
const MIN = 60_000;

const READY: BloqueosData = {
  schedules: { status: 'ready', list: makeSchedules(NOW) },
  pendingSchedules: {},
  processNames: ['chrome.exe', 'Discord.exe', 'explorer.exe', 'steam.exe', 'notepad.exe'],
};

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

describe('Bloqueos view per fixture', () => {
  it('shows an empty form, the active block, the templates and the schedules (bloqueos)', () => {
    const view = deriveBloqueosView(detailState('bloqueos'), NOW, READY);
    expect(view.seedLine).toBeNull();
    expect(view.targets.title).toBe('Qué bloquear: nada aún');
    expect(view.targets.datum).toBeNull();
    expect(view.targets.groups.map((g) => g.name)).toEqual([
      'Redes sociales',
      'Vídeo y streaming',
      'Juegos',
      'Mensajería',
      'Compras',
      'Noticias y deportes',
      'Otros',
    ]);
    expect(view.targets.groups.at(-1)?.categoryId).toBeNull();
    expect(view.duration.title).toBe('Duración: 1 h');
    expect(view.duration.datum).toBe('hasta las 18:00');
    expect(view.duration.presets.map((p) => [p.label, p.selected])).toEqual([
      ['30 min', false],
      ['1 h', true],
      ['2 h', false],
      ['3 h', false],
    ]);
    expect(view.mode.title).toBe('Modo: Normal');
    expect(view.mode.datum).toBe('emergencia: 10 min');
    expect(view.mode.options.map((o) => [o.label, o.tone])).toEqual([
      ['Normal', 'blue'],
      ['Estricto', 'orange'],
      ['Hardcore', 'red'],
      ['Examen', 'red'],
    ]);
    expect(view.problem).toBe('no_targets');
    expect(view.problemText).toBe('Elige qué bloquear');
    expect(view.active.title).toBe('Activos: 1 bloqueo');
    expect(view.active.rows).toEqual([
      {
        id: 'blk_fixture0000000001',
        label: 'YouTube, Instagram · Estricto',
        until: 'hasta las 17:42',
        tone: 'orange',
      },
    ]);
    expect(view.active.emergency).toBe(true);
    expect(view.templates.title).toBe('Plantillas: 3');
    expect(view.templates.rows[0]).toMatchObject({
      label: 'Deberes 1 h',
      description: 'Redes sociales, Vídeo y streaming +2 · 1 h · modo por defecto',
      builtin: true,
    });
    expect(view.templates.rows[1]?.description).toBe('Todo salvo la lista blanca · 3 h · Examen');
    expect(view.schedules.title).toBe('Horarios: 1 de 2 activos');
    expect(view.schedules.datum).toBe('Próximo: 18:00');
    expect(view.schedules.rows.map((r) => [r.title, r.description, r.enabled, r.locked])).toEqual([
      ['L–V 18:00–20:00 · Redes sociales', 'Tardes de estudio · Normal', true, false],
      ['S 10:00–13:00 · Juegos', 'Sábados sin juegos · Estricto', false, false],
    ]);
    expect(view.exam.tiles.map((t) => t.label)).toEqual(['Examen 1 h', 'Examen 2 h', 'Examen 3 h']);
    expect(view.exam.allowed).toMatch(/ y \d+ más$/);
  });

  it('opens with what the phrase said (bloqueos-prefilled)', () => {
    const view = deriveBloqueosView(detailState('bloqueos-prefilled'), NOW, READY);
    expect(view.seedLine).toBe('De tu frase «no veo YouTube mañana tarde»: completa lo que falta');
    expect(view.targets.title).toBe('Qué bloquear: YouTube');
    expect(view.targets.datum).toBe('1 elegido');
    const video = view.targets.groups.find((g) => g.id === 'video');
    expect(video?.picked).toBe(1);
    expect(video?.services.find((s) => s.id === 'youtube')?.checked).toBe(true);
    expect(view.problem).toBeNull();
    expect(view.active.title).toBe('Activos: ninguno');
    expect(view.active.emergency).toBe(false);
  });

  it('says the schedules are loading, or why they could not load', () => {
    const state = detailState('bloqueos');
    const loading = deriveBloqueosView(state, NOW, { ...READY, schedules: { status: 'loading' } });
    expect(loading.schedules.title).toBe('Horarios: cargando…');
    expect(loading.schedules.rows).toEqual([]);
    const failed = deriveBloqueosView(state, NOW, {
      ...READY,
      schedules: {
        status: 'error',
        error: { kind: 'timeout', code: 'timeout', status: 0, details: null },
      },
    });
    expect(failed.schedules.title).toBe('Horarios: sin conexión');
    expect(failed.schedules.error?.kind).toBe('timeout');
    const none = deriveBloqueosView(state, NOW, {
      ...READY,
      schedules: { status: 'ready', list: [] },
    });
    expect(none.schedules.title).toBe('Horarios: ninguno');
  });

  it('replaces the picker with the whitelist in Examen', () => {
    const state = detailState('bloqueos');
    const form = withMode(
      { ...state.detail.bloqueos.form, targets: { ...emptyTargets(), serviceIds: ['youtube'] } },
      'exam',
    );
    const view = deriveBloqueosView(
      { ...state, detail: { ...state.detail, bloqueos: { ...state.detail.bloqueos, form } } },
      NOW,
      READY,
    );
    expect(view.targets.title).toBe('Qué bloquear: todo salvo la lista blanca');
    expect(view.targets.whitelist?.intro).toMatch(/^Examen bloquea/);
    expect(view.targets.groups).toEqual([]);
    expect(view.targets.search).toBeNull();
    expect(view.mode.datum).toBe('sin emergencia');
    expect(view.problem).toBeNull();
    // Leaving Examen gives the targets back.
    expect(withMode(form, 'normal').targets.serviceIds).toEqual(['youtube']);
  });

  it('shows the pending switch value while the guardian saves it', () => {
    const view = deriveBloqueosView(detailState('bloqueos'), NOW, {
      ...READY,
      pendingSchedules: { sch_fixture0000000002: true },
    });
    const row = view.schedules.rows[1];
    expect(row).toMatchObject({ enabled: true, saving: true, description: 'Guardando…' });
    expect(view.schedules.title).toBe('Horarios: 2 de 2 activos');
  });
});

describe('Bloqueos catalog picker', () => {
  it('checking a category drops the services it covers and locks them', () => {
    let t = withService(emptyTargets(), 'youtube', true);
    t = withService(t, 'tiktok', true);
    t = withCategory(t, 'video', true);
    expect(t.categoryIds).toEqual(['video']);
    expect(t.serviceIds).toEqual(['tiktok']);
    expect(withService(t, 'netflix', true)).toBe(t);
    const video = catalogGroups(t).find((g) => g.id === 'video');
    expect(video?.checked).toBe(true);
    expect(video?.services.every((s) => s.checked && s.includedBy === 'Vídeo y streaming')).toBe(
      true,
    );
    expect(withCategory(t, 'video', false).categoryIds).toEqual([]);
    expect(selectedCount(t)).toBe(2);
  });

  it('keeps categories in catalog order', () => {
    const t = withCategory(withCategory(emptyTargets(), 'games', true), 'social', true);
    expect(t.categoryIds).toEqual(['social', 'games']);
  });

  it('puts opt-in services under «Otros»', () => {
    const otros = catalogGroups(emptyTargets()).find((g) => g.id === 'otros');
    expect(otros?.services.map((s) => s.id)).toContain('linkedin');
    expect(otros?.categoryId).toBeNull();
  });

  it('searches names and aliases without accents', () => {
    expect(searchCatalog('', emptyTargets())).toBeNull();
    expect(searchCatalog('yt', emptyTargets())?.services[0]?.id).toBe('youtube');
    expect(searchCatalog('insta', emptyTargets())?.services[0]?.id).toBe('instagram');
    expect(searchCatalog('video', emptyTargets())?.categories[0]?.id).toBe('video');
    expect(searchCatalog('redes', emptyTargets())?.categories[0]?.id).toBe('social');
    const none = searchCatalog('zzzz-nada', emptyTargets());
    expect(none?.services).toEqual([]);
    expect(none?.categories).toEqual([]);
  });

  it('validates custom domains with the shared normalizer', () => {
    const ok = addCustomDomain(emptyTargets(), '  https://Apuntes-Ejemplo.es/tema?x=1 ');
    expect(ok).toEqual({
      ok: true,
      targets: { ...emptyTargets(), customDomains: ['apuntes-ejemplo.es'] },
      note: null,
    });
    if (!ok.ok) throw new Error('unreachable');
    expect(addCustomDomain(ok.targets, 'apuntes-ejemplo.es')).toEqual({
      ok: false,
      error: 'Ya está en la lista',
    });
    expect(addCustomDomain(emptyTargets(), 'no es una web')).toEqual({
      ok: false,
      error: 'Eso no parece una web: prueba con ejemplo.com',
    });
    expect(addCustomDomain(emptyTargets(), '192.168.1.1').ok).toBe(false);
    const catalog = addCustomDomain(emptyTargets(), 'm.youtube.com');
    expect(catalog).toMatchObject({
      ok: true,
      note: 'm.youtube.com es de YouTube: marcado en el catálogo',
    });
    if (catalog.ok) {
      expect(catalog.targets.serviceIds).toEqual(['youtube']);
      expect(catalog.targets.customDomains).toEqual([]);
    }
  });

  it('refuses domains the system needs', () => {
    const error = 'Eso no se puede bloquear: el sistema lo necesita';
    expect(addCustomDomain(emptyTargets(), 'windowsupdate.com')).toEqual({ ok: false, error });
    expect(addCustomDomain(emptyTargets(), 'download.windowsupdate.com')).toEqual({
      ok: false,
      error,
    });
    expect(addCustomDomain(emptyTargets(), 'accounts.youtube.com')).toEqual({ ok: false, error });
  });

  it('adds catalog apps by name or process, and plain process names', () => {
    const discord = addProcessEntry(emptyTargets(), 'Discord.exe', 'win');
    expect(discord).toMatchObject({ ok: true, targets: { appIds: ['discord'] } });
    const byName = addProcessEntry(emptyTargets(), 'steam', 'win');
    expect(byName).toMatchObject({ ok: true, targets: { appIds: ['steam'] } });
    const custom = addProcessEntry(emptyTargets(), 'notepad.exe', 'win');
    expect(custom).toMatchObject({ ok: true, targets: { customProcesses: ['notepad.exe'] } });
    if (!custom.ok) throw new Error('unreachable');
    expect(addProcessEntry(custom.targets, 'NOTEPAD.EXE', 'win')).toEqual({
      ok: false,
      error: 'Ya está en la lista',
    });
    expect(addProcessEntry(emptyTargets(), 'explorer.exe', 'win')).toEqual({
      ok: false,
      error: 'Eso no se puede bloquear: el sistema lo necesita',
    });
    expect(addProcessEntry(emptyTargets(), 'C:\\x\\a.exe', 'win').ok).toBe(false);
    const entries = customEntries({
      ...emptyTargets(),
      appIds: ['discord'],
      customProcesses: ['a.exe'],
    });
    expect(entries.apps.map((e) => e.label)).toEqual(['Discord', 'a.exe']);
    expect(
      withoutEntry({ ...emptyTargets(), appIds: ['discord'] }, { kind: 'app', key: 'discord' })
        .appIds,
    ).toEqual([]);
  });

  it('suggests running apps, catalog apps first, never protected ones', () => {
    const running = READY.processNames;
    const idle = appSuggestions('', running, emptyTargets(), 'win');
    expect(idle.map((s) => s.label)).toEqual(['Discord', 'Steam']);
    const typed = appSuggestions('note', running, emptyTargets(), 'win');
    expect(typed).toEqual([{ kind: 'process', name: 'notepad.exe', label: 'notepad.exe' }]);
    expect(appSuggestions('explo', running, emptyTargets(), 'win')).toEqual([]);
    const already = appSuggestions('', running, { ...emptyTargets(), appIds: ['discord'] }, 'win');
    expect(already.map((s) => s.label)).toEqual(['Steam']);
    expect(appSuggestions('roblo', [], emptyTargets(), 'win').map((s) => s.label)).toEqual([
      'Roblox',
    ]);
  });
});

describe('Bloqueos duration', () => {
  it('reads durations like the main field', () => {
    expect(parseDurationText('45 min', NOW)).toEqual({
      ok: true,
      end: { kind: 'duration', minutes: 45 },
    });
    expect(parseDurationText('1h30', NOW)).toEqual({
      ok: true,
      end: { kind: 'duration', minutes: 90 },
    });
    expect(parseDurationText('hora y media', NOW)).toEqual({
      ok: true,
      end: { kind: 'duration', minutes: 90 },
    });
    expect(parseDurationText('90', NOW)).toEqual({
      ok: true,
      end: { kind: 'duration', minutes: 90 },
    });
    expect(parseDurationText('3 min', NOW)).toEqual({ ok: false, error: 'Como mínimo 5 min' });
    expect(parseDurationText('25 h', NOW)).toEqual({ ok: false, error: 'Como mucho 24 h' });
    expect(parseDurationText('mucho', NOW).ok).toBe(false);
  });

  it('reads «Hasta las» as the next time on the clock', () => {
    expect(parseUntilText('18:30', NOW)).toEqual({
      ok: true,
      end: { kind: 'until', endsAt: '2026-09-28T16:30:00.000Z' },
    });
    expect(parseUntilText('1830', NOW)).toEqual(parseUntilText('18:30', NOW));
    expect(parseUntilText('8', NOW)).toEqual({
      ok: true,
      end: { kind: 'until', endsAt: '2026-09-29T06:00:00.000Z' },
    });
    expect(parseUntilText('17:02', NOW)).toEqual({ ok: false, error: 'Como mínimo 5 min' });
    expect(parseUntilText('16:59', NOW)).toEqual({
      ok: true,
      end: { kind: 'until', endsAt: '2026-09-29T14:59:00.000Z' },
    });
    expect(parseUntilText('25:00', NOW).ok).toBe(false);
    expect(parseUntilText('mañana a las 8', NOW)).toEqual({
      ok: true,
      end: { kind: 'until', endsAt: '2026-09-29T06:00:00.000Z' },
    });
  });

  it('keeps both fields in sync', () => {
    const draft = detailState('bloqueos').detail.bloqueos.form;
    expect(durationFields(draft, NOW)).toMatchObject({
      minutesText: '1 h',
      untilText: '18:00',
      minutes: 60,
    });
    const until = { ...draft, end: { kind: 'until' as const, endsAt: '2026-09-28T16:30:00.000Z' } };
    expect(durationFields(until, NOW)).toMatchObject({
      minutesText: '1 h 30 min',
      untilText: '18:30',
    });
    expect(selectedPreset(draft)).toBe(60);
    expect(selectedPreset(until)).toBeNull();
  });
});

describe('Bloqueos schedules', () => {
  it('writes the days like «L–V»', () => {
    expect(daysLabel([1, 2, 3, 4, 5])).toBe('L–V');
    expect(daysLabel([6, 7])).toBe('S, D');
    expect(daysLabel([1, 3, 5])).toBe('L, X, V');
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Todos los días');
    expect(daysLabel([7, 1, 2, 3, 5, 6])).toBe('L–X, V–D');
  });

  it('locks switching off a running schedule or one about to start', () => {
    const [evening] = makeSchedules(NOW) as [Schedule, Schedule];
    expect(scheduleLock(evening, NOW)).toBeNull();
    const running = { ...evening, activeBlockId: 'blk_fixture0000000001' as const };
    expect(scheduleLock(running, NOW)).toBe('En curso: podrás cambiarlo cuando acabe');
    const soon = {
      ...evening,
      nextOccurrence: {
        startsAt: new Date(NOW + 9 * MIN).toISOString(),
        endsAt: new Date(NOW + 60 * MIN).toISOString(),
      },
    };
    expect(scheduleLock(soon, NOW)).toBe('Empieza en menos de 10 min: ya no se puede quitar');
    expect(scheduleLock({ ...soon, enabled: false }, NOW)).toBeNull();
    expect(scheduleRow(running, NOW, undefined)).toMatchObject({
      locked: true,
      description: 'En curso: podrás cambiarlo cuando acabe',
    });
  });
});

describe('Bloqueos templates', () => {
  it('suggests a name and checks it', () => {
    const state = detailState('bloqueos-prefilled');
    expect(suggestedTemplateName(state.detail.bloqueos.form, NOW)).toBe('YouTube · 1 h');
    expect(templateNameProblem('   ')).toBe('Ponle un nombre');
    expect(templateNameProblem('x'.repeat(41))).toBe('Como mucho 40 letras');
    expect(templateNameProblem('Tardes')).toBeNull();
  });
});
