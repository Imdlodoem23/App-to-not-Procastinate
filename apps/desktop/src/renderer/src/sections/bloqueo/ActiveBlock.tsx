/**
 * Section 2 with a block (PROMPT §10 «Con bloqueo», «Castigo»): the big countdown of the block
 * that ends last, its 3 px mode bar and, under it, «Tu motivo» in italics with the grey
 * «Desbloqueo de emergencia…» (or «Hardcore: no se puede cancelar»); the extend row
 * +15 min | +30 min | +1 h | Otro… with its 5 s undo; the other blocks as 28 px rows (at most
 * two, then «y 3 más…»). There is no control that shortens anything. A punishment has a red
 * bar, its cause and «−100 puntos», and no extend row.
 */
import {
  Bar,
  Countdown,
  Field,
  StatusDot,
  TextButton,
  Tile,
  TileRow,
  type HelpTone,
} from '../../components';
import { Composer, isEnter } from './Composer';
import { BLOQUEO_ES } from './i18n/es';
import { EXTEND_ICONS } from './icons';
import type { BloqueoActions, BloqueoNotice, BloqueoRefs } from './useBloqueo';
import { BLOQUEO_ROWS, type ActiveView, type ExtendView } from './view';
import { EXTEND_PRESETS } from '../../../../shared/ui-state';

const MINUTES_BY_TILE: Readonly<Record<string, number>> = Object.fromEntries(
  EXTEND_PRESETS.map((m) => [`+${m}`, m]),
);

function extendHelp(props: {
  extend: ExtendView;
  actions: BloqueoActions;
  notice: BloqueoNotice | null;
}): { node: React.ReactNode; tone: HelpTone; live: boolean } {
  const { extend, actions, notice } = props;
  if (extend.other.open)
    return { node: extend.other.line.text, tone: extend.other.line.tone, live: false };
  const undo = extend.undo;
  if (undo?.kind === 'waiting') {
    return {
      node: (
        <span className="bq-undo">
          <span data-fit="">{undo.text} ·</span>
          <button
            type="button"
            className="c-textbutton"
            data-tone="blue"
            aria-label={undo.buttonLabel}
            onClick={() => actions.undo(undo.entryId)}
          >
            {undo.button}
          </button>
        </span>
      ),
      tone: 'muted',
      live: true,
    };
  }
  if (undo?.kind === 'sending') return { node: undo.text, tone: 'muted', live: true };
  if (undo?.kind === 'failed') {
    return {
      node: (
        <span className="bq-undo">
          <span data-fit="">{undo.text} ·</span>
          <TextButton tone="blue" onPress={() => actions.retryExtend(undo.entryId)}>
            {undo.button}
          </TextButton>
        </span>
      ),
      tone: 'red',
      live: true,
    };
  }
  if (notice?.scope === 'extend') return { node: notice.text, tone: notice.tone, live: true };
  return { node: extend.help, tone: 'muted', live: false };
}

function ExtendRow(props: {
  extend: ExtendView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
  notice: BloqueoNotice | null;
}): React.JSX.Element {
  const { extend, actions, refs } = props;
  const help = extendHelp(props);
  // While the undo line (or a result) shows, the tiles do not take the help line over.
  const quiet = extend.undo !== null || props.notice?.scope === 'extend';
  const other = extend.other;
  return (
    <TileRow
      id={BLOQUEO_ROWS.extend}
      label={BLOQUEO_ES.active.extendLabel}
      help={help.node}
      helpTone={help.tone}
      helpLive={help.live ? 'polite' : undefined}
    >
      {other.open ? (
        <>
          <div className="bq-other-field">
            <Field
              ref={refs.otherField}
              value={other.text}
              label={BLOQUEO_ES.active.otherLabel}
              placeholder={BLOQUEO_ES.active.otherPlaceholder}
              invalid={other.text.trim() !== '' && !other.canApply}
              describedBy={`${BLOQUEO_ROWS.extend}-help`}
              inputMode="text"
              maxLength={20}
              onChange={actions.setOtherText}
              onKeyDown={(event) => {
                if (!isEnter(event)) return;
                event.preventDefault();
                actions.applyOther();
              }}
            />
          </div>
          <Tile
            id="apply"
            label={BLOQUEO_ES.active.otherApply}
            icon={EXTEND_ICONS['apply']}
            disabled={!other.canApply}
            disabledReason={other.line.text}
            onPress={actions.applyOther}
          />
        </>
      ) : (
        extend.tiles.map((t, i) => (
          <Tile
            key={t.id}
            ref={i === 0 ? refs.firstExtend : undefined}
            id={t.id}
            label={t.label}
            icon={EXTEND_ICONS[t.id]}
            help={quiet ? undefined : t.help}
            door={t.door}
            disabled={t.disabled}
            disabledReason={quiet ? undefined : (t.disabledReason ?? undefined)}
            mnemonic={t.mnemonic ?? undefined}
            onPress={() => {
              if (t.id === 'other') actions.openOther();
              else {
                const minutes = MINUTES_BY_TILE[t.id];
                if (minutes !== undefined) actions.extend(minutes);
              }
            }}
          />
        ))
      )}
    </TileRow>
  );
}

export function ActiveBlock(props: {
  active: ActiveView;
  actions: BloqueoActions;
  refs: BloqueoRefs;
  notice: BloqueoNotice | null;
}): React.JSX.Element {
  const { active, actions, refs, notice } = props;
  const emergency = active.emergency;
  const more = active.more;
  return (
    <div className="bq-body">
      <div className="bq-countdown-row">
        {active.endsAt ? (
          <Countdown endsAt={active.endsAt} size="big" />
        ) : (
          <div className="bq-boot-hold" role="status">
            {active.bootHold}
          </div>
        )}
      </div>
      <Bar value={active.bar.value} height={3} tone={active.bar.accent} />

      {active.punishment || active.reason || emergency ? (
        <div className="bq-under-bar">
          {active.punishment ? (
            <span data-fit="">
              {active.punishment.cause} ·{' '}
              <span className="bq-points">{active.punishment.points}</span>
            </span>
          ) : active.reason ? (
            <span className="bq-reason" data-fit="">
              <span className="sr-only">{BLOQUEO_ES.active.reasonLabel}: </span>
              {active.reason}
            </span>
          ) : null}
          {emergency?.kind === 'link' ? (
            <TextButton onPress={() => actions.openDetail(emergency.request)}>
              {emergency.label}
            </TextButton>
          ) : emergency?.kind === 'text' ? (
            <span className="bq-emergency-text" data-fit="">
              {emergency.label}
            </span>
          ) : null}
        </div>
      ) : null}

      {active.extend ? (
        <ExtendRow extend={active.extend} actions={actions} refs={refs} notice={notice} />
      ) : null}

      {active.rows.length > 0 ? (
        <ul className="bq-rows">
          {active.rows.map((row) => (
            <li key={row.id} className="bq-row">
              <StatusDot tone={row.accent} />
              <span className="bq-row-label" data-fit="">
                {row.label}
              </span>
              <Countdown endsAt={row.endsAt} size="row" />
            </li>
          ))}
        </ul>
      ) : null}

      {more ? (
        <div className="bq-more">
          <TextButton onPress={() => actions.openDetail(more.request)}>{more.label}</TextButton>
        </div>
      ) : null}

      {active.composer ? (
        <Composer composer={active.composer} actions={actions} refs={refs} />
      ) : null}
    </div>
  );
}
