/**
 * The schedule editor, in place under «Horarios» (PROMPT §9 «Horarios», §10: no modals, the
 * section pattern): name and reason, the days (L M X J V S D), «Desde» and «Hasta» with the
 * length on the help line, what to block (the six categories plus what the form above names),
 * the mode, then «Guardar | Borrar | Cancelar».
 *
 * Hardcore and Examen take the in-place «¿Seguro?» on «Guardar» with the consequence in red
 * (the guardian needs `acknowledgeNoEmergency`); «Borrar» always asks. The help line under the
 * actions says why «Guardar» cannot send (a running schedule, a weakening edit 10 min before
 * it starts, a missing day…) or what the guardian answered.
 */
import { Check, Trash, X } from 'lucide-react';
import {
  Checkbox,
  Field,
  HelpLine,
  InPlaceConfirm,
  Segmented,
  TextButton,
  Tile,
  TileRow,
} from '../../components';
import { ESC_PRIORITY } from '../../hooks/keys';
import { useEscape } from '../../hooks/useKeys';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import type { BlockMode } from '@centrate/shared/domain';
import { BLOQUEOS } from './i18n';
import { EntryChip, isPlainEnter } from './parts';
import type { BloqueosActions } from './useBloqueosWindow';
import { BLOQUEOS_IDS, type ScheduleEditorView } from './view';

const ES = BLOQUEOS.schedules.editor;

const IDS = {
  title: `${BLOQUEOS_IDS.scheduleEditor}-title`,
  times: `${BLOQUEOS_IDS.scheduleEditor}-times`,
  targets: `${BLOQUEOS_IDS.scheduleEditor}-targets`,
} as const;

