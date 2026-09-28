/**
 * The Emergencia detail window (PROMPT §7, §10 «Ventanas de detalle › Emergencia»;
 * docs/DESKTOP.md §7.7). Default export, no props: `DetailWindow` loads it lazily.
 *
 * One section whose title says the stage: «Emergencia: YouTube» (the price, the phrase typed by
 * hand), «Emergencia: esperando» («Esperando · 8:12 · Cancelar (recomendado)» in orange),
 * «Emergencia: lista» («Desbloquear» with the in-place «¿Seguro?») and «Emergencia:
 * desbloqueado». Hardcore and Examen say why there is no emergency. Staying blocked is always
 * the recommended way out.
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
import { EMERGENCIA_ES } from './i18n/es';
import { useEmergencia, type EmergenciaApi } from './useEmergencia';
import { EMERGENCIA_IDS, UNLOCK_ARM_ID, type EmergencyBlockRow } from './view';
import './emergencia.css';

const E = EMERGENCIA_ES;

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
      <p className="emg-text">
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
      <HelpLine
        id={EMERGENCIA_IDS.phraseHelp}
        tone={api.notice?.tone ?? view.phrase.tone}
        live="polite"
      >
        {api.notice?.text ?? view.phrase.help}
      </HelpLine>
      <TileRow
        id={EMERGENCIA_IDS.row}
        label={E.actions.rowLabel}
        className="emg-row-2"
        help={E.actions.requestHelp}
      >
        <Tile
          id="stay"
          label={E.actions.stay}
          icon={Lock}
          size="door"
          help={E.actions.stayHelp}
          onPress={api.close}
        />
        <Tile
          id="request"
          label={api.busy === 'request' ? E.actions.requesting : request.label}
          icon={Hourglass}
          size="door"
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
      <div className="emg-waiting" data-tone="orange">
        <span>{E.waiting}</span>
        <span aria-hidden="true">·</span>
        <Countdown endsAt={emergency.readyAtMs} size="row" />
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="c-textbutton"
          data-tone="orange"
          data-size={13}
          aria-describedby="emg-waiting-help"
          disabled={api.busy !== null}
          onClick={api.cancel}
        >
          {E.actions.cancel}
        </button>
      </div>
      <HelpLine id="emg-waiting-help" tone={api.notice?.tone ?? 'muted'} live="polite">
        {api.notice?.text ?? E.waitingHelp}
      </HelpLine>
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
        <div className="emg-waiting" data-tone="orange">
          <span>{E.readyLead}</span>
          <Countdown endsAt={emergency.confirmByMs} size="row" />
          <span>{E.readyTail}</span>
        </div>
      ) : null}
      <TileRow
        id={EMERGENCIA_IDS.row}
        label={E.actions.rowLabel}
        className="emg-row-2"
        help={api.notice?.text ?? E.actions.cancelHelp}
        helpTone={api.notice?.tone ?? 'muted'}
        helpLive="polite"
      >
        <Tile
          id="cancel"
          label={E.actions.cancel}
          icon={Lock}
          size="door"
          help={E.actions.cancelHelp}
          disabled={api.busy !== null}
          onPress={api.cancel}
        />
        <InPlaceConfirm
          id="unlock"
          armId={UNLOCK_ARM_ID}
          label={E.actions.unlock}
          icon={LockOpen}
          size="door"
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
        id="close"
        label={E.actions.close}
        icon={X}
        size="door"
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

  // The phrase field takes the focus when the request stage shows (and on every new door).
  useLayoutEffect(() => {
    if (view.stage === 'request') {
      document.getElementById(EMERGENCIA_IDS.phrase)?.focus({ preventScroll: true });
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
    </div>
  );
}
