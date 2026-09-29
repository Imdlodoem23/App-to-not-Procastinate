import { describe, expect, it } from 'vitest';
import {
  HARNESS_NOW,
  harnessFixture,
  limitBlock,
  makeGuardianState,
  makeLimits,
} from '../../../src/shared/fixtures';
import {
  finishedNotice,
  initialMainLocal,
  type MainLocalState,
} from '../../../src/shared/ui-state';
import { withLocale } from '../../../src/shared/i18n/locale';
import {
  fieldEnter,
  limitCardAdvance,
  limitCardWithMode,
  newLimitCard,
  parsePhrase,
} from '../../../src/renderer/src/sections/bloqueo/draft';
import {
  enterBloqueo,
  escapeBloqueo,
  openTemplate,
  typeInField,
} from '../../../src/renderer/src/sections/bloqueo/reducer';
import { deriveBloqueoView } from '../../../src/renderer/src/sections/bloqueo/view';

const NOW = HARNESS_NOW;

function ids(): () => string {
  let n = 0;
  return () => `intent-limit-${++n}`;
}

function typed(text: string): MainLocalState {
  return { ...initialMainLocal(), composer: { text, openWhileActive: false } };
}

describe('a daily-limit phrase', () => {
  const idle = harnessFixture('idle');
  const prefs = idle.snapshot.prefs;

  it('opens the «Límite diario» card with what was read (strict, every day)', () => {
    const text = 'YouTube máximo 30 minutos al día';
    const enter = fieldEnter(text, parsePhrase(text, NOW), prefs);
    expect(enter).toEqual({
      kind: 'limit',
      draft: {
        name: 'YouTube',
        targets: expect.objectContaining({ serviceIds: ['youtube'] }),
        dailyMinutes: 30,
        days: [1, 2, 3, 4, 5, 6, 7],
        mode: 'strict',
        reason: '',
      },
    });
    const days = 'redes sociales 1 hora al día entre semana';
    const weekdays = fieldEnter(days, parsePhrase(days, NOW), prefs);
    expect(weekdays).toMatchObject({
      kind: 'limit',
      draft: { name: 'Redes sociales', dailyMinutes: 60, days: [1, 2, 3, 4, 5] },
    });
    const en = 'limit YouTube to 30 min a day';
    expect(fieldEnter(en, parsePhrase(en, NOW), prefs)).toMatchObject({ kind: 'limit' });
  });

  it('not fully read goes to Bloqueos › Límites diarios with the allowance', () => {
    const text = 'YouTube máximo 30 minutos al día mañana tarde';
    expect(fieldEnter(text, parsePhrase(text, NOW), prefs)).toMatchObject({
      kind: 'bloqueos',
      focus: 'limits',
      seed: { end: { kind: 'duration', minutes: 30 } },
    });
  });

  it('block phrases still open the block card', () => {
    const text = 'no veo YouTube en una hora';
    expect(fieldEnter(text, parsePhrase(text, NOW), prefs).kind).toBe('card');
  });

  it('Enter, Enter: the card, then `limits:create` with one key; Esc closes it', () => {
    const newId = ids();
    const main = typed('YouTube máximo 30 minutos al día');
    const opened = enterBloqueo(idle.snapshot, main, NOW, newId);
    expect(opened.kind).toBe('update');
    expect(opened.main.limitCard?.intentId).toBe('intent-limit-1');
    const view = deriveBloqueoView({ snapshot: idle.snapshot, main: opened.main }, NOW);
    expect(view.variant).toBe('limit');
    expect(view.body).toMatchObject({
      kind: 'limit-card',
      status: 'edit',
      chips: [
        expect.objectContaining({ label: 'YouTube' }),
        expect.objectContaining({ label: '30 min al día' }),
        expect.objectContaining({ label: 'todos los días' }),
      ],
      actions: [
        expect.objectContaining({ id: 'edit', label: 'Editar…' }),
        expect.objectContaining({ id: 'confirm', label: 'Crear límite: 30 min al día' }),
      ],
      summary: 'Limita YouTube a 30 minutos al día, todos los días, modo Estricto',
    });
    const submit = enterBloqueo(idle.snapshot, opened.main, NOW, newId);
    expect(submit).toMatchObject({
      kind: 'limit-submit',
      intentId: 'intent-limit-1',
      input: {
        name: 'YouTube',
        dailyMinutes: 30,
        mode: 'strict',
        days: [1, 2, 3, 4, 5, 6, 7],
        acknowledgeNoEmergency: false,
      },
    });
    // While sending, Enter and Esc do nothing (it cannot be taken back).
    expect(enterBloqueo(idle.snapshot, submit.main, NOW, newId).kind).toBe('none');
    expect(escapeBloqueo(idle.snapshot, submit.main, NOW)?.main.limitCard ?? null).not.toBeNull();
    // Esc closes an idle card.
    expect(escapeBloqueo(idle.snapshot, opened.main, NOW)?.main.limitCard).toBeNull();
  });

  it('Hardcore asks first: the red line, a 2 s lock, then the acknowledgement', () => {
    const text = 'YouTube máximo 30 minutos al día';
    const enter = fieldEnter(text, parsePhrase(text, NOW), prefs);
    if (enter.kind !== 'limit') throw new Error('not a limit');
    const card = limitCardWithMode(newLimitCard(enter.draft, 'k1', text), 'hardcore', 'k2');
    expect(card.intentId).toBe('k2');
    const first = limitCardAdvance(card, NOW);
    expect(first.kind).toBe('consequence');
    expect(limitCardAdvance(first.card, NOW + 500).kind).toBe('none');
    const second = limitCardAdvance(first.card, NOW + 2_500);
    expect(second).toMatchObject({
      kind: 'submit',
      input: { mode: 'hardcore', acknowledgeNoEmergency: true },
    });
    const main = { ...typed(text), limitCard: first.card };
    const view = deriveBloqueoView({ snapshot: idle.snapshot, main }, NOW + 100);
    expect(view.body).toMatchObject({
      kind: 'limit-card',
      status: 'consequence',
      actionsHelp: {
        kind: 'text',
        tone: 'red',
        text: 'Cuando se agote, no podrás desbloquearlo de ninguna forma hasta medianoche',
      },
    });
    // Esc leaves the consequence step first.
    expect(escapeBloqueo(idle.snapshot, main, NOW)?.main.limitCard?.step).toBe('edit');
  });

  it('an allowance out of range stays as typed and says so', () => {
    const text = 'YouTube 2 minutos al día';
    const main = enterBloqueo(idle.snapshot, typed(text), NOW, ids()).main;
    const view = deriveBloqueoView({ snapshot: idle.snapshot, main }, NOW);
    expect(view.body).toMatchObject({
      kind: 'limit-card',
      problem: 'minutes',
      actionsHelp: { kind: 'text', tone: 'orange', text: 'Entre 5 min y 12 h al día' },
    });
    expect(enterBloqueo(idle.snapshot, main, NOW, ids()).kind).toBe('none');
  });

  it('typing again or a template closes it', () => {
    const main = enterBloqueo(
      idle.snapshot,
      typed('YouTube máximo 30 minutos al día'),
      NOW,
      ids(),
    ).main;
    expect(typeInField(idle.snapshot, main, 'YouTube').main.limitCard).toBeNull();
    const template = openTemplate(idle.snapshot, main, 'deberes', ids());
    expect(template.main.limitCard).toBeNull();
    expect(template.main.card).not.toBeNull();
  });

  it('renders the harness fixture in both languages', () => {
    const f = harnessFixture('limit-confirm');
    const es = deriveBloqueoView({ snapshot: f.snapshot, main: f.main }, f.nowMs);
    expect(es.body.kind).toBe('limit-card');
    withLocale('en', () => {
      const en = deriveBloqueoView({ snapshot: f.snapshot, main: f.main }, f.nowMs);
      expect(en.body).toMatchObject({
        actions: [
          expect.objectContaining({ label: 'Edit…' }),
          expect.objectContaining({ label: 'Create limit: 30 min a day' }),
        ],
      });
    });
  });
});