export function ScheduleEditor(props: {
  view: ScheduleEditorView;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;

  // Esc closes the editor (after a «¿Seguro?» is disarmed and a template name is closed).
  useEscape(ESC_PRIORITY.card, () => {
    actions.closeSchedule();
    return true;
  });

  const actionsHelp = view.error ?? view.problem ?? (view.saving ? ES.saving : ES.saveHelp);
  const actionsTone = view.error ? 'red' : view.problem ? 'orange' : 'muted';
  const blocked = view.problem !== null || view.saving;
  const saveReason = view.problem ?? (view.saving ? ES.saving : undefined);

  return (
    <div
      className="blq-editor"
      role="group"
      aria-labelledby={IDS.title}
      data-editor={view.id ?? 'new'}
    >
      <h3 id={IDS.title} className="blq-editor-title">
        {view.title}
      </h3>

      <div className="blq-two">
        <label className="blq-col">
          <span className="blq-label">{ES.name}</span>
          <Field
            id={BLOQUEOS_IDS.scheduleName}
            value={view.name}
            label={ES.nameLabel}
            placeholder={view.namePlaceholder}
            maxLength={GUARDIAN_LIMITS.scheduleNameMaxLength + 10}
            autoFocus
            onChange={actions.setScheduleName}
          />
        </label>
        <label className="blq-col">
          <span className="blq-label">{ES.reason}</span>
          <Field
            value={view.reason}
            label={ES.reasonLabel}
            placeholder={ES.reasonPlaceholder}
            maxLength={GUARDIAN_LIMITS.reasonMaxLength}
            onChange={actions.setScheduleReason}
          />
        </label>
      </div>

      <fieldset className="blq-fieldset">
        <legend className="blq-label">{ES.days}</legend>
        <div className="blq-days">
          {view.days.map((day) => (
            <Checkbox
              key={day.day}
              checked={day.checked}
              label={
                <>
                  <span aria-hidden="true">{day.short}</span>
                  <span className="sr-only">{day.long}</span>
                </>
              }
              onChange={(on) => actions.toggleScheduleDay(day.day, on)}
            />
          ))}
        </div>
      </fieldset>

      <div className="blq-col">
        <div className="blq-two">
          <label className="blq-col">
            <span className="blq-label">{ES.start}</span>
            <Field
              value={view.start}
              label={ES.start}
              placeholder={ES.startPlaceholder}
              describedBy={IDS.times}
              invalid={view.times.tone === 'orange'}
              onChange={actions.setScheduleStart}
              onBlur={actions.commitScheduleTimes}
              onKeyDown={(event) => {
                if (isPlainEnter(event)) actions.commitScheduleTimes();
              }}
            />
          </label>
          <label className="blq-col">
            <span className="blq-label">{ES.end}</span>
            <Field
              value={view.end}
              label={ES.end}
              placeholder={ES.endPlaceholder}
              describedBy={IDS.times}
              invalid={view.times.tone === 'orange'}
              onChange={actions.setScheduleEnd}
              onBlur={actions.commitScheduleTimes}
              onKeyDown={(event) => {
                if (isPlainEnter(event)) actions.commitScheduleTimes();
              }}
            />
          </label>
        </div>
        <HelpLine id={IDS.times} tone={view.times.tone} className="blq-wrap">
          {view.times.text}
        </HelpLine>
      </div>

      <div className="blq-col">
        <span className="blq-label" id={IDS.targets}>
          {ES.targets}
        </span>
        {view.whitelist ? (
          <p className="blq-text">{view.whitelist}</p>
        ) : (
          <>
            <div className="blq-categories" role="group" aria-label={ES.categoriesLabel}>
              {view.categories.map((c) => (
                <Checkbox
                  key={c.id}
                  checked={c.checked}
                  label={c.name}
                  onChange={(on) => actions.toggleScheduleCategory(c.id, on)}
                />
              ))}
            </div>
            {view.chips.length > 0 ? (
              <div className="blq-chips" role="group" aria-label={ES.extrasLabel}>
                {view.chips.map((chip) => (
                  <EntryChip
                    key={`${chip.kind}:${chip.key}`}
                    label={chip.label}
                    ariaLabel={ES.removeTarget(chip.label)}
                    onPress={() => actions.removeScheduleTarget(chip)}
                  />
                ))}
              </div>
            ) : null}
            {view.fromForm ? (
              <div>
                <TextButton tone="blue" onPress={actions.addFormTargets}>
                  {ES.fromForm}
                </TextButton>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="blq-col">
        <span className="blq-label">{ES.mode}</span>
        <Segmented<BlockMode>
          id={BLOQUEOS_IDS.rows.scheduleModes}
          label={ES.mode}
          value={view.mode}
          options={view.modes}
          onChange={actions.setScheduleMode}
          help={BLOQUEOS.mode.help[view.mode]}
        />
      </div>

      <TileRow
        id={BLOQUEOS_IDS.rows.scheduleActions}
        label={ES.rowLabel}
        columns={3}
        help={actionsHelp}
        helpTone={actionsTone}
        className={view.remove ? undefined : 'blq-row-2'}
      >
        {view.consequence ? (
          <InPlaceConfirm
            id="schedule-save"
            armId="schedule-save"
            label={ES.save}
            icon={Check}
            size="door"
            mnemonic={view.keys.save}
            help={ES.saveHelp}
            disabled={blocked}
            disabledReason={saveReason}
            consequence={view.consequence}
            onConfirm={actions.saveSchedule}
          />
        ) : (
          <Tile
            id="schedule-save"
            label={ES.save}
            icon={Check}
            size="door"
            mnemonic={view.keys.save}
            help={ES.saveHelp}
            disabled={blocked}
            disabledReason={saveReason}
            onPress={actions.saveSchedule}
          />
        )}
        {view.remove ? (
          <InPlaceConfirm
            id="schedule-delete"
            armId={`schedule-delete:${view.id ?? ''}`}
            label={ES.remove}
            icon={Trash}
            size="door"
            mnemonic={view.keys.remove}
            help={ES.removeHelp}
            disabled={view.remove.lock !== null || view.saving}
            disabledReason={view.remove.lock ?? (view.saving ? ES.saving : undefined)}
            consequence={view.remove.consequence}
            onConfirm={actions.deleteSchedule}
          />
        ) : null}
        <Tile
          id="schedule-cancel"
          label={ES.cancel}
          icon={X}
          size="door"
          mnemonic={view.keys.cancel}
          help={ES.cancelHelp}
          onPress={actions.closeSchedule}
        />
      </TileRow>
    </div>
  );
}
