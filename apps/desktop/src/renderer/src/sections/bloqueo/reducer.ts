/**
 * Section 2's local-state transitions as pure functions over `(UiSnapshot, MainLocalState)`:
 * Enter (field → card → consequence → create), the Esc cascade (docs/DESKTOP.md §7.4),
 * typing, templates, «Nuevo» and card edits. Hooks turn the returned effects into IPC calls.
 *
 * Idempotency rule: a create the guardian **rejected** (4xx) created nothing, so the next
 * change gets a new intent id and the old one is dismissed. A create that got **no answer**
 * may have landed: its card is frozen and only «Reintentar» (same request, same key) or Esc
 * (dismiss) get out of it, so a block is never duplicated. Pure module.
 */
import type { CreateBlockRequest, DailyLimitInput } from '@centrate/shared/guardian-api';
import {
  bloqueoVariant,
  isGuardianUnresponsive,
  type ConfirmCardState,
  type DetailRequest,
  type IntentId,
  type MainLocalState,
  type UiPrefs,
  type UiSnapshot,
} from '../../../../shared/ui-state';
import {
  cardAdvance,
  cardBack,
  cardForTemplate,
  fieldEnter,
  limitCardAdvance,
  newCard,
  newLimitCard,
  parsePhrase,
} from './draft';
import { limitsSupported } from '../../../../shared/limits';

export type NewIntentId = () => IntentId;

/** Where focus should go after a transition (the component applies it). */
export type FocusTarget = 'field' | 'confirm' | 'extend' | 'section' | null;

/** How the card relates to the create in `ops` (main-owned). */
export type CardCreateState =
  /** No create for this card. */
  | 'none'
  | 'sending'
  /** No answer (timeout, refused, not installed): frozen until Reintentar or Esc. */
  | 'unanswered'
  /** 4xx: nothing was created, the card stays editable. */
  | 'rejected';

export function cardCreateState(
  snapshot: UiSnapshot,
  card: ConfirmCardState | null,
): CardCreateState {
  const create = snapshot.ops.create;
  if (!create || (card && card.intentId !== create.intentId)) return 'none';
  if (create.status === 'sending') return 'sending';
  return create.error && isGuardianUnresponsive(create.error) ? 'unanswered' : 'rejected';
}

export interface Transition {
  main: MainLocalState;
  /** `block:create-dismiss` for this intent (a failed create the user left). */
  dismissIntentId: IntentId | null;
  focus: FocusTarget;
}

function same(main: MainLocalState): Transition {
  return { main, dismissIntentId: null, focus: null };
}

/**
 * Applies `fn` to the open card. After a rejected create the card gets a new intent id
 * (and the old create is dismissed); while sending or unanswered nothing changes.
 */
export function updateCard(
  snapshot: UiSnapshot,
  main: MainLocalState,
  fn: (card: ConfirmCardState) => ConfirmCardState,
  newIntentId: NewIntentId,
): Transition {
  const card = main.card;
  if (!card) return same(main);
  const create = cardCreateState(snapshot, card);
  if (create === 'sending' || create === 'unanswered') return same(main);
  const next = fn(card);
  if (next === card) return same(main);
  if (create === 'rejected') {
    return {
      main: { ...main, card: { ...next, intentId: newIntentId() } },
      dismissIntentId: card.intentId,
      focus: null,
    };
  }
  return { main: { ...main, card: next }, dismissIntentId: null, focus: null };
}

/** Typing in «¿Qué quieres hacer?»: a card built from the old text closes. */
export function typeInField(snapshot: UiSnapshot, main: MainLocalState, text: string): Transition {
  const create = cardCreateState(snapshot, main.card);
  if (create === 'sending' || create === 'unanswered') return same(main);
  if (text === main.composer.text) return same(main);
  if (main.limitCard?.sending) return same(main);
  const composer = { ...main.composer, text };
  if (main.limitCard) {
    return { main: { ...main, composer, limitCard: null }, dismissIntentId: null, focus: null };
  }
  if (!main.card) return { main: { ...main, composer }, dismissIntentId: null, focus: null };
  return {
    main: { ...main, composer, card: null },
    dismissIntentId: create === 'rejected' ? main.card.intentId : null,
    focus: null,
  };
}

/** A template tile (or tray «Bloqueo rápido ▸»): its card, with the confirm button focused. */
export function openTemplate(
  snapshot: UiSnapshot,
  main: MainLocalState,
  templateId: string,
  newIntentId: NewIntentId,
  origin: 'template' | 'tray' = 'template',
): Transition {
  const create = cardCreateState(snapshot, main.card);
  if (create === 'sending' || create === 'unanswered') return same(main);
  if (snapshot.ops.create?.status === 'sending') return same(main);
  const card = cardForTemplate(
    snapshot.templates,
    templateId,
    snapshot.prefs,
    newIntentId(),
    origin,
  );
  if (!card) return same(main);
  if (main.limitCard?.sending) return same(main);
  return {
    main: { ...main, card, limitCard: null, extendOther: { open: false, text: '' }, help: null },
    dismissIntentId: create === 'rejected' && main.card ? main.card.intentId : null,
    focus: 'confirm',
  };
}

