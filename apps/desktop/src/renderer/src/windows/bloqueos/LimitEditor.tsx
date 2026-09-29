/**
 * The daily-limit editor, in place under «Límites diarios» (ARCHITECTURE §5.10; the section
 * pattern, no modals): name and «Minutos al día», the days it blocks (L M X J V S D), what to
 * limit (the six categories plus what the form above names), what happens when it runs out
 * (Normal | Estricto | Hardcore), «Tu motivo», then «Guardar | Borrar | Cancelar».
 *
 * A softening edit says before saving that it waits 24 h; Hardcore takes the in-place
 * «¿Seguro?» on «Guardar» with the consequence in red; «Borrar» always asks (and waits 24 h).
 */
import { Check, Trash, X } from 'lucide-react';
import type { LimitMode } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
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
import { BLOQUEOS } from './i18n';
import { EntryChip, isPlainEnter } from './parts';
import type { BloqueosActions } from './useBloqueosWindow';
import { BLOQUEOS_IDS, type LimitEditorView } from './view';

const LE = BLOQUEOS.limits.editor;

const IDS = {
  title: `${BLOQUEOS_IDS.limitEditor}-title`,
  minutes: `${BLOQUEOS_IDS.limitEditor}-minutes`,
  days: `${BLOQUEOS_IDS.limitEditor}-days`,
  targets: `${BLOQUEOS_IDS.limitEditor}-targets`,
} as const;

export function LimitEditor(props: {
  view: LimitEditorView;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;

  // Esc closes the editor (after a «¿Seguro?» is disarmed).
  useEscape(ESC_PRIORITY.card, () => {
    actions.closeLimit();
    return true;
  });

  const actionsHelp =
    view.error ?? view.problem ?? (view.saving ? LE.saving : (view.note ?? LE.saveHelp));
  const actionsTone = view.error ? 'red' : view.problem || view.note ? 'orange' : 'muted';
  const blocked = view.problem !== null || view.saving;
  const saveReason = view.problem ?? (view.saving ? LE.saving : undefined);

  return (
    <div
      className="blq-editor"
      role="group"
      aria-labelledby={IDS.title}
      data-editor={view.id ?? 'new'}
      data-limit-editor=""
    >
      <h3 id={IDS.title} className="blq-editor-title">
        {view.title}
      </h3>

      <div className="blq-two">
        <label className="blq-col">
          <span className="blq-label">{LE.name}</span>
          <Field
            id={BLOQUEOS_IDS.limitName}
            value={view.name}
            label={LE.nameLabel}
            placeholder={view.namePlaceholder}
            maxLength={GUARDIAN_LIMITS.limitNameMaxLength + 10}
            autoFocus
            onChange={actions.setLimitName}
          />
        </label>
        <div className="blq-col">
          <label className="blq-col">
            <span className="blq-label">{LE.minutes}</span>
            <Field
              id={BLOQUEOS_IDS.limitMinutes}
              value={view.minutesText}
              label={LE.minutesLabel}
              placeholder={LE.minutesPlaceholder}
              describedBy={IDS.minutes}
              invalid={view.minutes.tone === 'orange'}
              maxLength={24}
              onChange={actions.setLimitMinutes}
              onKeyDown={(event) => {
                if (isPlainEnter(event)) event.preventDefault();
              }}
            />
          </label>
          <HelpLine id={IDS.minutes} tone={view.minutes.tone} className="blq-wrap">
            {view.minutes.text}
          </HelpLine>
        </div>
      </div>

      <fieldset className="blq-fieldset" aria-describedby={IDS.days}>
        <legend className="blq-label">{LE.days}</legend>
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
              onChange={(on) => actions.toggleLimitDay(day.day, on)}
            />
          ))}
        </div>
        <HelpLine id={IDS.days} tone="muted" className="blq-wrap">
          {LE.daysHelp}
        </HelpLine>
      </fieldset>

      <div className="blq-col">
        <span className="blq-label" id={IDS.targets}>
          {LE.targets}
        </span>
        <div className="blq-categories" role="group" aria-label={LE.categoriesLabel}>
          {view.categories.map((c) => (
            <Checkbox
              key={c.id}
              checked={c.checked}
              label={c.name}
              onChange={(on) => actions.toggleLimitCategory(c.id, on)}
            />
          ))}
        </div>
        {view.chips.length > 0 ? (
          <div className="blq-chips" role="group" aria-label={LE.extrasLabel}>
            {view.chips.map((chip) => (
              <EntryChip
                key={`${chip.kind}:${chip.key}`}
                label={chip.label}
                ariaLabel={LE.removeTarget(chip.label)}
                onPress={() => actions.removeLimitTarget(chip)}
              />
            ))}
          </div>
        ) : null}
        {view.fromForm ? (
          <div>
            <TextButton tone="blue" onPress={actions.addFormTargetsToLimit}>
              {LE.fromForm}
            </TextButton>
          </div>
        ) : null}
      </div>

      <div className="blq-col">
        <span className="blq-label">{LE.mode}</span>
        <Segmented<LimitMode>
          id={BLOQUEOS_IDS.rows.limitModes}
          label={LE.mode}
          value={view.mode}
          options={view.modes}
          columns={3}
          onChange={actions.setLimitMode}
          help={view.modes.find((m) => m.value === view.mode)?.help}
        />
      </div>

      <label className="blq-col">
        <span className="blq-label">{LE.reason}</span>
        <Field
          value={view.reason}
          label={LE.reasonLabel}
          placeholder={LE.reasonPlaceholder}
          maxLength={GUARDIAN_LIMITS.reasonMaxLength}
          onChange={actions.setLimitReason}
        />
      </label>

      <TileRow
        id={BLOQUEOS_IDS.rows.limitActions}
        label={LE.rowLabel}
        columns={3}
        help={actionsHelp}
        helpTone={actionsTone}
        className={view.remove ? 'blq-help-2' : 'blq-row-2 blq-help-2'}
      >
        {view.consequence ? (
          <InPlaceConfirm
            id="limit-save"
            armId="limit-save"
            label={LE.save}
            icon={Check}
            size="door"
            mnemonic={view.keys.save}
            help={LE.saveHelp}
            disabled={blocked}
            disabledReason={saveReason}
            consequence={view.consequence}
            onConfirm={actions.saveLimit}
          />
        ) : (
          <Tile
            id="limit-save"
            label={LE.save}
            icon={Check}
            size="door"
            mnemonic={view.keys.save}
            help={LE.saveHelp}
            disabled={blocked}
            disabledReason={saveReason}
            onPress={actions.saveLimit}
          />
        )}
        {view.remove ? (
          <InPlaceConfirm
            id="limit-delete"
            armId={`limit-delete:${view.id ?? ''}`}
            label={LE.remove}
            icon={Trash}
            size="door"
            mnemonic={view.keys.remove}
            help={LE.removeHelp}
            disabled={view.saving}
            disabledReason={view.saving ? LE.saving : undefined}
            consequence={view.remove.consequence}
            onConfirm={actions.deleteLimit}
          />
        ) : null}
        <Tile
          id="limit-cancel"
          label={LE.cancel}
          icon={X}
          size="door"
          mnemonic={view.keys.cancel}
          help={LE.cancelHelp}
          onPress={actions.closeLimit}
        />
      </TileRow>
    </div>
  );
}
