/**
 * The Emergencia detail window (PROMPT §7, §10 «Ventanas de detalle › Emergencia»;
 * docs/DESKTOP.md §7.7). Default export, no props: `DetailWindow` loads it lazily.
 *
 * One section whose title says the stage: «Emergencia: YouTube» (the price, the phrase typed by
 * hand), «Emergencia: esperando» («Esperando · 8:12» in orange, then «Cancelar (recomendado)»),
 * «Emergencia: lista» («Cancelar (recomendado) | Desbloquear», the latter with the in-place
 * «¿Seguro?») and «Emergencia: desbloqueado». Hardcore and Examen say why there is no
 * emergency. Staying blocked is always the recommended way out. Text is 400 like everywhere
 * else: the price is a fact in red, the wait a fact in orange, never a bold reproach.
 *
 * Keyboard and screen readers: every stage focuses its recommended control (the phrase field,
 * «Cancelar (recomendado)», «Cerrar»), and the window's polite region, there from the start,
 * says the new stage («Emergencia: esperando, lista a las 17:08»). Every tile has an Alt +
 * letter; Alt + D only arms «Desbloquear».
 */
import { Hourglass, Lock, LockOpen, Siren, X } from 'lucide-react';
import { useLayoutEffect } from 'react';
import {
  Bar,
  Countdown,
  Field,
  HelpLine,
  InPlaceConfirm,
  Section,
  StatusDot,
  Tile,
  TileRow,
} from '../../components';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import { useAppStore } from '../../store/context';
import { Announcer } from '../bloqueos/announcer';
import { EMERGENCIA } from './i18n';
import { useEmergencia, type EmergenciaApi } from './useEmergencia';
import {
  EMERGENCIA_IDS,
  EMERGENCIA_KEYS,
  EMERGENCIA_TILES,
  UNLOCK_ARM_ID,
  stageFocus,
  type EmergencyBlockRow,
} from './view';
import './emergencia.css';

const E = EMERGENCIA;

/** The wait speaks as it gets close («Podrás desbloquear en 5 minutos»), never «terminado». */
const WAIT_ANNOUNCE = {
  mark: (minutes: number): string => E.waitMark(minutes),
  get end(): string {
    return E.waitEnd;
  },
};
const DECIDE_ANNOUNCE = {
  mark: (minutes: number): string => E.decideMark(minutes),
  get end(): string {
    return E.decideEnd;
  },
};

function focusTile(item: string): void {
  document
    .querySelector<HTMLElement>(
      `[data-row-tile="${EMERGENCIA_IDS.row}"][data-tile-id="${CSS.escape(item)}"]`,
    )
    ?.focus({ preventScroll: true });
}

