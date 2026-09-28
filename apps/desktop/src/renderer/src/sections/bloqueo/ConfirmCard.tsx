/**
 * The confirmation card, in place (PROMPT §4, §10 «Confirmación»): what is blocked (chips,
 * each correctable in place), duration and end in sync, Normal | Estricto | Hardcore |
 * Examen with its explanation, «Tu motivo», «Solo se puede ampliar, nunca acortar» and
 * Editar… | Bloquear hasta 17:42. Enter confirms, Esc goes back. Over 4 h, Hardcore and
 * Examen the first Enter adds the red consequence line and «Sí, bloquear 6 h» waits 2 s.
 * While the guardian has not confirmed: «Bloqueando…» (no spinner); no answer in 3 s:
 * «El guardián no responde · Reintentar · Reparar».
 */
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ConfirmButton, Field, HelpLine, Tile, TileRow, type HelpTone } from '../../components';
import { useHelp } from '../../hooks/useHelp';
import { useRepair } from '../../hooks/useRepair';
import { errorCopy } from '../../i18n/errors';
import { RENDERER_ES } from '../../i18n/es';
import { useAppStore } from '../../store/context';
import type { BlockMode } from '@centrate/shared/domain';
import { chipEditText } from './draft';
import type { CardField } from '../../../../shared/ui-state';
import { snapshotNow } from '../../../../shared/ui-state';
import { ChipList } from './ChipList';
import { isEnter } from './Composer';
import { BLOQUEO_ES } from './i18n/es';
import { ACTION_ICONS, MODE_ICONS } from './icons';
import type { BloqueoActions, BloqueoNotice, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, type CardActionView, type CardView } from './view';

const HELP_ID = 'bloqueo-card-help';
const REASON_ID = 'bloqueo-reason';

const EDITOR_LABEL: Readonly<Record<CardField, string>> = {
  targets: BLOQUEO_ES.card.targetsLabel,
  duration: BLOQUEO_ES.card.durationChip,
  end: BLOQUEO_ES.card.endChip,
  mode: BLOQUEO_ES.card.modesLabel,
  reason: BLOQUEO_ES.card.reasonLabel,
};

const EDITOR_PLACEHOLDER: Readonly<Partial<Record<CardField, string>>> = {
  targets: BLOQUEO_ES.card.editTargetsPlaceholder,
  duration: BLOQUEO_ES.card.editDurationPlaceholder,
  end: BLOQUEO_ES.card.editEndPlaceholder,
};

/** In-place editor of one chip: Enter applies, Esc (the window cascade) leaves it as it was. */
function ChipEditor(props: {
  field: CardField;
  initial: string;
  onCommit(text: string): string | null;
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
}): React.JSX.Element {
  const { card, actions, refs, notice } = props;
  const [editError, setEditError] = useState<string | null>(null);
  const repair = useRepair();
  const actionsHelp = useHelp(BLOQUEO_ROWS.actions);
  const snapshot = useAppStore((s) => s.snapshot);
  const draft = useAppStore((s) => s.main.card?.draft ?? null);
  const visible = useAppStore((s) => s.env.visible);

  // Re-render when «Sí, bloquear 6 h» unlocks (real clock only; a frozen harness stays).
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const frozen = snapshot.harness?.frozenNowMs ?? null;
  useEffect(() => {
    if (card.unlockAt === null || frozen !== null || !visible) return undefined;
    const left = card.unlockAt - Date.now();
    if (left <= 0) return undefined;
    const timer = setTimeout(tick, left + 4);
    return () => clearTimeout(timer);
  }, [card.unlockAt, frozen, visible]);

  // A new card puts the focus on its confirm button (Enter confirms).
  useLayoutEffect(() => {
    refs.primary.current?.focus({ preventScroll: true });
  }, [refs.primary]);

  useEffect(() => {
    if (card.editing === null) setEditError(null);
  }, [card.editing]);

  // The help line: an edit error, the repair outcome, a local notice, else the view's line.
  let helpText: string;
  let helpTone: HelpTone;
  if (editError && card.editing) {
    helpText = editError;
    helpTone = 'orange';
  } else if (repair.message) {
    helpText = repair.message.text;
    helpTone = repair.message.tone;
  } else if (card.actionsHelp.kind === 'error') {
    helpText = errorCopy(card.actionsHelp.error).text;
    helpTone = 'red';
  } else if (notice && notice.scope === 'card' && notice.intentId === props.intentId) {
    helpText = notice.text;
    helpTone = notice.tone;
  } else {
    helpText = card.actionsHelp.text;
    helpTone = card.actionsHelp.tone;
  }

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
        <div key={a.id} className={`bq-span-${a.span}`} {...hover}>
          <ConfirmButton
            ref={refs.primary}
            className="bq-confirm"
            label={a.label}
            disabled={a.disabled || a.locked}
            mnemonic={a.mnemonic ?? undefined}
            describedBy={HELP_ID}
            onPress={actions.enter}
          />
        </div>
      );
    }
    const repairing = a.id === 'repair' && repair.running;
    return (
      <div key={a.id} className={`bq-span-${a.span}`} {...hover}>
        <Tile
          id={a.id}
          label={repairing ? RENDERER_ES.protection.actions.repairing : a.label}
          icon={a.id === 'repair' ? ACTION_ICONS.repair : undefined}
          size="door"
          door={a.id === 'edit'}
          disabled={a.disabled || repairing}
          disabledReason={a.disabled ? BLOQUEO_ES.card.pendingHelp : undefined}
          mnemonic={a.mnemonic ?? undefined}
          onPress={a.id === 'repair' ? repair.run : actions.editInBloqueos}
        />
      </div>
    );
  };

  return (
    <div className="bq-body" role="group" aria-label={BLOQUEO_ES.card.label} onKeyDown={onKeyDown}>
      {card.composer ? (
        <Field
          id={BLOQUEO_FIELD_ID}
          ref={refs.field}
          size="main"
          label={BLOQUEO_ES.field.label}
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
          onError={setEditError}
        />
      ) : (
        <ChipList
          chips={card.chips}
          label={BLOQUEO_ES.card.targetsLabel}
          describedBy={HELP_ID}
          onPress={card.editable ? (chip) => chip.field && actions.startEdit(chip.field) : null}
          pressable={(chip) => chip.field !== null}
        />
      )}

      <TileRow
        id={BLOQUEO_ROWS.modes}
        label={BLOQUEO_ES.card.modesLabel}
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
          {BLOQUEO_ES.card.reasonLabel}
        </label>
        <Field
          id={REASON_ID}
          value={card.reason}
          label={BLOQUEO_ES.card.reasonLabel}
          placeholder={BLOQUEO_ES.card.reasonPlaceholder}
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
        <div className="bq-actions-grid">{card.actions.map(renderAction)}</div>
        <HelpLine id={HELP_ID} tone={helpTone} live="polite">
          {helpText}
        </HelpLine>
      </div>
    </div>
  );
}
