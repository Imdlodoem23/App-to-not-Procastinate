/**
 * Section 2's glue (docs/DESKTOP.md §7.1: section actions live in the section as hooks): it
 * derives the view model, turns the pure transitions of `reducer.ts` into store updates and IPC
 * calls, registers the section's keys (Esc cascade stages, Ctrl+E then 1/2/3/4, Ctrl+N and `/`
 * under an active block) and its focus targets («¿Qué quieres hacer?», the confirm button, the
 * extend row), and keeps the few transient notices that are not in the snapshot.
 *
 * Nothing here decides what the UI says: that is `deriveBloqueoView`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { BlockMode, LimitMode } from '@centrate/shared/domain';
import type { CreateBlockRequest, DailyLimitInput } from '@centrate/shared/guardian-api';
import { LIMIT_TEXT } from '../../../../shared/limits';
import { useFocusTarget } from '../../app/services';
import { CHORD_WINDOW_MS, ESC_PRIORITY } from '../../hooks/keys';
import { useChord, useEscape, useKeyBinding } from '../../hooks/useKeys';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { useAppStore, useAppStoreApi, useBridge } from '../../store/context';
import {
  EXTEND_PRESETS,
  snapshotNow,
  type CardField,
  type DetailRequest,
  type DraftSeed,
  type IntentId,
  type UiError,
} from '../../../../shared/ui-state';
import {
  applyChipEdit,
  cardWithDraft,
  cardWithMode,
  cardWithReason,
  limitCardWithMode,
  limitCardWithReason,
  parseExtendMinutes,
} from './draft';
import { BLOQUEO } from './i18n';
import {
  cardCreateState,
  enterBloqueo,
  escapeStage,
  openField,
  openTemplate,
  typeInField,
  updateCard,
  type EscapeStage,
  type FocusTarget,
  type Transition,
} from './reducer';
import { BLOQUEO_SECTION_ID, deriveBloqueoView, type BloqueoView } from './view';

/**
 * A one-line notice that is not in the snapshot (a refused extension, «Ya ampliado»,
 * «Ampliación deshecha»…). Extend notices are also spoken by the extend row's live region.
 */
export interface BloqueoNotice {
  /** `composer`: under the field after the «Límite diario» card created its limit. */
  scope: 'card' | 'extend' | 'composer';
  /** The card it belongs to (`scope: 'card'`). */
  intentId: IntentId | null;
  text: string;
  tone: 'muted' | 'red' | 'green';
}

export interface BloqueoRefs {
  field: RefObject<HTMLInputElement | null>;
  /** The card's primary action (confirm or «Reintentar»). */
  primary: RefObject<HTMLButtonElement | null>;
  firstExtend: RefObject<HTMLButtonElement | null>;
  otherField: RefObject<HTMLInputElement | null>;
}

export interface BloqueoActions {
  typeText(text: string): void;
  /** Enter in the field, the card, «Tu motivo», or the confirm button. */
  enter(): void;
  selectSpan(span: { start: number; end: number }): void;
  pressTemplate(templateId: string): void;
  openMore(): void;
  openNew(): void;
  setMode(mode: BlockMode): void;
  setReason(reason: string): void;
  startEdit(field: CardField): void;
  /** `null` when applied, else the message for the help line. */
  commitEdit(field: CardField, text: string): string | null;
  cancelEdit(): void;
  editInBloqueos(): void;
  /** The «Límite diario» card: its mode, «Tu motivo», and «Editar…» (Bloqueos › límites). */
  setLimitMode(mode: LimitMode): void;
  setLimitReason(reason: string): void;
  editLimitInBloqueos(): void;
  extend(minutes: number): void;
  openOther(): void;
  setOtherText(text: string): void;
  applyOther(): void;
  undo(entryId: string): void;
  retryExtend(entryId: string): void;
  openDetail(request: DetailRequest): void;
}

const NOTICE_MS = 4_000;
/** Lands a wake-up just past its instant (timers and `Date.now()` may disagree by a ms). */
const WAKE_EPSILON_MS = 4;
const ESC_STAGE_PRIORITY: Readonly<Record<EscapeStage, number>> = {
  extendOther: ESC_PRIORITY.extendOther,
  consequence: ESC_PRIORITY.consequence,
  card: ESC_PRIORITY.card,
  newField: ESC_PRIORITY.newField,
  clearText: ESC_PRIORITY.clearText,
};

function sectionRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-section="${BLOQUEO_SECTION_ID}"]`);
}

function newIntentId(): IntentId {
  return crypto.randomUUID();
}

export function useBloqueo(): {
  view: BloqueoView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
  notice: BloqueoNotice | null;
  frozen: boolean;
} {
  const api = useAppStoreApi();
  const bridge = useBridge();
  const snapshot = useAppStore((s) => s.snapshot);
  const main = useAppStore((s) => s.main);
  const visible = useAppStore((s) => s.env.visible);

  const idle =
    main.card === null && main.limitCard === null && (snapshot.state?.blocks.length ?? 0) === 0;
  // Idle: the example rotates every 4 s. Otherwise labels move with the second (undo, locks).
  const now = useNow(idle ? 4_000 : 1_000);
  const view = useMemo(() => deriveBloqueoView({ snapshot, main }, now), [snapshot, main, now]);
  const frozen = snapshot.harness?.frozenNowMs != null;

  // Labels that count to their own instant, not to the wall-clock second: re-derive exactly at
  // `wakeAt` («Sí, bloquear 6 h» unlocks 2 s after the consequence, not at the next second, so
  // an Enter right then is not dropped; «Deshacer (N s)» and «Emergencia: m:ss» stay on time).
  const [, wake] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (view.wakeAt === null || frozen || !visible) return undefined;
    const delay = Math.max(0, view.wakeAt - Date.now()) + WAKE_EPSILON_MS;
    const timer = setTimeout(wake, delay);
    return () => clearTimeout(timer);
  }, [view.wakeAt, now, frozen, visible]);

  const refs: BloqueoRefs = {
    field: useRef<HTMLInputElement>(null),
    primary: useRef<HTMLButtonElement>(null),
    firstExtend: useRef<HTMLButtonElement>(null),
    otherField: useRef<HTMLInputElement>(null),
  };

  // --- transient notices ------------------------------------------------------------------
  const [notice, setNotice] = useState<BloqueoNotice | null>(null);
  useEffect(() => {
    if (!notice || !visible) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, visible]);

  // --- focus after a render ------------------------------------------------------------------
  const [focusRequest, setFocusRequest] = useState<{
    target: FocusTarget | 'other';
    seq: number;
  } | null>(null);
  const focusSeq = useRef(0);
  const requestFocus = useCallback((target: FocusTarget | 'other') => {
    if (target === null) return;
    focusSeq.current += 1;
    setFocusRequest({ target, seq: focusSeq.current });
  }, []);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const el =
      focusRequest.target === 'field'
        ? refs.field.current
        : focusRequest.target === 'confirm'
          ? refs.primary.current
          : focusRequest.target === 'other'
            ? refs.otherField.current
            : focusRequest.target === 'extend'
              ? refs.firstExtend.current
              : sectionRoot();
    (el ?? refs.field.current)?.focus({ preventScroll: true });
    // Only once per request.
    setFocusRequest(null);
  }, [focusRequest, refs.field, refs.primary, refs.otherField, refs.firstExtend]);

  // The card closes when the guardian confirms: keep the keyboard in the section.
  const previousKind = useRef(view.body.kind);
  useLayoutEffect(() => {
    const was = previousKind.current;
    previousKind.current = view.body.kind;
    if ((was !== 'card' && was !== 'limit-card') || view.body.kind === was) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (refs.field.current ?? sectionRoot())?.focus({ preventScroll: true });
  }, [view.body.kind, refs.field]);

  // The undo line's button («Deshacer (N s)», «Reintentar») goes away when its entry moves on
  // (5 s later, or sent): a keyboard user on it goes back to the extend row, not to <body>.
  const undoKind = view.body.kind === 'active' ? (view.body.extend?.undo?.kind ?? null) : null;
  const previousUndo = useRef(undoKind);
  useLayoutEffect(() => {
    const was = previousUndo.current;
    previousUndo.current = undoKind;
    if (was === undoKind || (was !== 'waiting' && was !== 'failed')) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (refs.firstExtend.current ?? refs.field.current ?? sectionRoot())?.focus({
      preventScroll: true,
    });
  }, [undoKind, refs.firstExtend, refs.field]);

  // --- helpers -------------------------------------------------------------------------------
  const clock = useCallback(() => snapshotNow(api.getState().snapshot), [api]);

  const apply = useCallback(
    (t: Transition) => {
      const s = api.getState();
      if (t.main !== s.main) s.updateMain(() => t.main);
      if (t.dismissIntentId) bridge.send('block:create-dismiss', { intentId: t.dismissIntentId });
      if (t.focus) requestFocus(t.focus);
    },
    [api, bridge, requestFocus],
  );

  const cardNotice = useCallback((intentId: IntentId, error: UiError) => {
    setNotice({ scope: 'card', intentId, text: errorCopy(error).text, tone: 'red' });
  }, []);

  const afterCreate = useCallback(
    (intentId: IntentId) =>
      (result: { ok: true } | { ok: false; error: UiError }): void => {
        if (result.ok) return;
        // Errors the snapshot carries (timeout, 4xx) show from `ops.create`; the rest here.
        if (api.getState().snapshot.ops.create?.intentId !== intentId)
          cardNotice(intentId, result.error);
      },
    [api, cardNotice],
  );

  const submit = useCallback(
    (intentId: IntentId, request: CreateBlockRequest) => {
      setNotice(null);
      void bridge.invoke('block:create', { intentId, request }).then(afterCreate(intentId));
    },
    [bridge, afterCreate],
  );

  const openDetail = useCallback(
    (request: DetailRequest) => bridge.send('window:open-detail', request),
    [bridge],
  );

  /** `limits:create` of the «Límite diario» card; the card closes when the guardian says yes. */
  const submitLimit = useCallback(
    (intentId: IntentId, input: DailyLimitInput) => {
      setNotice(null);
      void bridge.invoke('limits:create', { intentId, input }).then(
        (result) => {
          const s = api.getState();
          const card = s.main.limitCard;
          if (!card || card.intentId !== intentId) return;
          if (!result.ok) {
            s.updateMain((m) =>
              m.limitCard?.intentId === intentId
                ? { ...m, limitCard: { ...m.limitCard, sending: false, error: result.error } }
                : m,
            );
            return;
          }
          s.updateMain((m) => ({
            ...m,
            limitCard: null,
            composer: { text: '', openWhileActive: false },
          }));
          setNotice({
            scope: 'composer',
            intentId: null,
            text: BLOQUEO.limit.created(
              result.value.name,
              LIMIT_TEXT.perDay(result.value.dailyMinutes),
            ),
            tone: 'green',
          });
          requestFocus('field');
        },
        () => undefined,
      );
    },
    [api, bridge, requestFocus],
  );

  const primaryBlockId =
    view.body.kind === 'active' && view.body.extend ? view.body.extend.blockId : null;

  const extend = useCallback(
    (minutes: number) => {
      if (!primaryBlockId) return;
      setNotice(null);
      void bridge
        .invoke('block:extend', { blockId: primaryBlockId, addMinutes: minutes })
        .then((r) => {
          if (!r.ok)
            setNotice({
              scope: 'extend',
              intentId: null,
              text: errorCopy(r.error).text,
              tone: 'red',
            });
        });
    },
    [bridge, primaryBlockId],
  );

  const closeOther = useCallback(() => {
    api.getState().updateMain((m) => ({ ...m, extendOther: { open: false, text: '' } }));
  }, [api]);

  // --- actions -------------------------------------------------------------------------------
  const actions = useMemo<BloqueoActions>(
    () => ({
      typeText(text) {
        const s = api.getState();
        apply(typeInField(s.snapshot, s.main, text));
      },
      enter() {
        const s = api.getState();
        const out = enterBloqueo(s.snapshot, s.main, clock(), newIntentId);
        apply(out);
        switch (out.kind) {
          case 'submit':
            submit(out.intentId, out.request);
            break;
          case 'limit-submit':
            submitLimit(out.intentId, out.input);
            break;
          case 'retry':
            setNotice(null);
            void bridge
              .invoke('block:create-retry', { intentId: out.intentId })
              .then(afterCreate(out.intentId));
            break;
          case 'open-detail':
            openDetail(out.request);
            break;
          case 'none':
          case 'update':
            break;
        }
      },
      selectSpan(span) {
        const field = refs.field.current;
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(span.start, span.end);
      },
      pressTemplate(templateId) {
        const s = api.getState();
        apply(openTemplate(s.snapshot, s.main, templateId, newIntentId));
      },
      openMore() {
        openDetail({ name: 'bloqueos', seed: null, focus: null });
      },
      openNew() {
        const s = api.getState();
        apply(openField(s.snapshot, s.main));
      },
      setMode(mode) {
        const s = api.getState();
        apply(updateCard(s.snapshot, s.main, (c) => cardWithMode(c, mode), newIntentId));
      },
      setReason(reason) {
        const s = api.getState();
        apply(updateCard(s.snapshot, s.main, (c) => cardWithReason(c, reason), newIntentId));
      },
      startEdit(field) {
        const s = api.getState();
        apply(updateCard(s.snapshot, s.main, (c) => ({ ...c, editing: field }), newIntentId));
      },
      commitEdit(field, text) {
        const s = api.getState();
        const card = s.main.card;
        // A blur after Esc closed the editor must not apply what was typed.
        if (!card || card.editing !== field) return null;
        const result = applyChipEdit(card.draft, field, text, clock(), s.snapshot.prefs);
        if (!result.ok) return result.message;
        apply(
          updateCard(
            s.snapshot,
            s.main,
            (c) => ({ ...cardWithDraft(c, result.draft), editing: null }),
            newIntentId,
          ),
        );
        requestFocus('confirm');
        return null;
      },
      cancelEdit() {
        const s = api.getState();
        apply(updateCard(s.snapshot, s.main, (c) => ({ ...c, editing: null }), newIntentId));
      },
      editInBloqueos() {
        const s = api.getState();
        const card = s.main.card;
        if (!card) return;
        const d = card.draft;
        const seed: DraftSeed = {
          phrase: card.phrase,
          targets: d.whitelistOnly ? null : d.targets,
          end: d.end,
          mode: d.mode,
          reason: d.reason,
        };
        openDetail({ name: 'bloqueos', seed, focus: 'form' });
        apply({
          main: { ...s.main, card: null },
          dismissIntentId: cardCreateState(s.snapshot, card) === 'rejected' ? card.intentId : null,
          focus: null,
        });
      },
      setLimitMode(mode) {
        const s = api.getState();
        const card = s.main.limitCard;
        if (!card) return;
        const next = limitCardWithMode(card, mode, newIntentId());
        if (next !== card) s.updateMain((m) => ({ ...m, limitCard: next }));
      },
      setLimitReason(reason) {
        const s = api.getState();
        const card = s.main.limitCard;
        if (!card) return;
        const next = limitCardWithReason(card, reason);
        if (next !== card) s.updateMain((m) => ({ ...m, limitCard: next }));
      },
      editLimitInBloqueos() {
        const s = api.getState();
        const card = s.main.limitCard;
        if (!card || card.sending) return;
        const d = card.draft;
        // The allowance travels as the seed's duration; the limit editor reads it.
        const seed: DraftSeed = {
          phrase: card.phrase,
          targets: d.targets,
          end: { kind: 'duration', minutes: d.dailyMinutes },
          mode: d.mode,
          reason: d.reason,
        };
        openDetail({ name: 'bloqueos', seed, focus: 'limits' });
        s.updateMain((m) => ({ ...m, limitCard: null }));
      },
      extend,
      openOther() {
        api.getState().updateMain((m) => ({ ...m, extendOther: { open: true, text: '' } }));
        requestFocus('other');
      },
      setOtherText(text) {
        api.getState().updateMain((m) => ({ ...m, extendOther: { ...m.extendOther, text } }));
      },
      applyOther() {
        const s = api.getState();
        const minutes = parseExtendMinutes(s.main.extendOther.text, clock());
        if (view.body.kind !== 'active' || !view.body.extend) return;
        const other = view.body.extend.other;
        if (minutes === null || !other.canApply) return;
        extend(minutes);
        closeOther();
        requestFocus('extend');
      },
      undo(entryId) {
        requestFocus('extend');
        void bridge.invoke('block:extend-undo', { entryId }).then((r) => {
          setNotice({
            scope: 'extend',
            intentId: null,
            text: r === 'too_late' ? BLOQUEO.active.tooLate : BLOQUEO.active.undone,
            tone: 'muted',
          });
        });
      },
      retryExtend(entryId) {
        void bridge.invoke('block:extend-retry', { entryId }).then((r) => {
          if (!r.ok)
            setNotice({
              scope: 'extend',
              intentId: null,
              text: errorCopy(r.error).text,
              tone: 'red',
            });
        });
      },
      openDetail,
    }),
    [
      api,
      apply,
      bridge,
      clock,
      submit,
      submitLimit,
      afterCreate,
      openDetail,
      extend,
      closeOther,
      requestFocus,
      refs.field,
      view,
    ],
  );

  // --- keys ----------------------------------------------------------------------------------
  const runEscape = useCallback(
    (stage: EscapeStage): boolean => {
      const s = api.getState();
      const t = escapeStage(stage, s.snapshot, s.main, clock());
      if (!t) return false;
      apply(t);
      return true;
    },
    [api, apply, clock],
  );
  useEscape(ESC_STAGE_PRIORITY.extendOther, () => runEscape('extendOther'), main.extendOther.open);
  useEscape(
    ESC_STAGE_PRIORITY.consequence,
    () => runEscape('consequence'),
    main.card !== null || main.limitCard !== null,
  );
  useEscape(
    ESC_STAGE_PRIORITY.card,
    () => runEscape('card'),
    main.card !== null || main.limitCard !== null || snapshot.ops.create !== null,
  );
  useEscape(
    ESC_STAGE_PRIORITY.newField,
    () => runEscape('newField'),
    main.composer.openWhileActive,
  );
  useEscape(ESC_STAGE_PRIORITY.clearText, () => runEscape('clearText'), main.composer.text !== '');

  const extendView = view.body.kind === 'active' ? view.body.extend : null;
  useChord(
    {
      lead: { key: 'e', primary: true },
      keys: ['1', '2', '3', '4'],
      windowMs: CHORD_WINDOW_MS,
      onLead: () => refs.firstExtend.current?.focus({ preventScroll: true }),
      onKey: (key) => {
        if (!extendView) return;
        if (key === '4') {
          const other = extendView.tiles[3];
          if (other && !other.disabled) actions.openOther();
          return;
        }
        const minutes = EXTEND_PRESETS[Number(key) - 1];
        const t = extendView.tiles[Number(key) - 1];
        if (minutes !== undefined && t && !t.disabled) actions.extend(minutes);
      },
    },
    extendView !== null && !extendView.other.open,
  );

  // Ctrl+N and `/` open the field when an active block hides it (else RENDERER-CORE focuses it).
  const fieldHidden = view.body.kind === 'active' && view.body.composer === null;
  useKeyBinding({ key: 'n', primary: true }, () => actions.openNew(), {
    enabled: fieldHidden,
    allowInText: true,
  });
  useKeyBinding({ key: '/', shift: 'any' }, () => actions.openNew(), { enabled: fieldHidden });

  // `ui:command focus-field` opens the field under an active block too.
  useEffect(
    () =>
      bridge.on('ui:command', (command) => {
        if (command.type !== 'focus-field') return;
        const s = api.getState();
        const t = openField(s.snapshot, s.main);
        if (t.main !== s.main) apply(t);
      }),
    [bridge, api, apply],
  );

  // «¿Qué quieres hacer?» for the shell (show, Ctrl+N, focus-field). With a card open the
  // confirm button takes it (Enter confirms); hidden under a block → the section root.
  useFocusTarget('field', () => {
    const s = api.getState();
    const target =
      s.main.card || s.main.limitCard
        ? (refs.primary.current ?? refs.field.current)
        : refs.field.current;
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  });
  useFocusTarget('confirm', () => {
    const target = refs.primary.current;
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  });
  useFocusTarget('extend', () => {
    const target = refs.firstExtend.current;
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  });

  return { view, actions, refs, notice, frozen };
}