describe('a limit block in the main window', () => {
  it('says «Límite diario de Redes sociales: bloqueado hasta las 00:00»', () => {
    const f = harnessFixture('limit-block');
    const view = deriveBloqueoView({ snapshot: f.snapshot, main: f.main }, f.nowMs);
    expect(view.variant).toBe('active');
    expect(view.header.titles).toEqual([
      'Límite diario de Redes sociales: bloqueado hasta las 00:00',
      'Límite de Redes sociales: hasta las 00:00',
      'Límite diario: hasta las 00:00',
    ]);
    expect(view.header.datum).toBeNull();
  });

  it('names its limit in the rows of other blocks', () => {
    const state = makeGuardianState(NOW, {
      blocks: [
        harnessFixture('one-block').snapshot.state?.blocks[0] ?? limitBlock(NOW),
        { ...limitBlock(NOW), endsAt: new Date(NOW + 60_000 * 5).toISOString() },
      ],
      limits: makeLimits(NOW),
    });
    const f = harnessFixture('one-block');
    const view = deriveBloqueoView({ snapshot: { ...f.snapshot, state }, main: f.main }, NOW);
    if (view.body.kind !== 'active') throw new Error('not active');
    expect(view.body.rows.map((r) => r.label)).toContain(
      'Límite diario de Redes sociales · Estricto',
    );
  });

  it('never ends with «Hecho. +0 puntos»', () => {
    const state = makeGuardianState(NOW, {
      endedBlocks: [
        {
          id: limitBlock(NOW).id,
          kind: 'limit',
          mode: 'strict',
          outcome: 'completed',
          endedAt: new Date(NOW - 10_000).toISOString(),
          pointsDelta: 0,
        },
      ],
    });
    expect(finishedNotice(state, NOW)).toBeNull();
  });
});
