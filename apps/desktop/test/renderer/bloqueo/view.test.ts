import { describe, expect, it } from 'vitest';
import {
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  fixtureUiState,
  harnessFixture,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import type { Block } from '@centrate/shared/domain';
import { parseIntent } from '@centrate/shared/parser';
import type { UiState } from '../../../src/shared/ui-state';
import { uiError } from '../../../src/shared/ui-state';
import { BLOQUEO_ES } from '../../../src/renderer/src/sections/bloqueo/i18n/es';
import { estimateTextWidth } from '../../../src/renderer/src/sections/bloqueo/chips';
import {
  CONTENT_WIDTH,
  RESERVED_MNEMONICS,
  assignMnemonics,
  blockTitles,
  deriveBloqueoView,
  examplePhrase,
  nextSecondChange,
  type ActiveView,
  type BloqueoView,
  type CardView,
  type ComposerView,
} from '../../../src/renderer/src/sections/bloqueo/view';

const NOW = HARNESS_NOW;

function mainState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'main');
}

function view(id: HarnessStateId, nowMs: number = NOW): BloqueoView {
  return deriveBloqueoView(mainState(id), nowMs);
}

function composer(v: BloqueoView): ComposerView {
  if (v.body.kind === 'composer') return v.body.composer;
  if (v.body.kind === 'active' && v.body.composer) return v.body.composer;
  throw new Error(`no composer in ${v.variant}`);
}

function card(v: BloqueoView): CardView {
  if (v.body.kind !== 'card') throw new Error(`no card in ${v.variant}`);
  return v.body;
}

function active(v: BloqueoView): ActiveView {
  if (v.body.kind !== 'active') throw new Error(`not active: ${v.variant}`);
  return v.body;
}

function chipLabels(v: BloqueoView): string[] {
  const line = composer(v).line;
  return line.kind === 'chips' ? line.chips.map((c) => c.label) : [];
}

describe('deriveBloqueoView over every fixture', () => {
  it.each(HARNESS_STATE_IDS)('%s: renders its expected variant', (id) => {
    const fixture = harnessFixture(id);
    const v = deriveBloqueoView(fixtureUiState(fixture, 'main'), fixture.nowMs);
    expect(v.variant).toBe(fixture.expect.variant);
    expect(v.header.title.length).toBeGreaterThan(0);
  });

  it.each(HARNESS_STATE_IDS)('%s: the shortest header title fits on one line', (id) => {
    const v = view(id);
    expect(v.header.titles[0]).toBe(v.header.title);
    const shortest = v.header.titles[v.header.titles.length - 1] ?? '';
    const datum = v.header.datum ? estimateTextWidth(v.header.datum, 13) + 16 : 0;
    const pill = v.header.newPill ? estimateTextWidth('Nuevo', 11, true) + 20 : 0;
    // icon 16 + gap 8; the estimate is calibrated on the widest fallback font.
    expect(estimateTextWidth(shortest, 13, true) + datum + pill + 24).toBeLessThanOrEqual(
      CONTENT_WIDTH,
    );
  });

  it.each(HARNESS_STATE_IDS)('%s: every header title keeps «Cosa:»', (id) => {
    for (const title of view(id).header.titles) expect(title).toMatch(/^(Bloqueo|Castigo): \S/);
  });
});

