import { describe, expect, it } from 'vitest';
import { HARNESS_NOW, harnessFixture, type HarnessStateId } from '../../../src/shared/fixtures';
import {
  initialMainLocal,
  uiError,
  type MainLocalState,
  type UiSnapshot,
} from '../../../src/shared/ui-state';
import {
  ESCAPE_STAGES,
  cardCreateState,
  enterBloqueo,
  escapeBloqueo,
  escapeStage,
  openDraft,
  openField,
  openTemplate,
  typeInField,
  updateCard,
} from '../../../src/renderer/src/sections/bloqueo/reducer';
import { cardWithMode, cardWithReason } from '../../../src/renderer/src/sections/bloqueo/draft';

const NOW = HARNESS_NOW;

function ids(): () => string {
  let n = 0;
  return () => `intent-test-${++n}`;
}

function fixture(id: HarnessStateId): { snapshot: UiSnapshot; main: MainLocalState } {
  const f = harnessFixture(id);
  return { snapshot: f.snapshot, main: f.main };
}

function rejected(snapshot: UiSnapshot): UiSnapshot {
  const create = snapshot.ops.create;
  if (!create) throw new Error('no create');
  return {
    ...snapshot,
    ops: {
      ...snapshot.ops,
      create: { ...create, error: uiError('rejected', 'too_many_targets', 422) },
    },
  };
}

describe('Enter: write + 2 Enter creates a block', () => {
  it('field → card → create', () => {
    const { snapshot, main } = fixture('typing');
    const newId = ids();
    const first = enterBloqueo(snapshot, main, NOW, newId);
    expect(first.kind).toBe('update');
    expect(first.focus).toBe('confirm');
    expect(first.main.card).toMatchObject({
      intentId: 'intent-test-1',
      origin: 'phrase',
      phrase: 'no veo YouTube en una hora',
      step: 'edit',
    });
    const second = enterBloqueo(snapshot, first.main, NOW, newId);
    expect(second.kind).toBe('submit');
    if (second.kind !== 'submit') return;
    expect(second.intentId).toBe('intent-test-1');
    expect(second.request).toMatchObject({
      targets: { serviceIds: ['youtube'] },
      mode: 'normal',
      durationMinutes: 60,
      reason: 'Quiero aprobar mates',
      acknowledgeLong: false,
    });
    expect(second.dismissIntentId).toBeNull();
  });

  it('a phrase that is not understood opens Bloqueos with what was understood', () => {
    const { snapshot, main } = fixture('not-understood');
    const outcome = enterBloqueo(snapshot, main, NOW, ids());
    expect(outcome.kind).toBe('open-detail');
    if (outcome.kind !== 'open-detail') return;
    expect(outcome.request).toMatchObject({
      name: 'bloqueos',
      focus: 'form',
      seed: { phrase: 'no veo YouTube mañana tarde', targets: { serviceIds: ['youtube'] } },
    });
    expect(outcome.main).toBe(main);
  });

  it('an empty field does nothing', () => {
    const { snapshot, main } = fixture('idle');
    expect(enterBloqueo(snapshot, main, NOW, ids()).kind).toBe('none');
  });

  it('> 4 h: the second Enter only counts after 2 s', () => {
    const { snapshot, main } = fixture('confirm-over-4h');
    const newId = ids();
    // The fixture shows the consequence line since 600 ms.
    expect(enterBloqueo(snapshot, main, NOW, newId).kind).toBe('none');
    const later = enterBloqueo(snapshot, main, NOW + 1_400, newId);
    expect(later.kind).toBe('submit');
    if (later.kind === 'submit') expect(later.request.acknowledgeLong).toBe(true);
  });

  it('Hardcore from the edit step: first Enter shows the consequence', () => {
    const { snapshot, main } = fixture('confirm-normal');
    const card = main.card;
    if (!card) throw new Error('no card');
    const hardcore = { ...main, card: cardWithMode(card, 'hardcore') };
    const first = enterBloqueo(snapshot, hardcore, NOW, ids());
    expect(first.kind).toBe('update');
    expect(first.main.card?.step).toBe('consequence');
    expect(first.main.card?.consequenceAt).toBe(NOW);
    expect(enterBloqueo(snapshot, first.main, NOW + 1_000, ids()).kind).toBe('none');
    const final = enterBloqueo(snapshot, first.main, NOW + 2_000, ids());
    expect(final.kind === 'submit' && final.request.acknowledgeNoEmergency).toBe(true);
  });

  it('does nothing while «Bloqueando…»', () => {
    const { snapshot, main } = fixture('pending');
    expect(enterBloqueo(snapshot, main, NOW, ids()).kind).toBe('none');
  });

  it('retries an unanswered create with the same intent (same Idempotency-Key)', () => {
    const { snapshot, main } = fixture('guardian-timeout');
    const outcome = enterBloqueo(snapshot, main, NOW, ids());
    expect(outcome).toMatchObject({ kind: 'retry', intentId: 'intent-fixture-0001' });
  });

  it('after a rejected create, sends the corrected card with a new intent and dismisses the old', () => {
    const { snapshot, main } = fixture('guardian-timeout');
    const outcome = enterBloqueo(rejected(snapshot), main, NOW, ids());
    expect(outcome.kind).toBe('submit');
    if (outcome.kind !== 'submit') return;
    expect(outcome.intentId).toBe('intent-test-1');
    expect(outcome.dismissIntentId).toBe('intent-fixture-0001');
  });
});

