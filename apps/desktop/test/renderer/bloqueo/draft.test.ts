import { describe, expect, it } from 'vitest';
import { emptyTargets } from '@centrate/shared/guardian-api';
import type { ParseResult } from '@centrate/shared/parser';
import { HARNESS_NOW } from '../../../src/shared/fixtures';
import {
  DEFAULT_PREFS,
  DEFAULT_TEMPLATES,
  draftToCreateRequest,
  type BlockDraft,
  type UiPrefs,
} from '../../../src/shared/ui-state';
import {
  applyChipEdit,
  cardAdvance,
  cardBack,
  cardForTemplate,
  cardWithDraft,
  cardWithMode,
  cardWithReason,
  chipEditText,
  consequenceUnlockAt,
  draftEndLabels,
  draftFromRequest,
  fieldEnter,
  isConsequenceLocked,
  newCard,
  parseExtendMinutes,
  parsePhrase,
  studyReason,
  visibleTemplates,
} from '../../../src/renderer/src/sections/bloqueo/draft';

const NOW = HARNESS_NOW; // Monday 2026-09-28 17:00 Madrid (15:00 UTC).
const MIN = 60_000;
const PREFS: UiPrefs = { ...DEFAULT_PREFS, lastReason: 'Quiero aprobar mates' };

function enter(text: string, prefs: UiPrefs = PREFS) {
  return fieldEnter(text, parsePhrase(text, NOW), prefs);
}

function cardDraft(text: string): BlockDraft {
  const outcome = enter(text);
  if (outcome.kind !== 'card') throw new Error(`expected a card for «${text}»`);
  return outcome.draft;
}

describe('fieldEnter (Enter in «¿Qué quieres hacer?»)', () => {
  it('does nothing on an empty field', () => {
    expect(enter('')).toEqual({ kind: 'none' });
    expect(enter('   ')).toEqual({ kind: 'none' });
  });

  it('opens the card for a phrase the parser fully understood, with the defaults', () => {
    const draft = cardDraft('no veo YouTube en una hora');
    expect(draft.targets.serviceIds).toEqual(['youtube']);
    expect(draft.end).toEqual({ kind: 'duration', minutes: 60 });
    expect(draft.mode).toBe('normal');
    expect(draft.reason).toBe('Quiero aprobar mates');
    expect(cardDraft('sin juegos hora y media').targets.categoryIds).toEqual(['games']);
  });

  it('uses the default mode from Ajustes', () => {
    const outcome = enter('no quiero ver Netflix 2h', { ...PREFS, defaultMode: 'strict' });
    expect(outcome.kind === 'card' && outcome.draft.mode).toBe('strict');
  });

  it('keeps an «hasta las 20:30» end as a clock time', () => {
    const draft = cardDraft('bloquea las redes sociales hasta las 20:30');
    expect(draft.end).toEqual({ kind: 'until', endsAt: '2026-09-28T18:30:00.000Z' });
  });

  it('opens Bloqueos with what was understood when the phrase is not fully understood', () => {
    expect(enter('no veo YouTube mañana tarde')).toEqual({
      kind: 'bloqueos',
      seed: {
        phrase: 'no veo YouTube mañana tarde',
        targets: { ...emptyTargets(), serviceIds: ['youtube'] },
        end: null,
        mode: null,
        reason: null,
      },
    });
    const noDuration = enter('no veo yt');
    expect(noDuration.kind).toBe('bloqueos');
    const nothing = enter('hola');
    expect(nothing).toEqual({
      kind: 'bloqueos',
      seed: { phrase: 'hola', targets: null, end: null, mode: null, reason: null },
    });
  });

  it('never invents a block from a study phrase without services', () => {
    expect(enter('estudiar mates 1 hora')).toEqual({
      kind: 'bloqueos',
      seed: {
        phrase: 'estudiar mates 1 hora',
        targets: null,
        end: { kind: 'duration', minutes: 60 },
        mode: null,
        reason: 'Estudiar mates',
      },
    });
  });

  it('proposes a normal block of the services a study phrase names, with the task as reason', () => {
    const draft = cardDraft('estudiar mates sin youtube 1 hora');
    expect(draft.targets.serviceIds).toEqual(['youtube']);
    expect(draft.end).toEqual({ kind: 'duration', minutes: 60 });
    expect(draft.reason).toBe('Estudiar mates');
    expect(draft.mode).toBe('normal');
  });

  it('keeps an out-of-range duration as typed (the card shows the limit)', () => {
    const draft = cardDraft('no veo youtube 30 horas');
    expect(draft.end).toEqual({ kind: 'duration', minutes: 1800 });
  });
});