function BlockRows(props: { rows: readonly EmergencyBlockRow[] }): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  return (
    <ul className="emg-list" aria-label={E.listLabel}>
      {props.rows.map((row) => (
        <li key={row.id} className="emg-row" data-fate={row.fate}>
          <StatusDot tone={row.tone} />
          <span className="emg-row-label">{row.label}</span>
          <span className="emg-row-until">{row.until}</span>
          <span className="emg-row-fate" data-tone={row.fate === 'cancels' ? 'orange' : 'muted'}>
            {row.fateText}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RequestStage(props: { api: EmergenciaApi }): React.JSX.Element | null {
  const { api } = props;
  const { view } = api;
  if (!view.phrase || !view.request) return null;
  const request = view.request;
  return (
    <>
      <p className="emg-text emg-muted">
        {E.phrase.intro} <span className="emg-phrase">«{view.phrase.target}»</span>
      </p>
      <Field
        id={EMERGENCIA_IDS.phrase}
        value={api.phrase}
        label={E.phrase.label}
        maxLength={GUARDIAN_LIMITS.phraseMaxLength}
        describedBy={EMERGENCIA_IDS.phraseHelp}
        invalid={view.phrase.status === 'mismatch'}
        onChange={api.setPhrase}
        onPaste={(event) => {
          event.preventDefault();
          api.refusePaste();
        }}
        onDrop={(event) => {
          event.preventDefault();
          api.refusePaste();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          api.request();
        }}
      />
      <HelpLine id={EMERGENCIA_IDS.phraseHelp} tone={api.notice?.tone ?? view.phrase.tone}>
        {api.notice?.text ?? view.phrase.help}
      </HelpLine>
      <TileRow
        id={EMERGENCIA_IDS.row}
        label={E.actions.rowLabel}
        className="emg-row-2"
        help={E.actions.requestHelp}
      >
        <Tile
          id={EMERGENCIA_TILES.stay}
          label={E.actions.stay}
          icon={Lock}
          size="door"
          mnemonic={EMERGENCIA_KEYS.stay}
          help={E.actions.stayHelp}
          onPress={api.close}
        />
        <Tile
          id={EMERGENCIA_TILES.request}
          label={api.busy === 'request' ? E.actions.requesting : request.label}
          icon={Hourglass}
          size="door"
          mnemonic={EMERGENCIA_KEYS.request}
          help={E.actions.requestHelp}
          disabled={request.disabledReason !== null || api.busy !== null}
          disabledReason={request.disabledReason ?? undefined}
          onPress={api.request}
        />
      </TileRow>
    </>
  );
}

function CountingStage(props: { api: EmergenciaApi }): React.JSX.Element | null {
  const { api } = props;
  const emergency = api.view.emergency;
  if (!emergency) return null;
  return (
    <>
      <Bar value={emergency.progress} height={3} tone="orange" />
      <div className="emg-status" data-tone="orange">
        <span>{E.waiting}</span>
        <span aria-hidden="true">·</span>
        <Countdown endsAt={emergency.readyAtMs} size="row" announce={WAIT_ANNOUNCE} />
      </div>
      <p className="emg-text emg-muted">{E.waitingHelp}</p>
      <TileRow
        id={EMERGENCIA_IDS.row}
        label={E.actions.rowLabel}
        className="emg-row-2"
        help={api.notice?.text ?? E.actions.cancelHelp}
        helpTone={api.notice?.tone ?? 'muted'}
      >
        <Tile
          id={EMERGENCIA_TILES.cancel}
          label={E.actions.cancel}
          icon={Lock}
          size="door"
          mnemonic={EMERGENCIA_KEYS.cancel}
          help={E.actions.cancelHelp}
          disabled={api.busy !== null}
          onPress={api.cancel}
        />
      </TileRow>
    </>
  );
}

function ReadyStage(props: { api: EmergenciaApi }): React.JSX.Element | null {
  const { api } = props;
  const { view } = api;
  const emergency = view.emergency;
  if (!emergency) return null;
  return (
    <>
      {emergency.confirmByMs !== null ? (
        <div className="emg-status" data-tone="orange">
          <span>{E.readyLead}</span>
          <Countdown endsAt={emergency.confirmByMs} size="row" announce={DECIDE_ANNOUNCE} />
          <span>{E.readyTail}</span>
        </div>
      ) : null}
      {/* Its polite region says the armed «¿Seguro?» consequence and failures; a cancel that
          worked is said by the window with the stage it leads to. */}
      <TileRow
        id={EMERGENCIA_IDS.row}
        label={E.actions.rowLabel}
        className="emg-row-2"
        help={api.notice?.tone === 'red' ? api.notice.text : E.actions.cancelHelp}
        helpTone={api.notice?.tone === 'red' ? 'red' : 'muted'}
        helpLive="polite"
      >
        <Tile
          id={EMERGENCIA_TILES.cancel}
          label={E.actions.cancel}
          icon={Lock}
          size="door"
          mnemonic={EMERGENCIA_KEYS.cancel}
          help={E.actions.cancelHelp}
          disabled={api.busy !== null}
          onPress={api.cancel}
        />
        <InPlaceConfirm
          id={EMERGENCIA_TILES.unlock}
          armId={UNLOCK_ARM_ID}
          label={E.actions.unlock}
          icon={LockOpen}
          size="door"
          mnemonic={EMERGENCIA_KEYS.unlock}
          help={E.actions.unlockHelp}
          consequence={view.loss ?? E.actions.unlockHelp}
          disabled={api.busy !== null}
          onConfirm={api.confirm}
        />
      </TileRow>
    </>
  );
}

function CloseRow(props: { api: EmergenciaApi; help: string }): React.JSX.Element {
  return (
    <TileRow id={EMERGENCIA_IDS.row} label={E.actions.rowLabel} help={props.help}>
      <Tile
        id={EMERGENCIA_TILES.close}
        label={E.actions.close}
        icon={X}
        size="door"
        mnemonic={EMERGENCIA_KEYS.close}
        help={E.actions.closeHelp}
        onPress={props.api.close}
      />
    </TileRow>
  );
}

export default function EmergenciaWindow(): React.JSX.Element {
  const api = useEmergencia();
  const { view } = api;

  const request = useAppStore((s) => s.env.detail);

  // Every stage (and every new door) puts the focus on its recommended control, so it never
  // falls to <body> when the previous stage's controls go away.
  useLayoutEffect(() => {
    const target = stageFocus(view.stage);
    if (target === 'phrase') {
      document.getElementById(EMERGENCIA_IDS.phrase)?.focus({ preventScroll: true });
    } else {
      focusTile(EMERGENCIA_TILES[target]);
    }
  }, [view.stage, request]);

  return (
    <div className="emg" data-loading={api.loading ? '' : undefined}>
      <Section
        id={EMERGENCIA_IDS.section}
        icon={Siren}
        title={view.title}
        titleTone={view.stage === 'counting' ? 'orange' : 'default'}
        datum={view.datum}
        datumTone={view.datumTone}
      >
        {view.loss ? (
          <p className="emg-loss" data-tone="red">
            {view.loss}
          </p>
        ) : null}
        {view.stage === 'unavailable' && view.unavailable ? (
          <p className="emg-text">{view.unavailable}</p>
        ) : null}
        {view.done ? (
          <div className="emg-done">
            <p className="emg-loss" data-tone="red">
              {view.done.lost}
            </p>
            <p className="emg-text">{view.done.cancelled}</p>
            <p className="emg-text">{view.done.balance}</p>
          </div>
        ) : null}
        <BlockRows rows={view.rows} />
        {view.stage === 'request' ? <RequestStage api={api} /> : null}
        {view.stage === 'counting' ? <CountingStage api={api} /> : null}
        {view.stage === 'ready' ? <ReadyStage api={api} /> : null}
        {view.stage === 'unavailable' ? <CloseRow api={api} help={E.unavailable.help} /> : null}
        {view.stage === 'done' ? <CloseRow api={api} help={E.actions.closeHelp} /> : null}
      </Section>
      <Announcer announcement={api.announcement} />
    </div>
  );
}