describe('header titles', () => {
  const block = (targets: Partial<Block['targets']>, whitelistOnly = false): Block => {
    const base = mainState('one-block').snapshot.state?.blocks[0];
    if (!base) throw new Error('no block');
    return {
      ...base,
      whitelistOnly,
      targets: {
        serviceIds: [],
        categoryIds: [],
        appIds: [],
        customDomains: [],
        customProcesses: [],
        ...targets,
      },
    };
  };

  it('steps down keeping «Bloqueo:»: two names, one, the short category, the count', () => {
    expect(blockTitles(block({ categoryIds: ['social', 'video', 'games'] }), null)).toEqual([
      'Bloqueo: Redes sociales, Vídeo y streaming +1 · Estricto',
      'Bloqueo: Redes sociales +2 · Estricto',
      'Bloqueo: Redes +2 · Estricto',
      'Bloqueo: 3 · Estricto',
    ]);
    expect(blockTitles(block({ serviceIds: ['youtube'], categoryIds: ['news'] }), null)).toEqual([
      'Bloqueo: YouTube, Noticias y deportes · Estricto',
      'Bloqueo: YouTube +1 · Estricto',
      'Bloqueo: 2 · Estricto',
    ]);
  });

  it('one target ends with the mode alone; the whitelist has a short name', () => {
    expect(blockTitles(block({ categoryIds: ['social'] }), null)).toEqual([
      'Bloqueo: Redes sociales · Estricto',
      'Bloqueo: Redes · Estricto',
      'Bloqueo: Estricto',
    ]);
    expect(blockTitles({ ...block({}, true), mode: 'exam' }, null)).toEqual([
      'Bloqueo: Todo salvo la lista blanca · Examen',
      'Bloqueo: solo lista blanca · Examen',
      'Bloqueo: Examen',
    ]);
  });

  it('three-blocks and hardcore-block keep «Bloqueo:» down to the last title', () => {
    expect(view('three-blocks').header.titles).toEqual([
      'Bloqueo: Redes sociales · Estricto',
      'Bloqueo: Redes · Estricto',
      'Bloqueo: Estricto',
    ]);
    expect(view('hardcore-block').header.titles).toEqual([
      'Bloqueo: TikTok, Instagram +1 · Hardcore',
      'Bloqueo: TikTok +2 · Hardcore',
      'Bloqueo: 3 · Hardcore',
    ]);
  });

  it('a punishment keeps «Castigo:»', () => {
    expect(view('punishment').header.titles).toEqual([
      'Castigo: todas las distracciones · 60 min',
      'Castigo: todas las distracciones',
      'Castigo: 60 min',
    ]);
  });
});

describe('wake-ups off the wall-clock second', () => {
  it('nextSecondChange: when a rounded-up countdown shows its next value', () => {
    expect(nextSecondChange(10_300, 10_000)).toBe(10_300);
    expect(nextSecondChange(12_300, 10_000)).toBe(10_300);
    expect(nextSecondChange(12_000, 10_000)).toBe(11_000);
    expect(nextSecondChange(10_000, 10_000)).toBeNull();
    expect(nextSecondChange(9_000, 10_000)).toBeNull();
  });

  it('«Sí, bloquear 6 h»: wakes exactly at unlockAt, and is unlocked from then on', () => {
    const c = card(view('confirm-over-4h'));
    const unlockAt = c.unlockAt ?? NaN;
    expect(view('confirm-over-4h').wakeAt).toBe(unlockAt);
    const confirm = (at: number) =>
      card(view('confirm-over-4h', at)).actions.find((a) => a.id === 'confirm');
    expect(confirm(unlockAt - 1)?.locked).toBe(true);
    // An Enter 50 ms after the unlock finds an enabled button (the view re-derived at wakeAt).
    expect(confirm(unlockAt)?.locked).toBe(false);
    expect(confirm(unlockAt + 50)).toMatchObject({ locked: false, disabled: false });
    expect(view('confirm-over-4h', unlockAt).wakeAt).toBeNull();
  });

  it('«Deshacer (N s)» and «Emergencia: m:ss» change on their own second', () => {
    const undo = mainState('extend-undo').snapshot.ops.extendQueue[0];
    if (!undo) throw new Error('no entry');
    const wake = view('extend-undo').wakeAt ?? NaN;
    expect((undo.commitAt - wake) % 1000).toBe(0);
    expect(wake).toBeGreaterThan(NOW);
    expect(wake - NOW).toBeLessThanOrEqual(1000);
    const button = (at: number) => {
      const u = active(view('extend-undo', at)).extend?.undo;
      return u?.kind === 'waiting' ? u.button : null;
    };
    expect(button(wake - 1)).toBe('Deshacer (4 s)');
    expect(button(wake)).toBe('Deshacer (3 s)');

    const readyAt = Date.parse(
      mainState('emergency-waiting').snapshot.state?.emergency?.readyAt ?? '',
    );
    const next = view('emergency-waiting').wakeAt ?? NaN;
    expect((readyAt - next) % 1000).toBe(0);
    expect(view('one-block').wakeAt).toBeNull();
    expect(view('idle').wakeAt).toBeNull();
  });
});