describe('studyReason', () => {
  it('reuses the user’s own words up to the task', () => {
    const text = 'quiero estudiar mates 1 hora';
    expect(studyReason(text, parsePhrase(text, NOW))).toBe('Quiero estudiar mates');
  });

  it('falls back to «Estudiar …» when something else was read before the task', () => {
    const text = '1 hora estudiar mates';
    const parse: ParseResult = {
      kind: 'study',
      serviceIds: [],
      categoryIds: [],
      domains: [],
      durationMinutes: 60,
      task: 'mates',
      chips: [
        { kind: 'duration', label: '1 h', value: '60', start: 0, end: 6 },
        { kind: 'task', label: 'mates', value: 'mates', start: 16, end: 21 },
      ],
      unparsed: [],
      warnings: [],
      complete: true,
    };
    expect(studyReason(text, parse)).toBe('Estudiar mates');
  });

  it('is empty without a task', () => {
    expect(studyReason('no veo YouTube 1 h', parsePhrase('no veo YouTube 1 h', NOW))).toBe('');
  });
});

describe('the card', () => {
  const base = () =>
    newCard(cardDraft('no veo YouTube en una hora'), 'intent-1', 'phrase', {
      phrase: 'no veo YouTube en una hora',
    });

  it('submits exactly the request built from the phrase and the edits', () => {
    let card = base();
    card = cardWithMode(card, 'strict');
    card = cardWithReason(card, 'Examen el viernes\n');
    const edited = applyChipEdit(card.draft, 'duration', '45', NOW, PREFS);
    if (!edited.ok) throw new Error(edited.message);
    card = cardWithDraft(card, edited.draft);
    const step = cardAdvance(card, NOW);
    expect(step.kind).toBe('submit');
    if (step.kind !== 'submit') return;
    expect(step.request).toEqual({
      targets: { ...emptyTargets(), serviceIds: ['youtube'] },
      whitelistOnly: false,
      allow: { customDomains: [], customProcesses: [] },
      mode: 'strict',
      durationMinutes: 45,
      endsAt: null,
      reason: 'Examen el viernes',
      acknowledgeLong: false,
      acknowledgeNoEmergency: false,
    });
  });

  it('asks twice over 4 h and keeps the second press locked for 2 s', () => {
    const card = newCard(cardDraft('bloquea las redes sociales 6 horas'), 'intent-2', 'phrase');
    const first = cardAdvance(card, NOW);
    expect(first.kind).toBe('consequence');
    if (first.kind !== 'consequence') return;
    expect(first.card.consequenceAt).toBe(NOW);
    expect(consequenceUnlockAt(first.card)).toBe(NOW + 2_000);
    expect(isConsequenceLocked(first.card, NOW + 1_999)).toBe(true);
    expect(cardAdvance(first.card, NOW + 1_999).kind).toBe('none');
    const second = cardAdvance(first.card, NOW + 2_000);
    expect(second.kind).toBe('submit');
    if (second.kind !== 'submit') return;
    expect(second.request.acknowledgeLong).toBe(true);
    expect(second.request.acknowledgeNoEmergency).toBe(false);
  });

  it('asks twice for Hardcore and Examen', () => {
    const hardcore = cardWithMode(
      newCard(cardDraft('sin juegos hora y media'), 'i', 'phrase'),
      'hardcore',
    );
    expect(cardAdvance(hardcore, NOW).kind).toBe('consequence');
    const exam = cardForTemplate(DEFAULT_TEMPLATES, 'examen', PREFS, 'i2');
    if (!exam) throw new Error('missing examen');
    const step = cardAdvance(exam, NOW);
    expect(step.kind).toBe('consequence');
    const final = cardAdvance(step.card, NOW + 2_000);
    expect(final.kind === 'submit' && final.request).toMatchObject({
      whitelistOnly: true,
      mode: 'exam',
      durationMinutes: 180,
      acknowledgeNoEmergency: true,
      targets: emptyTargets(),
    });
  });

  it('goes back to the edit step when the draft changes, not when the reason does', () => {
    const card = newCard(cardDraft('bloquea las redes sociales 6 horas'), 'i', 'phrase');
    const step = cardAdvance(card, NOW);
    const withReason = cardWithReason(step.card, 'Leer');
    expect(withReason.step).toBe('consequence');
    const withMode = cardWithMode(step.card, 'strict');
    expect(withMode.step).toBe('edit');
    expect(withMode.consequenceAt).toBeNull();
  });

  it('refuses to submit a draft with a problem', () => {
    const tooLong = newCard(cardDraft('no veo youtube 30 horas'), 'i', 'phrase');
    expect(cardAdvance(tooLong, NOW).kind).toBe('none');
    const empty = applyChipEdit(tooLong.draft, 'targets', '', NOW, PREFS);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(
      cardAdvance(
        cardWithDraft(tooLong, { ...empty.draft, end: { kind: 'duration', minutes: 30 } }),
        NOW,
      ).kind,
    ).toBe('none');
  });

  it('does not submit while a chip is being corrected', () => {
    const card = { ...base(), editing: 'duration' as const };
    expect(cardAdvance(card, NOW).kind).toBe('none');
  });

  it('steps back: chip editor, then consequence, then closes', () => {
    const card = {
      ...base(),
      step: 'consequence' as const,
      consequenceAt: NOW,
      editing: 'targets' as const,
    };
    const a = cardBack(card);
    expect(a?.editing).toBeNull();
    expect(a?.step).toBe('consequence');
    const b = a ? cardBack(a) : null;
    expect(b?.step).toBe('edit');
    expect(b ? cardBack(b) : 'x').toBeNull();
  });

  it('cleans «Tu motivo» to one line of at most 140 characters', () => {
    const card = cardWithReason(base(), `a\nb${'x'.repeat(200)}`);
    expect(card.draft.reason.startsWith('a b')).toBe(true);
    expect(card.draft.reason).toHaveLength(140);
  });
});