/** Bloqueos «Bloquear…» (`ui:command confirm-draft`): the one confirmation path. */
export function openDraft(
  snapshot: UiSnapshot,
  main: MainLocalState,
  draft: ConfirmCardState['draft'],
  newIntentId: NewIntentId,
): Transition {
  const create = cardCreateState(snapshot, main.card);
  if (create === 'sending' || create === 'unanswered') return same(main);
  if (snapshot.ops.create?.status === 'sending') return same(main);
  if (main.limitCard?.sending) return same(main);
  return {
    main: {
      ...main,
      card: newCard(draft, newIntentId(), 'form'),
      limitCard: null,
      extendOther: { open: false, text: '' },
      help: null,
    },
    dismissIntentId: create === 'rejected' && main.card ? main.card.intentId : null,
    focus: 'confirm',
  };
}

/** «Nuevo» pill, Ctrl+N, `/` and `ui:command focus-field`: the field (under a block too). */
export function openField(snapshot: UiSnapshot, main: MainLocalState): Transition {
  const blocks = (snapshot.state?.blocks.length ?? 0) > 0;
  if (blocks && !main.composer.openWhileActive && !main.card) {
    return {
      main: { ...main, composer: { ...main.composer, openWhileActive: true } },
      dismissIntentId: null,
      focus: 'field',
    };
  }
  return { main, dismissIntentId: null, focus: 'field' };
}

export type EnterOutcome =
  | ({ kind: 'none' } & Transition)
  /** Card opened or moved to its consequence step (local only). */
  | ({ kind: 'update' } & Transition)
  | ({ kind: 'submit'; intentId: IntentId; request: CreateBlockRequest } & Transition)
  /** The «Límite diario» card: `limits:create` with this key. */
  | ({ kind: 'limit-submit'; intentId: IntentId; input: DailyLimitInput } & Transition)
  /** «Reintentar»: same request, same key. */
  | ({ kind: 'retry'; intentId: IntentId } & Transition)
  /** A phrase that was not (fully) understood: Bloqueos with what was. */
  | ({ kind: 'open-detail'; request: DetailRequest } & Transition);

/**
 * Enter anywhere in section 2 (field, card, reason): the field opens the card or Bloqueos;
 * the card goes edit → consequence → create; an unanswered create retries.
 */
export function enterBloqueo(
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
  newIntentId: NewIntentId,
  prefs: UiPrefs = snapshot.prefs,
): EnterOutcome {
  const variant = bloqueoVariant(snapshot, main, nowMs);
  if (variant === 'pending') return { kind: 'none', ...same(main) };
  if (variant === 'failed') {
    const create = snapshot.ops.create;
    if (!create) return { kind: 'none', ...same(main) };
    const state = cardCreateState(snapshot, main.card ?? null);
    if (state === 'unanswered' || !main.card) {
      return { kind: 'retry', intentId: create.intentId, ...same(main) };
    }
  }
  const limitCard = main.limitCard;
  if (limitCard && !main.card) {
    const step = limitCardAdvance(limitCard, nowMs);
    switch (step.kind) {
      case 'none':
        return { kind: 'none', ...same(main) };
      case 'consequence':
        return {
          kind: 'update',
          main: { ...main, limitCard: step.card },
          dismissIntentId: null,
          focus: 'confirm',
        };
      case 'submit':
        return {
          kind: 'limit-submit',
          intentId: step.card.intentId,
          input: step.input,
          main: { ...main, limitCard: step.card },
          dismissIntentId: null,
          focus: 'confirm',
        };
    }
  }
  const card = main.card;
  if (card) {
    const rejected = cardCreateState(snapshot, card) === 'rejected';
    const current = rejected ? { ...card, intentId: newIntentId() } : card;
    const dismissIntentId = rejected ? card.intentId : null;
    const step = cardAdvance(current, nowMs);
    switch (step.kind) {
      case 'none':
        return { kind: 'none', ...same(main) };
      case 'consequence':
        return {
          kind: 'update',
          main: { ...main, card: step.card },
          dismissIntentId,
          focus: 'confirm',
        };
      case 'submit':
        return {
          kind: 'submit',
          intentId: step.card.intentId,
          request: step.request,
          main: { ...main, card: step.card },
          dismissIntentId,
          focus: 'confirm',
        };
    }
  }
  const text = main.composer.text;
  const decision = fieldEnter(text, parsePhrase(text, nowMs), prefs);
  switch (decision.kind) {
    case 'none':
      return { kind: 'none', ...same(main) };
    case 'card':
      return {
        kind: 'update',
        main: {
          ...main,
          card: newCard(decision.draft, newIntentId(), 'phrase', { phrase: text }),
          extendOther: { open: false, text: '' },
          help: null,
        },
        dismissIntentId: null,
        focus: 'confirm',
      };
    case 'limit':
      // An older guardian without daily limits: Bloqueos says so instead of a card that fails.
      if (!limitsSupported(snapshot)) {
        return {
          kind: 'open-detail',
          request: { name: 'bloqueos', seed: null, focus: 'limits' },
          ...same(main),
        };
      }
      return {
        kind: 'update',
        main: {
          ...main,
          limitCard: newLimitCard(decision.draft, newIntentId(), text),
          extendOther: { open: false, text: '' },
          help: null,
        },
        dismissIntentId: null,
        focus: 'confirm',
      };
    case 'bloqueos':
      return {
        kind: 'open-detail',
        request: { name: 'bloqueos', seed: decision.seed, focus: decision.focus ?? 'form' },
        ...same(main),
      };
  }
}