describe('idle', () => {
  it('shows «Bloqueo: ninguno» and the next schedule', () => {
    const v = view('idle');
    expect(v.header).toEqual({
      title: 'Bloqueo: ninguno',
      titles: ['Bloqueo: ninguno'],
      datum: 'Próximo horario: 18:00',
      datumTone: 'default',
      newPill: false,
    });
  });

  it('has no datum without a guardian state', () => {
    expect(view('not-installed').header.datum).toBeNull();
  });

  it('shows the field hint, a rotating example and the templates row', () => {
    const c = composer(view('idle'));
    expect(c.value).toBe('');
    expect(c.line).toEqual({ kind: 'hint', text: '¿Qué quieres hacer? Escríbelo y pulsa Enter' });
    expect(c.placeholder).toBe(examplePhrase(NOW));
    expect(c.enter).toBe('none');
    expect(c.templates.map((t) => t.label)).toEqual([
      'Deberes 1 h',
      'Examen 3 h',
      'Leer 30 min',
      'Más…',
    ]);
    expect(c.templates.map((t) => t.mnemonic)).toEqual(['d', 'e', 'l', 'm']);
    expect(c.templates[3]).toMatchObject({ door: true, templateId: null });
    expect(c.templatesHelp).toBe(BLOQUEO_ES.templates.rowHelp);
  });

  it('explains the hovered template on the help line', () => {
    const state = mainState('idle');
    const withHelp = {
      ...state,
      main: { ...state.main, help: { row: 'bloqueo-templates', item: 'examen' } },
    };
    expect(composer(deriveBloqueoView(withHelp, NOW)).templatesHelp).toBe(
      'Todo salvo la lista blanca · 3 h · Examen',
    );
    const deberes = {
      ...state,
      main: { ...state.main, help: { row: 'bloqueo-templates', item: 'deberes' } },
    };
    expect(composer(deriveBloqueoView(deberes, NOW)).templatesHelp).toBe(
      'Redes sociales, Vídeo y streaming +2 · 1 h · Normal (por defecto)',
    );
  });

  it('rotates the example every 4 s and every example is understood', () => {
    const seen = new Set<string>();
    for (let i = 0; i < BLOQUEO_ES.field.examples.length; i += 1)
      seen.add(examplePhrase(NOW + i * 4_000));
    expect(seen.size).toBe(BLOQUEO_ES.field.examples.length);
    expect(examplePhrase(NOW + 3_999)).toBe(examplePhrase(NOW));
    for (const phrase of BLOQUEO_ES.field.examples) {
      const parse = parseIntent(phrase, { now: new Date(NOW) });
      expect(parse.complete, phrase).toBe(true);
      expect(parse.kind, phrase).toBe('block');
    }
  });
});

describe('typing', () => {
  it('shows the chips of what was understood', () => {
    const v = view('typing');
    expect(chipLabels(v)).toEqual(['YouTube', '1 h', 'hasta 18:00']);
    const said = composer(v).line;
    expect(said.kind === 'chips' && said.announce).toBe('Entendido: YouTube, 1 h, hasta 18:00');
    expect(composer(v).enter).toBe('card');
    const line = composer(v).line;
    expect(line.kind === 'chips' && line.note).toBeNull();
    const youtube = line.kind === 'chips' ? line.chips[0] : undefined;
    expect(youtube).toMatchObject({
      kind: 'service',
      monogram: expect.any(String),
      span: { start: 7, end: 14 },
    });
  });

  it('says what it did not understand, next to what it did', () => {
    const v = view('not-understood');
    expect(chipLabels(v)).toEqual(['YouTube']);
    const line = composer(v).line;
    expect(line.kind === 'chips' && line.note).toEqual({
      tone: 'muted',
      text: 'No he entendido: "mañana tarde"',
    });
    expect(line.kind === 'chips' && line.announce).toBe(
      'Entendido: YouTube. No he entendido: "mañana tarde"',
    );
    expect(composer(v).enter).toBe('bloqueos');
  });

  it('says what is missing when Enter will open Bloqueos', () => {
    const state = mainState('idle');
    const typed = (text: string): ComposerView =>
      composer(
        deriveBloqueoView(
          { ...state, main: { ...state.main, composer: { text, openWhileActive: false } } },
          NOW,
        ),
      );
    const noTime = typed('no veo yt');
    expect(noTime.line.kind === 'chips' && noTime.line.note?.text).toBe('falta cuánto tiempo');
    const noTarget = typed('estudiar mates 1 hora');
    expect(noTarget.line.kind === 'chips' && noTarget.line.chips.map((c) => c.label)).toEqual([
      'mates',
      '1 h',
      'hasta 18:00',
    ]);
    expect(noTarget.line.kind === 'chips' && noTarget.line.note?.text).toBe('falta qué bloquear');
    const nothing = typed('no quiero');
    expect(nothing.line.kind === 'chips' && nothing.line.note?.text).toBe(
      'No he entendido: "no quiero"',
    );
  });

  it('offers the line fewer targets behind «+N» when the chips do not fit', () => {
    const state = mainState('idle');
    const text =
      'no veo tiktok ni youtube ni instagram ni twitch ni netflix ni discord ni reddit 1h';
    const c = composer(
      deriveBloqueoView(
        { ...state, main: { ...state.main, composer: { text, openWhileActive: false } } },
        NOW,
      ),
    );
    const candidates = c.line.kind === 'chips' ? c.line.candidates : [];
    expect(candidates[0]).toHaveLength(9);
    const labels = (candidates[3] ?? []).map((ch) => ch.label);
    expect(labels).toContain('1 h');
    expect(labels).toContain('hasta 18:00');
    expect(labels).toContain('+3');
  });
});

