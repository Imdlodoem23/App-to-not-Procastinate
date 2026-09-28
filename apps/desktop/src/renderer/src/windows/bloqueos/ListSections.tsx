/**
 * The lists under the Bloqueos form: «Activos» (what the guardian enforces now, with the way to
 * the emergency unlock), «Plantillas» (use one in the form, delete your own with an in-place
 * «¿Seguro?»), «Horarios» («L–V 16:00–19:00 · Redes sociales» with a switch per row) and
 * «Modo examen» (whitelist + Hardcore, straight to the main window's confirmation).
 *
 * Results («No se ha podido borrar…») show under their list without being live regions (they
 * mount with the text already in them); the window's polite region announces them.
 */
import { BookOpen, CalendarClock, GraduationCap, LayoutTemplate, Lock, Trash } from 'lucide-react';
import {
  HelpLine,
  InPlaceConfirm,
  Section,
  SettingsRow,
  StatusDot,
  TextButton,
  Tile,
  TileRow,
  Toggle,
  settingsRowIds,
} from '../../components';
import { errorCopy } from '../../i18n/errors';
import { useArmedState } from '../../store/context';
import { BLOQUEOS } from './i18n';
import type { BloqueosActions, Notice } from './useBloqueosWindow';
import {
  BLOQUEOS_IDS,
  BLOQUEOS_KEYS,
  type BloqueosView,
  type ExamView,
  type SchedulesView,
} from './view';

const E = BLOQUEOS;

export function ActiveSection(props: {
  view: BloqueosView['active'];
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;
  return (
    <Section id={BLOQUEOS_IDS.active} icon={Lock} title={view.title}>
      {view.rows.length === 0 ? (
        <p className="blq-note">{E.active.empty}</p>
      ) : (
        <ul className="blq-list" aria-label={E.active.listLabel}>
          {view.rows.map((row) => (
            <li key={row.id} className="blq-block-row">
              <StatusDot tone={row.tone} />
              <span className="blq-block-label">{row.label}</span>
              <span className="blq-block-until">{row.until}</span>
            </li>
          ))}
        </ul>
      )}
      {view.emergency ? (
        <div>
          <TextButton onPress={actions.openEmergency}>{E.active.emergency}</TextButton>
        </div>
      ) : null}
    </Section>
  );
}

function TemplateRow(props: {
  row: BloqueosView['templates']['rows'][number];
  actions: BloqueosActions;
}): React.JSX.Element {
  const { row, actions } = props;
  const armId = `template-delete:${row.id}`;
  const armed = useArmedState()?.id === armId;
  const ids = settingsRowIds(`blq-template-${row.id}`);
  return (
    <SettingsRow
      id={`blq-template-${row.id}`}
      title={row.label}
      description={
        armed ? (
          <span data-tone="red">{E.templates.removeConsequence(row.label)}</span>
        ) : row.builtin ? (
          `${row.description} · ${E.templates.builtin}`
        ) : (
          row.description
        )
      }
    >
      <div className="blq-row-actions" role="group" aria-labelledby={ids.title}>
        <Tile
          id={`use-${row.id}`}
          label={E.templates.use}
          icon={BookOpen}
          size="text"
          mnemonic={row.useKey}
          help={E.templates.useHelp}
          describedBy={ids.description}
          onPress={() => actions.applyTemplate(row.id)}
        />
        {row.builtin ? null : (
          <InPlaceConfirm
            id={`delete-${row.id}`}
            armId={armId}
            label={E.templates.remove}
            icon={Trash}
            size="text"
            mnemonic={row.removeKey}
            describedBy={ids.description}
            consequence={E.templates.removeConsequence(row.label)}
            onConfirm={() => actions.deleteTemplate(row.id)}
          />
        )}
      </div>
    </SettingsRow>
  );
}

export function TemplatesSection(props: {
  view: BloqueosView['templates'];
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  return (
    <Section id={BLOQUEOS_IDS.templates} icon={LayoutTemplate} title={props.view.title}>
      <div className="blq-rows">
        {props.view.rows.map((row) => (
          <TemplateRow key={row.id} row={row} actions={props.actions} />
        ))}
      </div>
      {props.notice ? (
        <HelpLine tone={props.notice.tone} className="blq-wrap">
          {props.notice.text}
        </HelpLine>
      ) : null}
    </Section>
  );
}

export function SchedulesSection(props: {
  view: SchedulesView;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions, notice } = props;
  return (
    <Section
      id={BLOQUEOS_IDS.schedules}
      icon={CalendarClock}
      title={view.title}
      datum={view.datum}
      datumTone="muted"
    >
      {view.status === 'error' && view.error ? (
        <div className="blq-inline">
          <HelpLine tone="red">{errorCopy(view.error).text}</HelpLine>
          <TextButton tone="blue" onPress={actions.retrySchedules}>
            {E.schedules.retry}
          </TextButton>
        </div>
      ) : null}
      {view.status === 'ready' && view.rows.length === 0 ? (
        <p className="blq-note">{E.schedules.empty}</p>
      ) : null}
      {view.rows.length > 0 ? (
        <div className="blq-rows">
          {view.rows.map((row) => {
            const ids = settingsRowIds(`blq-schedule-${row.id}`);
            return (
              <SettingsRow
                key={row.id}
                id={`blq-schedule-${row.id}`}
                title={row.title}
                description={row.description}
              >
                <Toggle
                  checked={row.enabled}
                  disabled={row.locked || row.saving}
                  labelledBy={ids.title}
                  describedBy={ids.description}
                  onChange={(on) => actions.toggleSchedule(row.id, on)}
                />
              </SettingsRow>
            );
          })}
        </div>
      ) : null}
      {notice ? (
        <HelpLine tone={notice.tone} className="blq-wrap">
          {notice.text}
        </HelpLine>
      ) : null}
    </Section>
  );
}

export function ExamSection(props: {
  view: ExamView;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;
  return (
    <Section
      id={BLOQUEOS_IDS.exam}
      icon={GraduationCap}
      title={view.title}
      datum={view.datum}
      datumTone="red"
    >
      <p className="blq-text blq-muted">{view.allowed}</p>
      <TileRow id={BLOQUEOS_IDS.rows.exam} label={E.exam.rowLabel} help={E.exam.rowHelp}>
        {view.tiles.map((tile) => (
          <Tile
            key={tile.minutes}
            id={`exam-${tile.minutes}`}
            label={tile.label}
            icon={GraduationCap}
            size="door"
            mnemonic={tile.mnemonic}
            help={tile.help}
            onPress={() => actions.startExam(tile.minutes)}
          />
        ))}
        <Tile
          id="exam-customize"
          label={E.exam.customize}
          size="door"
          door
          mnemonic={BLOQUEOS_KEYS.customize}
          help={E.exam.customizeHelp}
          onPress={actions.customizeExam}
        />
      </TileRow>
    </Section>
  );
}