describe('templates', () => {
  it('shows the first three templates as tiles', () => {
    expect(visibleTemplates(DEFAULT_TEMPLATES).map((t) => t.label)).toEqual([
      'Deberes 1 h',
      'Examen 3 h',
      'Leer 30 min',
    ]);
  });

  it('expands a template with the default mode and the last reason', () => {
    const card = cardForTemplate(
      DEFAULT_TEMPLATES,
      'deberes',
      { ...PREFS, defaultMode: 'strict' },
      'i',
    );
    expect(card?.origin).toBe('template');
    expect(card?.templateId).toBe('deberes');
    expect(card?.draft).toMatchObject({
      mode: 'strict',
      whitelistOnly: false,
      end: { kind: 'duration', minutes: 60 },
      reason: 'Quiero aprobar mates',
    });
    expect(card?.draft.targets.categoryIds).toEqual(['social', 'video', 'games', 'messaging']);
  });

  it('returns null for an unknown template', () => {
    expect(cardForTemplate(DEFAULT_TEMPLATES, 'nope', PREFS, 'i')).toBeNull();
  });
});

describe('duration ⇄ end', () => {
  it('shows both views of a duration', () => {
    expect(draftEndLabels(cardDraft('no veo YouTube en una hora'), NOW)).toMatchObject({
      duration: '1 h',
      until: 'hasta 18:00',
      minutes: 60,
      endsAtMs: NOW + 60 * MIN,
    });
  });

  it('shows both views of a clock end', () => {
    const draft = cardDraft('bloquea las redes sociales hasta las 20:30');
    expect(draftEndLabels(draft, NOW)).toMatchObject({
      duration: '3 h 30 min',
      until: 'hasta 20:30',
    });
    expect(draftEndLabels(draft, NOW + 30 * MIN).duration).toBe('3 h');
  });

  it('crosses midnight', () => {
    const draft: BlockDraft = {
      ...cardDraft('no veo YouTube en una hora'),
      end: { kind: 'duration', minutes: 8 * 60 },
    };
    expect(draftEndLabels(draft, NOW).until).toBe('hasta mañana 01:00');
  });
});