describe('confirmation card', () => {
  it('confirm-normal: chips, modes, reason and «Bloquear hasta 18:00»', () => {
    const c = card(view('confirm-normal'));
    expect(c.status).toBe('edit');
    expect(c.editable).toBe(true);
    expect(c.composer).toEqual({ value: 'no veo YouTube en una hora' });
    expect(c.chips.map((ch) => ch.label)).toEqual(['YouTube', '1 h', 'hasta 18:00']);
    expect(c.chips.map((ch) => ch.field)).toEqual(['targets', 'duration', 'end']);
    expect(c.modes.map((m) => [m.label, m.selected, m.accent])).toEqual([
      ['Normal', true, 'blue'],
      ['Estricto', false, 'orange'],
      ['Hardcore', false, 'red'],
      ['Examen', false, 'red'],
    ]);
    expect(c.modeHelp).toBe('Normal: la emergencia tarda 10 min y cuesta al menos 200 puntos');
    expect(c.reason).toBe('Quiero aprobar mates');
    expect(c.actions.map((a) => [a.id, a.label, a.primary, a.disabled, a.span])).toEqual([
      ['edit', 'Editar…', false, false, 1],
      ['confirm', 'Bloquear hasta 18:00', true, false, 3],
    ]);
    expect(c.actionsHelp).toEqual({
      kind: 'text',
      tone: 'muted',
      text: 'Solo se puede ampliar, nunca acortar',
    });
    expect(c.summary).toBe('Bloquea YouTube durante 1 hora, hasta las 18:00, modo Normal');
  });

  it('the summary names every target, the spoken duration, the end and the mode', () => {
    const state = mainState('confirm-normal');
    const current = state.main.card;
    if (!current) throw new Error('no card');
    const withDraft = (draft: Partial<typeof current.draft>): CardView =>
      card(
        deriveBloqueoView(
          {
            ...state,
            main: { ...state.main, card: { ...current, draft: { ...current.draft, ...draft } } },
          },
          NOW,
        ),
      );
    expect(
      withDraft({
        targets: { ...current.draft.targets, serviceIds: ['youtube', 'instagram', 'tiktok'] },
        mode: 'strict',
      }).summary,
    ).toBe('Bloquea YouTube, Instagram y TikTok durante 1 hora, hasta las 18:00, modo Estricto');
    expect(withDraft({ targets: { ...current.draft.targets, serviceIds: [] } }).summary).toBe(
      'Nada elegido para bloquear. 1 hora, hasta las 18:00, modo Normal',
    );
    expect(card(view('confirm-hardcore')).summary).toBe(
      'Bloquea Juegos durante 1 hora y 30 minutos, hasta las 18:30, modo Hardcore',
    );
    expect(card(view('confirm-exam')).summary).toBe(
      'Bloquea todo salvo la lista blanca durante 3 horas, hasta las 20:00, modo Examen',
    );
  });

  it('explains the hovered mode', () => {
    const state = mainState('confirm-normal');
    const hovered = {
      ...state,
      main: { ...state.main, help: { row: 'bloqueo-modes', item: 'strict' } },
    };
    expect(card(deriveBloqueoView(hovered, NOW)).modeHelp).toBe(
      'Estricto: la emergencia tarda 30 min y cuesta al menos 200 puntos',
    );
  });

  it('confirm-over-4h: red consequence and «Sí, bloquear 6 h» locked for 2 s', () => {
    const c = card(view('confirm-over-4h'));
    expect(c.status).toBe('consequence');
    expect(c.actionsHelp).toEqual({
      kind: 'text',
      tone: 'red',
      text: '6 h: termina a las 23:00 y solo se puede ampliar',
    });
    const confirm = c.actions.find((a) => a.id === 'confirm');
    expect(confirm).toMatchObject({ label: 'Sí, bloquear 6 h', locked: true, disabled: false });
    expect(c.unlockAt).toBe(NOW - 600 + 2_000);
    const later = card(view('confirm-over-4h', NOW + 1_400));
    expect(later.actions.find((a) => a.id === 'confirm')?.locked).toBe(false);
  });

  it('confirm-hardcore: «No podrás cancelarlo de ninguna forma hasta las 18:30»', () => {
    const c = card(view('confirm-hardcore'));
    expect(c.chips.map((ch) => ch.label)).toEqual(['Juegos', '1 h 30 min', 'hasta 18:30']);
    expect(c.modes.find((m) => m.selected)?.id).toBe('hardcore');
    expect(c.actionsHelp).toMatchObject({
      tone: 'red',
      text: 'No podrás cancelarlo de ninguna forma hasta las 18:30',
    });
    expect(c.actions.find((a) => a.id === 'confirm')?.label).toBe('Sí, bloquear 1 h 30 min');
  });

  it('confirm-exam: the whitelist, 3 h, no emergency', () => {
    const c = card(view('confirm-exam'));
    expect(c.composer).toBeNull();
    expect(c.chips.map((ch) => ch.label)).toEqual([
      'Todo salvo la lista blanca',
      '3 h',
      'hasta 20:00',
    ]);
    expect(c.modes.find((m) => m.selected)?.id).toBe('exam');
    expect(c.actionsHelp).toMatchObject({
      text: 'No podrás cancelarlo de ninguna forma hasta las 20:00',
    });
    expect(c.actions.find((a) => a.id === 'confirm')?.label).toBe('Sí, bloquear 3 h');
  });

  it('pending: «Bloqueando…», nothing editable, no spinner', () => {
    const c = card(view('pending'));
    expect(c.status).toBe('pending');
    expect(c.editable).toBe(false);
    expect(c.actions.find((a) => a.id === 'confirm')).toMatchObject({
      label: 'Bloqueando…',
      disabled: true,
      busy: true,
    });
    expect(c.summary).toBe('Bloquea YouTube durante 1 hora, hasta las 18:00, modo Normal');
    // Only «Bloqueando…» is busy (full contrast); a locked or ready button is not.
    for (const id of ['confirm-normal', 'confirm-over-4h', 'guardian-timeout'] as const) {
      expect(card(view(id)).actions.every((a) => !a.busy)).toBe(true);
    }
    expect(c.actions.find((a) => a.id === 'edit')?.disabled).toBe(true);
    expect(c.modes.every((m) => m.disabled)).toBe(true);
  });

  it('pending without the card (reloaded window) draws the request being sent', () => {
    const state = mainState('pending');
    const c = card(deriveBloqueoView({ ...state, main: { ...state.main, card: null } }, NOW));
    expect(c.chips.map((ch) => ch.label)).toEqual(['YouTube', '1 h', 'hasta 18:00']);
    expect(c.composer).toBeNull();
  });

  it('guardian-timeout: «El guardián no responde · Reintentar · Reparar», frozen card', () => {
    const c = card(view('guardian-timeout'));
    expect(c.status).toBe('failed');
    expect(c.editable).toBe(false);
    expect(c.actions.map((a) => [a.id, a.label, a.primary])).toEqual([
      ['repair', 'Reparar', false],
      ['retry', 'Reintentar', true],
    ]);
    expect(c.actionsHelp).toEqual({ kind: 'error', error: uiError('timeout') });
  });

  it('a rejected create keeps the card editable, with the error on its help line', () => {
    const state = mainState('guardian-timeout');
    const create = state.snapshot.ops.create;
    if (!create) throw new Error('fixture without create');
    const rejected: UiState = {
      ...state,
      snapshot: {
        ...state.snapshot,
        ops: {
          ...state.snapshot.ops,
          create: { ...create, error: uiError('rejected', 'too_many_targets', 422) },
        },
      },
    };
    const c = card(deriveBloqueoView(rejected, NOW));
    expect(c.editable).toBe(true);
    expect(c.actions.map((a) => a.id)).toEqual(['edit', 'confirm']);
    expect(c.actionsHelp).toMatchObject({ kind: 'error', error: { code: 'too_many_targets' } });
  });

  it('shows a problem instead of sending (over 24 h, nothing to block)', () => {
    const state = mainState('confirm-normal');
    const current = state.main.card;
    if (!current) throw new Error('no card');
    const tooLong = {
      ...state,
      main: {
        ...state.main,
        card: {
          ...current,
          draft: { ...current.draft, end: { kind: 'duration' as const, minutes: 1500 } },
        },
      },
    };
    const c = card(deriveBloqueoView(tooLong, NOW));
    expect(c.problem).toBe('too_long');
    expect(c.actions.find((a) => a.id === 'confirm')?.disabled).toBe(true);
    expect(c.actionsHelp).toEqual({ kind: 'text', tone: 'orange', text: 'Como mucho 24 h' });
  });
});

