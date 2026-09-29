/**
 * The confirmation card, in place (PROMPT §4, §10 «Confirmación»): what is blocked (chips,
 * each correctable in place), duration and end in sync, Normal | Estricto | Hardcore |
 * Examen with its explanation, «Tu motivo», «Solo se puede ampliar, nunca acortar» and
 * Editar… | Bloquear hasta 17:42. Enter confirms, Esc goes back. Over 4 h, Hardcore and
 * Examen the first Enter adds the red consequence line and «Sí, bloquear 6 h» waits 2 s.
 * While the guardian has not confirmed: «Bloqueando…» (no spinner); no answer in 3 s:
 * «El guardián no responde · Reintentar · Reparar».
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmButton, Field, HelpLine, Tile, TileRow, type HelpTone } from '../../components';
import { useHelp } from '../../hooks/useHelp';
import { useRepair } from '../../hooks/useRepair';
import { errorCopy } from '../../i18n/errors';
import { RENDERER } from '../../i18n/messages';
import { useAppStore } from '../../store/context';
import type { BlockMode } from '@centrate/shared/domain';
import { chipEditText } from './draft';
import type { CardField } from '../../../../shared/ui-state';
import { snapshotNow } from '../../../../shared/ui-state';
import { ChipList } from './ChipList';
import { isEnter } from './Composer';
import { BLOQUEO } from './i18n';
import { ACTION_ICONS, MODE_ICONS } from './icons';
import type { BloqueoActions, BloqueoNotice, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, type CardActionView, type CardView } from './view';

const HELP_ID = 'bloqueo-card-help';
/** Screen readers: what the confirm button commits (read with it, before the help line). */
const SUMMARY_ID = 'bloqueo-card-summary';
const REASON_ID = 'bloqueo-reason';

const EDITOR_LABEL: Readonly<Record<CardField, string>> = {
  get targets() {
    return BLOQUEO.card.targetsLabel;
  },
  get duration() {
    return BLOQUEO.card.durationChip;
  },
  get end() {
    return BLOQUEO.card.endChip;
  },
  get mode() {
    return BLOQUEO.card.modesLabel;
  },
  get reason() {
    return BLOQUEO.card.reasonLabel;
  },
};

const EDITOR_PLACEHOLDER: Readonly<Partial<Record<CardField, string>>> = {
  get targets() {
    return BLOQUEO.card.editTargetsPlaceholder;
  },
  get duration() {
    return BLOQUEO.card.editDurationPlaceholder;
  },
  get end() {
    return BLOQUEO.card.editEndPlaceholder;
  },
};

/** In-place editor of one chip: Enter applies, Esc (the window cascade) leaves it as it was. */
function ChipEditor(props: {
  field: CardField;
  initial: string;
  onCommit(text: string): string | null;
  /** Each call is a new result (the same error twice is spoken twice). */
  onError(message: string | null): void;
}): React.JSX.Element {
  const { field, onCommit, onError } = props;
  const [text, setText] = useState(props.initial);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  return (
    <div className="bq-chip-editor">
      <span className="bq-chip-editor-label" aria-hidden="true">
        {EDITOR_LABEL[field]}
      </span>
      <Field
        ref={input}
        value={text}
        label={EDITOR_LABEL[field]}
        placeholder={EDITOR_PLACEHOLDER[field]}
        describedBy={HELP_ID}
        onChange={(value) => {
          setText(value);
          onError(null);
        }}
        onKeyDown={(event) => {
          if (!isEnter(event)) return;
          event.preventDefault();
          event.stopPropagation();
          onError(onCommit(text));
        }}
        onBlur={() => {
          // Leaving the editor applies a valid value; an invalid one is dropped silently.
          onCommit(text);
        }}
      />
    </div>
  );
}