describe('chip corrections', () => {
  const draft = () => cardDraft('no veo YouTube en una hora');

  it('starts the editor with the current value', () => {
    const d = draft();
    expect(chipEditText(d, 'targets', NOW)).toBe('YouTube');
    expect(chipEditText(d, 'duration', NOW)).toBe('1 h');
    expect(chipEditText(d, 'end', NOW)).toBe('18:00');
  });

  it('replaces services, categories and domains, keeping apps and processes', () => {
    const d = {
      ...draft(),
      targets: { ...draft().targets, appIds: ['steam'], customProcesses: ['foo.exe'] },
    };
    const result = applyChipEdit(d, 'targets', 'yt, redes, marca.com', NOW, PREFS);
    expect(result.ok && result.draft.targets).toEqual({
      serviceIds: ['youtube'],
      categoryIds: ['social'],
      appIds: ['steam'],
      customDomains: ['marca.com'],
      customProcesses: ['foo.exe'],
    });
  });

  it('refuses targets it does not understand', () => {
    const result = applyChipEdit(draft(), 'targets', 'mañana tarde', NOW, PREFS);
    expect(result).toEqual({ ok: false, message: 'No he entendido: "mañana tarde"' });
  });

  it('leaves Examen when targets are chosen', () => {
    const exam = cardForTemplate(DEFAULT_TEMPLATES, 'examen', PREFS, 'i');
    if (!exam) throw new Error('missing');
    const result = applyChipEdit(exam.draft, 'targets', 'tiktok', NOW, PREFS);
    expect(result.ok && result.draft).toMatchObject({ mode: 'normal', whitelistOnly: false });
  });

  it('reads durations', () => {
    const d = draft();
    const cases: Array<[string, number]> = [
      ['45', 45],
      ['1h30', 90],
      ['hora y media', 90],
      ['2 h', 120],
      ['30 min', 30],
    ];
    for (const [text, minutes] of cases) {
      const result = applyChipEdit(d, 'duration', text, NOW, PREFS);
      expect(result.ok && result.draft.end, text).toEqual({ kind: 'duration', minutes });
    }
    expect(applyChipEdit(d, 'duration', 'youtube', NOW, PREFS).ok).toBe(false);
    expect(applyChipEdit(d, 'duration', 'pronto', NOW, PREFS).ok).toBe(false);
  });

  it('reads end times', () => {
    const d = draft();
    const cases: Array<[string, string]> = [
      ['18:30', '2026-09-28T16:30:00.000Z'],
      ['20', '2026-09-28T18:00:00.000Z'],
      ['hasta las 21:15', '2026-09-28T19:15:00.000Z'],
      ['mañana a las 8', '2026-09-29T06:00:00.000Z'],
      ['mañana 08:00', '2026-09-29T06:00:00.000Z'],
    ];
    for (const [text, endsAt] of cases) {
      const result = applyChipEdit(d, 'end', text, NOW, PREFS);
      expect(result.ok && result.draft.end, text).toEqual({ kind: 'until', endsAt });
    }
    expect(applyChipEdit(d, 'end', 'cuando pueda', NOW, PREFS).ok).toBe(false);
  });

  it('round-trips the end chip text', () => {
    const d: BlockDraft = { ...draft(), end: { kind: 'duration', minutes: 15 * 60 } };
    const text = chipEditText(d, 'end', NOW);
    expect(text).toBe('mañana 08:00');
    const result = applyChipEdit(d, 'end', text, NOW, PREFS);
    expect(result.ok && result.draft.end).toEqual({
      kind: 'until',
      endsAt: '2026-09-29T06:00:00.000Z',
    });
  });
});

describe('«Otro…» minutes', () => {
  it('reads numbers and durations', () => {
    expect(parseExtendMinutes('20', NOW)).toBe(20);
    expect(parseExtendMinutes(' 90 ', NOW)).toBe(90);
    expect(parseExtendMinutes('1h30', NOW)).toBe(90);
    expect(parseExtendMinutes('hora y media', NOW)).toBe(90);
    expect(parseExtendMinutes('2 h', NOW)).toBe(120);
  });

  it('refuses anything else', () => {
    for (const text of ['', '0', 'abc', 'youtube 1h', 'hasta las 20:00', '-5']) {
      expect(parseExtendMinutes(text, NOW), text).toBeNull();
    }
  });
});

describe('draftFromRequest', () => {
  it('round-trips duration and clock requests', () => {
    for (const text of [
      'no veo YouTube en una hora',
      'bloquea las redes sociales hasta las 20:30',
    ]) {
      const request = draftToCreateRequest(cardDraft(text), NOW);
      expect(draftToCreateRequest(draftFromRequest(request), NOW)).toEqual(request);
    }
  });
});