describe('editing a card around a create', () => {
  it('is frozen while sending or unanswered', () => {
    for (const id of ['pending', 'guardian-timeout'] as const) {
      const { snapshot, main } = fixture(id);
      const t = updateCard(snapshot, main, (c) => cardWithReason(c, 'otro'), ids());
      expect(t.main).toBe(main);
      expect(typeInField(snapshot, main, 'otra cosa').main).toBe(main);
    }
  });

  it('rotates the intent after a rejection (never replays a changed request)', () => {
    const { snapshot, main } = fixture('guardian-timeout');
    const t = updateCard(rejected(snapshot), main, (c) => cardWithReason(c, 'otro'), ids());
    expect(t.main.card?.intentId).toBe('intent-test-1');
    expect(t.main.card?.draft.reason).toBe('otro');
    expect(t.dismissIntentId).toBe('intent-fixture-0001');
  });

  it('classifies the create of a card', () => {
    expect(cardCreateState(fixture('pending').snapshot, fixture('pending').main.card)).toBe(
      'sending',
    );
    expect(
      cardCreateState(fixture('guardian-timeout').snapshot, fixture('guardian-timeout').main.card),
    ).toBe('unanswered');
    const t = fixture('guardian-timeout');
    expect(cardCreateState(rejected(t.snapshot), t.main.card)).toBe('rejected');
    expect(
      cardCreateState(fixture('confirm-normal').snapshot, fixture('confirm-normal').main.card),
    ).toBe('none');
  });

  it('typing closes a card built from the old text', () => {
    const { snapshot, main } = fixture('confirm-normal');
    const t = typeInField(snapshot, main, 'no veo YouTube en dos horas');
    expect(t.main.card).toBeNull();
    expect(t.main.composer.text).toBe('no veo YouTube en dos horas');
    expect(t.dismissIntentId).toBeNull();
  });
});

describe('templates, drafts and «Nuevo»', () => {
  it('a template opens its card with the confirm button focused', () => {
    const { snapshot, main } = fixture('idle');
    const t = openTemplate(snapshot, main, 'examen', ids());
    expect(t.focus).toBe('confirm');
    expect(t.main.card).toMatchObject({
      origin: 'template',
      templateId: 'examen',
      draft: { mode: 'exam', whitelistOnly: true },
    });
    expect(openTemplate(snapshot, main, 'nope', ids()).main).toBe(main);
  });

  it('templates wait while a create is sending', () => {
    const { snapshot, main } = fixture('pending');
    expect(openTemplate(snapshot, main, 'deberes', ids()).main).toBe(main);
    expect(openDraft(snapshot, main, main.card!.draft, ids()).main).toBe(main);
  });

  it('a Bloqueos draft opens the card', () => {
    const { snapshot } = fixture('idle');
    const draft = fixture('confirm-normal').main.card!.draft;
    const t = openDraft(snapshot, initialMainLocal(), draft, ids());
    expect(t.main.card).toMatchObject({ origin: 'form', draft });
    expect(t.focus).toBe('confirm');
  });

  it('«Nuevo» opens the field under an active block', () => {
    const { snapshot, main } = fixture('one-block');
    const t = openField(snapshot, main);
    expect(t.main.composer.openWhileActive).toBe(true);
    expect(t.focus).toBe('field');
    const idle = fixture('idle');
    expect(openField(idle.snapshot, idle.main).main).toBe(idle.main);
  });
});

describe('the Esc cascade', () => {
  it('has the documented order', () => {
    expect(ESCAPE_STAGES).toEqual(['extendOther', 'consequence', 'card', 'newField', 'clearText']);
  });

  it('unwinds one step per Esc, then lets the window hide', () => {
    const { snapshot, main: base } = fixture('confirm-over-4h');
    let main: MainLocalState = {
      ...base,
      card: base.card && { ...base.card, editing: 'duration' },
      extendOther: { open: true, text: '20' },
    };
    const trail: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const t = escapeBloqueo(snapshot, main, NOW);
      if (!t) break;
      main = t.main;
      trail.push(
        main.extendOther.open
          ? 'other'
          : main.card?.editing
            ? 'editing'
            : main.card?.step === 'consequence'
              ? 'consequence'
              : main.card
                ? 'card'
                : main.composer.text !== ''
                  ? 'text'
                  : 'empty',
      );
    }
    expect(trail).toEqual(['editing', 'consequence', 'card', 'text', 'empty']);
    expect(escapeBloqueo(snapshot, main, NOW)).toBeNull();
  });

  it('closes a failed card and dismisses its create', () => {
    const { snapshot, main } = fixture('guardian-timeout');
    const t = escapeBloqueo(snapshot, main, NOW);
    expect(t?.main.card).toBeNull();
    expect(t?.dismissIntentId).toBe('intent-fixture-0001');
    // Without the card, the failed create is still dismissed.
    const again = escapeStage('card', snapshot, { ...main, card: null }, NOW);
    expect(again?.dismissIntentId).toBe('intent-fixture-0001');
  });

  it('cannot cancel «Bloqueando…»: Esc hides the window', () => {
    const { snapshot, main } = fixture('pending');
    expect(escapeStage('consequence', snapshot, main, NOW)).toBeNull();
    expect(escapeStage('card', snapshot, main, NOW)).toBeNull();
  });

  it('closes the field opened with «Nuevo», then hides', () => {
    const { snapshot, main } = fixture('one-block');
    const opened = { ...main, composer: { text: 'no veo', openWhileActive: true } };
    const t = escapeBloqueo(snapshot, opened, NOW);
    expect(t?.main.composer).toEqual({ text: '', openWhileActive: false });
    expect(t?.focus).toBe('section');
    expect(escapeBloqueo(snapshot, t!.main, NOW)).toBeNull();
  });
});