export function ConfirmCard(props: {
  card: CardView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
  notice: BloqueoNotice | null;
  intentId: string | null;
  /**
   * Screen readers: a result of the card (the consequence line, an error, «El guardián no
   * responde», an edit error, a notice), spoken by BloqueoSection's live region. The visible
   * help line is not live: its hover/focus help is never spoken as a change.
   */
  announce(text: string): void;
}): React.JSX.Element {
  const { card, actions, refs, notice, announce } = props;
  const [editError, setEditError] = useState<{ text: string; seq: number } | null>(null);
  const repair = useRepair();
  const actionsHelp = useHelp(BLOQUEO_ROWS.actions);
  const snapshot = useAppStore((s) => s.snapshot);
  const draft = useAppStore((s) => s.main.card?.draft ?? null);
  // «Sí, bloquear 6 h» unlocks when `useBloqueo` re-renders the view at `wakeAt` (= unlockAt).

  // A new card puts the focus on its confirm button (Enter confirms).
  useLayoutEffect(() => {
    refs.primary.current?.focus({ preventScroll: true });
  }, [refs.primary]);

  // The status changed under the focus (a create with no answer, «Reintentar»): the actions
  // keep their elements (keyed by slot), but if the focus still fell to <body>, it goes back
  // to the primary action so Enter keeps advancing.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      refs.primary.current?.focus({ preventScroll: true });
    }
  }, [card.status, refs.primary]);

  useEffect(() => {
    if (card.editing === null) setEditError(null);
  }, [card.editing]);

  // The help line: an edit error, the repair outcome, a local notice, else the view's line.
  // `result` marks the lines that report something that happened (spoken once, below).
  let helpText: string;
  let helpTone: HelpTone;
  let result: string | null = null;
  if (editError && card.editing) {
    helpText = editError.text;
    helpTone = 'orange';
    result = `edit:${editError.seq}`;
  } else if (repair.message) {
    helpText = repair.message.text;
    helpTone = repair.message.tone;
    result = 'repair';
  } else if (card.actionsHelp.kind === 'error') {
    helpText = errorCopy(card.actionsHelp.error).text;
    helpTone = 'red';
    result = `error:${card.status}`;
  } else if (notice && notice.scope === 'card' && notice.intentId === props.intentId) {
    helpText = notice.text;
    helpTone = notice.tone;
    result = 'notice';
  } else {
    helpText = card.actionsHelp.text;
    helpTone = card.actionsHelp.tone;
    if (card.status === 'consequence' && helpTone === 'red') result = 'consequence';
  }

  // Each new result is announced once; hover/focus help (the `else` above) never is.
  const resultKey = result === null ? null : `${result}\u0000${helpText}`;
  const resultText = result === null ? null : helpText;
  useEffect(() => {
    if (resultKey !== null && resultText !== null) announce(resultText);
  }, [resultKey, resultText, announce]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isEnter(event)) return;
    const target = event.target as HTMLElement;
    // Enter on a mode tile confirms (arrows choose the mode); other buttons press themselves.
    if (target.getAttribute('role') === 'radio') {
      event.preventDefault();
      actions.enter();
    }
  };

  const renderAction = (a: CardActionView): React.JSX.Element => {
    const hover = {
      onMouseEnter: () => actionsHelp.enter(a.id),
      onMouseLeave: () => actionsHelp.leave(a.id),
      onFocus: () => actionsHelp.enter(a.id),
      onBlur: () => actionsHelp.leave(a.id),
    };
    if (a.primary) {
      return (
        // Keyed by slot, not by id: «Bloqueando…» → «Reintentar» keeps the same focused button.
        <div key="primary" className={`bq-span-${a.span}`} {...hover}>
          <ConfirmButton
            ref={refs.primary}
            // Busy («Bloqueando…») and locked («Sí, bloquear 6 h» for 2 s) ignore presses like
            // a disabled button but keep a full-contrast label (bloqueo.css).
            className={
              a.busy ? 'bq-confirm bq-busy' : a.locked ? 'bq-confirm bq-locked' : 'bq-confirm'
            }
            label={a.label}
            disabled={a.disabled || a.locked || a.busy}
            mnemonic={a.mnemonic ?? undefined}
            describedBy={`${SUMMARY_ID} ${HELP_ID}`}
            onPress={actions.enter}
          />
        </div>
      );
    }
    const repairing = a.id === 'repair' && repair.running;
    return (
      <div key="secondary" className={`bq-span-${a.span}`} {...hover}>
        <Tile
          id={a.id}
          label={repairing ? RENDERER.protection.actions.repairing : a.label}
          icon={a.id === 'repair' ? ACTION_ICONS.repair : undefined}
          size="door"
          door={a.id === 'edit'}
          disabled={a.disabled || repairing}
          disabledReason={a.disabled ? BLOQUEO.card.pendingHelp : undefined}
          mnemonic={a.mnemonic ?? undefined}
          onPress={a.id === 'repair' ? repair.run : actions.editInBloqueos}
        />
      </div>
    );
  };

  return (
    <div className="bq-body" role="group" aria-label={BLOQUEO.card.label} onKeyDown={onKeyDown}>
      {card.composer ? (
        <Field
          id={BLOQUEO_FIELD_ID}
          ref={refs.field}
          size="main"
          label={BLOQUEO.field.label}
          value={card.composer.value}
          readOnly={!card.editable}
          maxLength={500}
          onChange={actions.typeText}
          onKeyDown={(event) => {
            if (!isEnter(event)) return;
            event.preventDefault();
            actions.enter();
          }}
        />
      ) : null}

      {card.editing && draft ? (
        <ChipEditor
          key={card.editing}
          field={card.editing}
          initial={chipEditText(draft, card.editing, snapshotNow(snapshot))}
          onCommit={(text) => (card.editing ? actions.commitEdit(card.editing, text) : null)}
          onError={(text) =>
            setEditError((e) => (text === null ? null : { text, seq: (e?.seq ?? 0) + 1 }))
          }
        />
      ) : (
        <ChipList
          chips={card.chips}
          label={BLOQUEO.card.targetsLabel}
          describedBy={HELP_ID}
          onPress={card.editable ? (chip) => chip.field && actions.startEdit(chip.field) : null}
          pressable={(chip) => chip.field !== null}
        />
      )}

      <TileRow
        id={BLOQUEO_ROWS.modes}
        label={BLOQUEO.card.modesLabel}
        kind="radiogroup"
        help={card.modeHelp}
      >
        {card.modes.map((m) => (
          <Tile
            key={m.id}
            id={m.id}
            label={m.label}
            icon={MODE_ICONS[m.id as BlockMode]}
            help={m.help}
            tone={m.accent ?? undefined}
            selected={m.selected}
            disabled={m.disabled}
            disabledReason={m.disabledReason ?? undefined}
            mnemonic={m.mnemonic ?? undefined}
            onPress={() => actions.setMode(m.id as BlockMode)}
          />
        ))}
      </TileRow>

      <div className="bq-reason-row">
        <label className="bq-reason-label" htmlFor={REASON_ID}>
          {BLOQUEO.card.reasonLabel}
        </label>
        <Field
          id={REASON_ID}
          value={card.reason}
          label={BLOQUEO.card.reasonLabel}
          placeholder={BLOQUEO.card.reasonPlaceholder}
          readOnly={!card.editable}
          maxLength={140}
          onChange={actions.setReason}
          onKeyDown={(event) => {
            if (!isEnter(event)) return;
            event.preventDefault();
            actions.enter();
          }}
        />
      </div>

      <div className="bq-actions">
        <span id={SUMMARY_ID} className="sr-only">
          {card.summary}
        </span>
        <div className="bq-actions-grid">{card.actions.map(renderAction)}</div>
        {/* A description only (not live): results are announced by BloqueoSection. */}
        <HelpLine id={HELP_ID} tone={helpTone}>
          {helpText}
        </HelpLine>
      </div>
    </div>
  );
}