describe('active', () => {
  it('one-block: header, countdown, mode bar, reason, extend row, emergency link', () => {
    const v = view('one-block');
    expect(v.header).toEqual({
      title: 'Bloqueo: YouTube, Instagram · Estricto',
      titles: [
        'Bloqueo: YouTube, Instagram · Estricto',
        'Bloqueo: YouTube +1 · Estricto',
        'Bloqueo: 2 · Estricto',
      ],
      datum: 'hasta 17:42',
      datumTone: 'default',
      newPill: true,
    });
    const a = active(v);
    expect(a.endsAt).toBe('2026-09-28T15:42:10.000Z');
    expect(a.bar.accent).toBe('orange');
    expect(a.bar.value).toBeGreaterThan(0.29);
    expect(a.bar.value).toBeLessThan(0.3);
    expect(a.reason).toBe('Quiero aprobar mates');
    expect(a.extend?.tiles.map((t) => [t.label, t.disabled, t.door])).toEqual([
      ['+15 min', false, false],
      ['+30 min', false, false],
      ['+1 h', false, false],
      ['Otro…', false, true],
    ]);
    // Alt shortcuts: an underlined character of each label, never a Ctrl+E chord digit (1-4),
    // so Alt+<digit> and Ctrl+E <digit> can never name different amounts.
    const mnemonics = a.extend?.tiles.map((t) => t.mnemonic) ?? [];
    expect(mnemonics).toEqual(['5', '0', 'h', 'o']);
    for (const [i, t] of (a.extend?.tiles ?? []).entries()) {
      expect(t.label.toLowerCase()).toContain(mnemonics[i]);
      expect(['1', '2', '3', '4']).not.toContain(mnemonics[i]);
    }
    expect(a.extend?.tiles[0]?.help).toBe('+15 min: termina a las 17:57');
    expect(a.extend?.help).toBe('Solo se puede ampliar, nunca acortar');
    expect(a.extend?.undo).toBeNull();
    expect(a.rows).toEqual([]);
    expect(a.more).toBeNull();
    expect(a.emergency).toMatchObject({
      kind: 'link',
      label: 'Desbloqueo de emergencia…',
      request: { name: 'emergencia', blockIds: null },
    });
    expect(a.composer).toBeNull();
  });

  it('never offers a way to shorten', () => {
    for (const id of HARNESS_STATE_IDS) {
      const v = view(id);
      const labels = JSON.stringify(v);
      expect(labels).not.toMatch(/acortar ahora|Quitar tiempo|−\d+ min/);
    }
  });

  it('three-blocks: the latest end is big, the others are rows', () => {
    const v = view('three-blocks');
    expect(v.header.title).toBe('Bloqueo: Redes sociales · Estricto');
    expect(v.header.datum).toBe('hasta 19:10');
    const a = active(v);
    expect(a.endsAt).toBe('2026-09-28T17:10:05.000Z');
    expect(a.rows.map((r) => [r.label, r.accent])).toEqual([
      ['YouTube, Instagram · Estricto', 'orange'],
      ['Juegos · Hardcore', 'red'],
    ]);
    expect(a.more).toBeNull();
  });

  it('many-blocks: two rows, then «y 3 más…» opens Bloqueos', () => {
    const a = active(view('many-blocks'));
    expect(a.rows).toHaveLength(2);
    expect(a.more).toMatchObject({
      count: 3,
      label: 'y 3 más…',
      request: { name: 'bloqueos', seed: null, focus: 'active' },
    });
  });

  it('extend-undo: «+30 min · termina a las 18:12 · Deshacer (4 s)»', () => {
    const undo = active(view('extend-undo')).extend?.undo;
    expect(undo).toEqual({
      kind: 'waiting',
      entryId: 'extend-fixture-0001',
      text: '+30 min · termina a las 18:12',
      button: 'Deshacer (4 s)',
      buttonLabel: 'Deshacer la ampliación de +30 min',
      announce: '+30 min, termina a las 18:12. Puedes deshacerlo durante 5 segundos',
    });
    expect(active(view('extend-undo', NOW + 3_000)).extend?.undo).toMatchObject({
      button: 'Deshacer (1 s)',
    });
  });

  it('shows sending and failed extensions', () => {
    const state = mainState('extend-undo');
    const entry = state.snapshot.ops.extendQueue[0];
    if (!entry) throw new Error('no entry');
    const withStatus = (status: 'sending' | 'failed'): UiState => ({
      ...state,
      snapshot: {
        ...state.snapshot,
        ops: { ...state.snapshot.ops, extendQueue: [{ ...entry, status }] },
      },
    });
    expect(active(deriveBloqueoView(withStatus('sending'), NOW)).extend?.undo).toEqual({
      kind: 'sending',
      entryId: entry.id,
      text: '+30 min · ampliando…',
      announce: null,
    });
    expect(active(deriveBloqueoView(withStatus('failed'), NOW)).extend?.undo).toEqual({
      kind: 'failed',
      entryId: entry.id,
      text: 'No se pudo ampliar',
      button: 'Reintentar',
      announce: 'No se pudo ampliar: puedes reintentarlo',
    });
  });

  it('counts queued minutes against the 24 h rule', () => {
    const state = mainState('one-block');
    const block = state.snapshot.state?.blocks[0];
    if (!block) throw new Error('no block');
    const nearMax: UiState = {
      ...state,
      snapshot: {
        ...state.snapshot,
        state: state.snapshot.state && {
          ...state.snapshot.state,
          blocks: [{ ...block, endsAt: new Date(NOW + (1440 - 20) * 60_000).toISOString() }],
        },
      },
    };
    const tiles = active(deriveBloqueoView(nearMax, NOW)).extend?.tiles ?? [];
    expect(tiles.map((t) => t.disabled)).toEqual([false, true, true, false]);
    expect(tiles[1]?.disabledReason).toBe('Como mucho 24 h en total');
  });

  it('«Otro…» previews the extension or says why not', () => {
    const state = mainState('one-block');
    const other = (text: string) =>
      active(
        deriveBloqueoView(
          { ...state, main: { ...state.main, extendOther: { open: true, text } } },
          NOW,
        ),
      ).extend?.other;
    expect(other('')).toMatchObject({
      open: true,
      canApply: false,
      line: { text: 'Enter amplía · Esc cancela' },
    });
    expect(other('20')).toMatchObject({
      minutes: 20,
      canApply: true,
      line: { tone: 'muted', text: '+20 min · termina a las 18:02' },
    });
    expect(other('mucho')).toMatchObject({
      canApply: false,
      line: { tone: 'orange', text: 'Escribe cuánto: 20 min, 1 h, 1h30…' },
    });
    expect(other('24 h')).toMatchObject({ canApply: false, line: { tone: 'orange' } });
  });

  it('emergency: counting and ready from the guardian', () => {
    expect(active(view('emergency-waiting')).emergency).toMatchObject({
      kind: 'link',
      label: 'Emergencia: 8:12',
    });
    expect(active(view('emergency-ready')).emergency).toMatchObject({
      kind: 'link',
      label: 'Emergencia: lista',
    });
  });

  it('hardcore-block: «Hardcore: no se puede cancelar» and a red bar', () => {
    const v = view('hardcore-block');
    expect(v.header.title).toMatch(/^Bloqueo: TikTok.* · Hardcore$/);
    const a = active(v);
    expect(a.emergency).toEqual({ kind: 'text', label: 'Hardcore: no se puede cancelar' });
    expect(a.bar.accent).toBe('red');
  });

  it('boot-hold: «Comprobando la hora…» in place of the countdown', () => {
    const v = view('boot-hold');
    expect(v.header.datum).toBeNull();
    const a = active(v);
    expect(a.endsAt).toBeNull();
    expect(a.bootHold).toBe('Comprobando la hora…');
    expect(a.extend).toBeNull();
    expect(a.emergency).toBeNull();
  });

  it('«Nuevo» opens the field and the templates under the block', () => {
    const state = mainState('one-block');
    const v = deriveBloqueoView(
      { ...state, main: { ...state.main, composer: { text: '', openWhileActive: true } } },
      NOW,
    );
    expect(v.header.newPill).toBe(false);
    expect(active(v).composer?.templates).toHaveLength(4);
  });
});

