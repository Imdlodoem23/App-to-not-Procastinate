/**
 * «Límites diarios» of the Bloqueos window: rows (progress, used up, pending change), the
 * merge of the fetched list with the live snapshot, the editor (minutes as typed, problems,
 * the softening note, the request body) and the seeded editor from the main window's card.
 */
import { describe, expect, it } from 'vitest';
import type { DailyLimit } from '@centrate/shared/domain';
import { emptyTargets, limitInputFromLimit } from '@centrate/shared/guardian-api';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  makeLimits,
  stateLimit,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { limitEditorFor, newLimitEditor, parseLimitMinutes } from '../../../src/shared/limits';
import { uiError, type UiState } from '../../../src/shared/ui-state';
import {
  limitEditWeakens,
  limitEditorProblem,
  limitErrorText,
  limitRow,
  mergeLimits,
  pendingEstimate,
  pendingWhat,
  toLimitRequest,
  withLimitDay,
} from '../../../src/renderer/src/windows/bloqueos/limits';
import {
  deriveBloqueosView,
  type BloqueosData,
} from '../../../src/renderer/src/windows/bloqueos/view';
import { detailForRequest } from '../../../src/renderer/src/store/reducers';

const NOW = HARNESS_NOW;

function limits(): DailyLimit[] {
  return makeLimits(NOW);
}

function nth(i: number): DailyLimit {
  const l = limits()[i];
  if (!l) throw new Error('missing fixture limit');
  return l;
}

function data(id: HarnessStateId): BloqueosData {
  const f = harnessFixture(id);
  return {
    schedules: { status: 'ready', list: f.fake.schedules },
    pendingSchedules: {},
    processNames: f.fake.processNames,
    settings: { status: 'ready', value: f.fake.settings },
    limits: { status: 'ready', list: f.fake.limits },
  };
}

