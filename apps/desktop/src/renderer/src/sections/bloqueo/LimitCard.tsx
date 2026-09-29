/**
 * The «Límite diario» card, in place (ARCHITECTURE §5.10; «YouTube máximo 30 minutos al día»):
 * what is limited, «30 min al día» and the days (chips), Normal | Estricto | Hardcore with what
 * happens when it runs out, «Tu motivo» and Editar… | Crear límite: 30 min al día. Enter
 * creates it; Hardcore first adds the red line and «Sí, crear el límite» waits 2 s. Esc closes
 * it. «Editar…» opens Bloqueos › Límites diarios with this limit in its editor.
 */
import { useEffect, useLayoutEffect, type KeyboardEvent } from 'react';
import type { LimitMode } from '@centrate/shared/domain';
import { ConfirmButton, Field, HelpLine, Tile, TileRow, type HelpTone } from '../../components';
import { useHelp } from '../../hooks/useHelp';
import { errorCopy } from '../../i18n/errors';
import { ChipList } from './ChipList';
import { isEnter } from './Composer';
import { BLOQUEO } from './i18n';
import { MODE_ICONS } from './icons';
import type { BloqueoActions, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_FIELD_ID, BLOQUEO_ROWS, type CardActionView, type LimitCardView } from './view';

const HELP_ID = 'bloqueo-limit-help';
const SUMMARY_ID = 'bloqueo-limit-summary';
const REASON_ID = 'bloqueo-limit-reason';

export function LimitCard(props: {
  card: LimitCardView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
  announce(text: string): void;
}): React.JSX.Element {
  const { card, actions, refs, announce } = props;
  const actionsHelp = useHelp(BLOQUEO_ROWS.actions);

  // A new card puts the focus on its confirm button (Enter creates the limit).
  useLayoutEffect(() => {
    refs.primary.current?.focus({ preventScroll: true });
  }, [refs.primary]);

  let helpText: string;
  let helpTone: HelpTone;
  let result: string | null = null;
  if (card.actionsHelp.kind === 'error') {
    helpText = errorCopy(card.actionsHelp.error).text;
    helpTone = 'red';
    result = 'error';
  } else {
    helpText = card.actionsHelp.text;
    helpTone = card.actionsHelp.tone;
    if (card.status === 'consequence' && helpTone === 'red') result = 'consequence';
  }
  const resultKey = result === null ? null : `${result}\u0000${helpText}`;
  const resultText = result === null ? null : helpText;
  useEffect(() => {
    if (resultKey !== null && resultText !== null) announce(resultText);
  }, [resultKey, resultText, announce]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isEnter(event)) return;
    const target = event.target as HTMLElement;
    // Enter on a mode tile creates (arrows choose the mode); other buttons press themselves.
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
        <div key="primary" className={`bq-span-${a.span}`} {...hover}>
          <ConfirmButton
            ref={refs.primary}
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
    return (
      <div key="secondary" className={`bq-span-${a.span}`} {...hover}>
        <Tile
          id={a.id}
          label={a.label}
          size="door"
          door
          disabled={a.disabled}
          disabledReason={a.disabled ? BLOQUEO.limit.sendingHelp : undefined}
          mnemonic={a.mnemonic ?? undefined}
          onPress={actions.editLimitInBloqueos}
        />
      </div>
    );
  };

  return (
    <div
      className="bq-body"
      role="group"
      aria-label={BLOQUEO.limit.label}
      data-limit-card=""
      onKeyDown={onKeyDown}
    >
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

      <ChipList
        chips={card.chips}
        label={BLOQUEO.limit.targetsLabel}
        describedBy={HELP_ID}
        onPress={null}
        pressable={() => false}
      />

      <TileRow
        id={BLOQUEO_ROWS.modes}
        label={BLOQUEO.card.modesLabel}
        kind="radiogroup"
        columns={3}
        help={card.modeHelp}
      >
        {card.modes.map((m) => (
          <Tile
            key={m.id}
            id={m.id}
            label={m.label}
            icon={MODE_ICONS[m.id as LimitMode]}
            help={m.help}
            tone={m.accent ?? undefined}
            selected={m.selected}
            disabled={m.disabled}
            disabledReason={m.disabledReason ?? undefined}
            mnemonic={m.mnemonic ?? undefined}
            onPress={() => actions.setLimitMode(m.id as LimitMode)}
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
          onChange={actions.setLimitReason}
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
        <HelpLine id={HELP_ID} tone={helpTone}>
          {helpText}
        </HelpLine>
      </div>
    </div>
  );
}