describe('punishment and finished', () => {
  it('punishment: red bar, cause, −100 puntos, no extend row', () => {
    const v = view('punishment');
    expect(v.header.title).toBe('Castigo: todas las distracciones · 60 min');
    expect(v.header.newPill).toBe(false);
    expect(v.header.datum).toBe('hasta 17:38');
    const a = active(v);
    expect(a.bar.accent).toBe('red');
    expect(a.punishment).toEqual({ cause: '3 strikes en "mates"', points: '−100 puntos' });
    expect(a.extend).toBeNull();
    expect(a.reason).toBeNull();
  });

  it('finished: «Bloqueo: terminado» · «Hecho. +80 puntos» in green, for 1 min', () => {
    const v = view('finished');
    expect(v.header).toEqual({
      title: 'Bloqueo: terminado',
      titles: ['Bloqueo: terminado'],
      datum: 'Hecho. +80 puntos',
      datumTone: 'green',
      newPill: false,
    });
    expect(composer(v).templates).toHaveLength(4);
    expect(view('finished', NOW + 45_000).variant).toBe('idle');
  });
});

describe('assignMnemonics', () => {
  it('gives each label its first free letter', () => {
    expect(assignMnemonics(['Deberes 1 h', 'Examen 3 h', 'Leer 30 min', 'Más…'])).toEqual([
      'd',
      'e',
      'l',
      'm',
    ]);
    expect(assignMnemonics(['Estricto', 'Examen'])).toEqual(['e', 'x']);
    expect(assignMnemonics(['Más…'], ['m'])).toEqual(['a']);
  });
});