function state(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

describe('limit rows', () => {
  it('say today’s use, a used-up day and a pending change', () => {
    const [youtube, social, tiktok] = limits().map((l) => limitRow(l, NOW));
    expect(youtube).toMatchObject({
      title: 'YouTube · 30 min al día',
      monogram: expect.any(String),
      usage: { text: '12 de 30 min hoy', tone: 'blue' },
      state: null,
      description: 'todos los días · Estricto',
      pending: null,
    });
    expect(social).toMatchObject({
      title: 'Redes sociales · 1 h al día',
      monogram: null,
      categoryId: 'social',
      usage: { value: 1, text: '1 h de 1 h hoy', tone: 'red' },
      state: { text: 'Bloqueado hasta mañana', tone: 'red' },
      description: 'entre semana · Estricto',
    });
    expect(tiktok?.pending).toBe('Cambio pendiente: 1 h al día desde mañana 16:00');
  });

  it('say a pending deletion and a day it does not block', () => {
    const deleting: DailyLimit = {
      ...nth(0),
      appliesToday: false,
      pendingChange: {
        definition: null,
        effectiveAt: new Date(NOW + 20 * 3_600_000).toISOString(),
      },
    };
    expect(limitRow(deleting, NOW)).toMatchObject({
      state: { text: 'Hoy no cuenta para bloquear' },
      pending: 'Se borrará mañana 13:00; hasta entonces sigue contando',
    });
  });

  it('are in English too', () => {
    withLocale('en', () => {
      expect(limitRow(nth(1), NOW)).toMatchObject({
        title: 'Redes sociales · 1 h a day',
        usage: { text: '1 h of 1 h today' },
        state: { text: 'Blocked until tomorrow' },
      });
    });
  });

  it('take the live usage of the snapshot when it is as new', () => {
    const fetched = limits();
    const live = fetched.map(stateLimit);
    const merged = mergeLimits(fetched, live);
    expect(merged[0]?.usedTodaySeconds).toBe(12 * 60);
    const newer: DailyLimit = { ...nth(0), updatedAt: new Date(NOW + 1_000).toISOString() };
    expect(mergeLimits([newer, ...fetched.slice(1)], live)[0]).toBe(newer);
    const extra: DailyLimit = { ...nth(0), id: 'lim_fixture0000000009' };
    expect(mergeLimits(fetched, [...live, extra]).map((l) => l.id)).toContain(extra.id);
    expect(mergeLimits(fetched, undefined)).toEqual(fetched);
  });
});

describe('the limit editor', () => {
  it('reads the minutes as typed', () => {
    expect(parseLimitMinutes('45', NOW)).toBe(45);
    expect(parseLimitMinutes('1 h', NOW)).toBe(60);
    expect(parseLimitMinutes('1h30', NOW)).toBe(90);
    expect(parseLimitMinutes('45 min', NOW)).toBe(45);
    expect(parseLimitMinutes('mucho', NOW)).toBeNull();
    expect(parseLimitMinutes('YouTube 30 min', NOW)).toBeNull();
  });

  it('says what is missing before saving', () => {
    const fresh = newLimitEditor();
    expect(limitEditorProblem(fresh, NOW, 0)).toBe('no_targets');
    const withTargets = newLimitEditor({ targets: { ...emptyTargets(), serviceIds: ['youtube'] } });
    expect(limitEditorProblem(withTargets, NOW, 0)).toBeNull();
    expect(limitEditorProblem({ ...withTargets, minutesText: 'x' }, NOW, 0)).toBe('minutes_text');
    expect(limitEditorProblem({ ...withTargets, minutesText: '3' }, NOW, 0)).toBe('minutes');
    expect(limitEditorProblem({ ...withTargets, minutesText: '13 h' }, NOW, 0)).toBe('minutes');
    const noDays = { ...withTargets, input: { ...withTargets.input, days: [] } };
    expect(limitEditorProblem(noDays, NOW, 0)).toBe('no_days');
    expect(limitEditorProblem(withTargets, NOW, 50)).toBe('full');
  });

  it('builds the request (typed minutes, the auto name, the acknowledgement)', () => {
    const editor = {
      ...newLimitEditor({ targets: { ...emptyTargets(), categoryIds: ['social'] } }),
      minutesText: '1h30',
    };
    const hardcore = { ...editor, input: { ...editor.input, mode: 'hardcore' as const } };
    expect(toLimitRequest(hardcore, NOW, true)).toMatchObject({
      name: 'Redes sociales',
      dailyMinutes: 90,
      mode: 'hardcore',
      days: [1, 2, 3, 4, 5, 6, 7],
      acknowledgeNoEmergency: true,
    });
    expect(toLimitRequest(editor, NOW, true).acknowledgeNoEmergency).toBe(false);
  });

  it('knows a softening edit waits (and a stricter one does not)', () => {
    const youtube = nth(0);
    const input = limitInputFromLimit(youtube);
    expect(limitEditWeakens(youtube, input)).toBe(false);
    expect(limitEditWeakens(youtube, { ...input, dailyMinutes: 20 })).toBe(false);
    expect(limitEditWeakens(youtube, { ...input, dailyMinutes: 45 })).toBe(true);
    expect(limitEditWeakens(youtube, withLimitDay(input, 7, false))).toBe(true);
    expect(limitEditWeakens(youtube, { ...input, mode: 'normal' })).toBe(true);
    expect(pendingWhat(youtube, { ...input, dailyMinutes: 45, mode: 'normal' })).toBe(
      '45 min al día, modo Normal',
    );
    expect(pendingEstimate(NOW)).toBe(NOW + 24 * 3_600_000);
  });

  it('shows the note, the Hardcore line and «Borrar» in the view', () => {
    const base = state('limits');
    const tiktok = nth(2);
    const editing: UiState = {
      ...base,
      detail: {
        ...base.detail,
        bloqueos: {
          ...base.detail.bloqueos,
          limit: { ...limitEditorFor(tiktok), minutesText: '2 h' },
        },
      },
    };
    const view = deriveBloqueosView(editing, NOW, data('limits'));
    expect(view.limits.editor).toMatchObject({
      title: 'Editar: TikTok · 2 h al día',
      note: 'Esto lo suaviza: se aplicará mañana 17:00 (lo que lo endurece, ya)',
      consequence: null,
      problem: null,
      remove: { consequence: '«TikTok» se borrará mañana 17:00; el bloqueo de hoy sigue' },
    });
    expect(view.limits.rows.find((r) => r.id === tiktok.id)?.description).toBe('Editando…');
    expect(view.limits.canCreate).toBe(false);
  });

  it('words the guardian’s refusals', () => {
    expect(limitErrorText(uiError('rejected', 'not_found', 404))).toBe('Ese límite ya no existe');
    expect(limitErrorText(uiError('rejected', 'too_many_targets', 422))).toBe(
      'Tus límites ya tienen demasiadas webs propias',
    );
  });
});

describe('the Bloqueos view with limits', () => {
  it('lists the `limits` fixture: 3 limits, one used up today', () => {
    const view = deriveBloqueosView(state('limits'), NOW, data('limits'));
    expect(view.limits).toMatchObject({
      title: 'Límites diarios: 3',
      datum: '1 agotado hoy',
      status: 'ready',
      canCreate: true,
      editor: null,
    });
    expect(view.limits.rows[0]?.usage.text).toBe('12 de 30 min hoy');
    expect(view.limits.rows.every((r) => r.editKey)).toBe(true);
    expect(view.limits.rows[2]?.cancelKey).toBeDefined();
  });

  it('opens the new limit of `limit-editor`', () => {
    const view = deriveBloqueosView(state('limit-editor'), NOW, data('limit-editor'));
    expect(view.limits.editor).toMatchObject({
      id: null,
      title: 'Nuevo límite: Instagram · 45 min al día',
      minutes: { text: '45 min al día', tone: 'muted' },
      note: null,
      remove: null,
    });
    expect(view.limits.editor?.days.filter((d) => d.checked).map((d) => d.day)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('is loading, or offline, without the list', () => {
    const loading = deriveBloqueosView(state('limits'), NOW, {
      ...data('limits'),
      limits: undefined,
    });
    expect(loading.limits.status).toBe('loading');
    const offline = deriveBloqueosView(state('limits'), NOW, {
      ...data('limits'),
      limits: { status: 'error', error: uiError('unreachable', 'unreachable') },
    });
    expect(offline.limits.title).toBe('Límites diarios: sin conexión');
  });

  it('says an older guardian has no daily limits (no list, no «Nuevo límite»)', () => {
    const base = state('limits');
    const health = base.snapshot.health;
    if (!health) throw new Error('fixture without health');
    const old: UiState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        health: {
          ...health,
          capabilities: health.capabilities.filter((c) => c !== 'daily_limits'),
        },
      },
    };
    const view = deriveBloqueosView(old, NOW, data('limits'));
    expect(view.limits).toMatchObject({
      title: 'Límites diarios',
      status: 'unsupported',
      rows: [],
      canCreate: false,
    });
  });

  it('the `limits-unsupported` fixture: a note, no list, no «Nuevo límite»', () => {
    const view = deriveBloqueosView(state('limits-unsupported'), NOW, data('limits-unsupported'));
    expect(view.limits).toMatchObject({ status: 'unsupported', rows: [], canCreate: false });
    expect(harnessFixture('limits-unsupported').detailRequest).toMatchObject({ focus: 'limits' });
  });

  it('opens the seeded editor from the main window’s «Editar…»', () => {
    const f = harnessFixture('idle');
    const detail = detailForRequest(
      f.detail,
      {
        name: 'bloqueos',
        seed: {
          phrase: 'YouTube máximo 30 minutos al día',
          targets: { ...emptyTargets(), serviceIds: ['youtube'] },
          end: { kind: 'duration', minutes: 30 },
          mode: 'hardcore',
          reason: '',
        },
        focus: 'limits',
      },
      f.snapshot,
    );
    expect(detail.bloqueos.limit).toMatchObject({
      id: null,
      minutesText: '30 min',
      input: { dailyMinutes: 30, mode: 'hardcore', targets: { serviceIds: ['youtube'] } },
    });
    // The block form keeps what it had.
    expect(detail.bloqueos.form).toEqual(f.detail.bloqueos.form);
  });
});