/** Section 2's stages of the Esc cascade, in order (RENDERER-CORE's `ESC_PRIORITY`). */
export const ESCAPE_STAGES = [
  'extendOther',
  'consequence',
  'card',
  'newField',
  'clearText',
] as const;
export type EscapeStage = (typeof ESCAPE_STAGES)[number];

/**
 * One stage of the Esc cascade (`null`: not this stage's business):
 * - `extendOther`: close «Otro…»;
 * - `consequence`: close a chip editor, then leave the consequence step;
 * - `card`: close the card (a failed create is dismissed; a sending one cannot be, so Esc
 *   falls through and the window hides);
 * - `newField`: close the field opened with «Nuevo»;
 * - `clearText`: clear «¿Qué quieres hacer?».
 */
export function escapeStage(
  stage: EscapeStage,
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): Transition | null {
  switch (stage) {
    case 'extendOther':
      return main.extendOther.open
        ? {
            main: { ...main, extendOther: { open: false, text: '' } },
            dismissIntentId: null,
            focus: 'extend',
          }
        : null;
    case 'consequence': {
      const limit = main.limitCard;
      if (limit && !main.card) {
        return limit.step === 'consequence' && !limit.sending
          ? {
              main: { ...main, limitCard: { ...limit, step: 'edit', consequenceAt: null } },
              dismissIntentId: null,
              focus: 'confirm',
            }
          : null;
      }
      const card = main.card;
      if (!card) return null;
      const variant = bloqueoVariant(snapshot, main, nowMs);
      if (variant === 'pending') return null;
      if (card.editing !== null) {
        return {
          main: { ...main, card: { ...card, editing: null } },
          dismissIntentId: null,
          focus: 'confirm',
        };
      }
      if (variant === 'failed') return null;
      const back = cardBack(card);
      return back && back.step !== card.step
        ? { main: { ...main, card: back }, dismissIntentId: null, focus: 'confirm' }
        : null;
    }
    case 'card': {
      const variant = bloqueoVariant(snapshot, main, nowMs);
      if (variant === 'limit') {
        // A create in flight cannot be taken back: Esc falls through (the window hides).
        return main.limitCard && !main.limitCard.sending
          ? { main: { ...main, limitCard: null }, dismissIntentId: null, focus: 'field' }
          : null;
      }
      if (variant === 'pending') return null;
      const card = main.card;
      if (card) {
        return {
          main: { ...main, card: null },
          dismissIntentId: variant === 'failed' ? card.intentId : null,
          focus: 'field',
        };
      }
      if (variant === 'failed' && snapshot.ops.create) {
        return { main, dismissIntentId: snapshot.ops.create.intentId, focus: 'field' };
      }
      return null;
    }
    case 'newField':
      return main.composer.openWhileActive
        ? {
            main: { ...main, composer: { text: '', openWhileActive: false } },
            dismissIntentId: null,
            focus: 'section',
          }
        : null;
    case 'clearText':
      return main.composer.text !== ''
        ? {
            main: { ...main, composer: { ...main.composer, text: '' } },
            dismissIntentId: null,
            focus: 'field',
          }
        : null;
  }
}

/**
 * Esc in the main window, section 2's whole part of the cascade (after RENDERER-CORE's
 * disarm): close «Otro…» → close a chip editor → leave the consequence step → close the card
 * → close the field opened with «Nuevo» → clear the text. `null`: not handled (the window
 * hides).
 */
export function escapeBloqueo(
  snapshot: UiSnapshot,
  main: MainLocalState,
  nowMs: number,
): Transition | null {
  for (const stage of ESCAPE_STAGES) {
    const result = escapeStage(stage, snapshot, main, nowMs);
    if (result) return result;
  }
  return null;
}