describe('Alt + letter', () => {
  it.each(HARNESS_STATE_IDS)('%s: letters are unique and avoid the shell’s', (id) => {
    const v = view(id);
    const letters: (string | null)[] = [];
    const b = v.body;
    const composerLetters = (c: ComposerView | null): void => {
      if (c) letters.push(...c.templates.map((t) => t.mnemonic));
    };
    if (b.kind === 'composer') composerLetters(b.composer);
    if (b.kind === 'card')
      letters.push(...b.modes.map((m) => m.mnemonic), ...b.actions.map((a) => a.mnemonic ?? null));
    if (b.kind === 'active') {
      letters.push(...(b.extend?.tiles.map((t) => t.mnemonic) ?? []));
      composerLetters(b.composer);
    }
    const used = letters.filter((l): l is string => l !== null);
    expect(new Set(used).size).toBe(used.length);
    for (const l of used) expect(RESERVED_MNEMONICS).not.toContain(l);
  });

  it('keeps the extend letters free for templates under an active block', () => {
    const state = mainState('one-block');
    const v = deriveBloqueoView(
      { ...state, main: { ...state.main, composer: { text: '', openWhileActive: true } } },
      NOW,
    );
    const b = active(v);
    const all = [
      ...(b.extend?.tiles.map((t) => t.mnemonic) ?? []),
      ...(b.composer?.templates.map((t) => t.mnemonic) ?? []),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
