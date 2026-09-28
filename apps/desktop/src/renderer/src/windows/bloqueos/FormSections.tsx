/**
 * The right column of the Bloqueos form and its action bar: «Duración: 1 h» · «hasta 18:00»
 * (presets, then the duration and «Hasta las» fields in sync; «Duración: sin elegir» when the
 * phrase gave no time), «Modo: Estricto» (Normal | Estricto | Hardcore | Examen in a 2 × 2 grid,
 * explained on the help line) and «Tu motivo». Under both columns, pinned to the bottom of the
 * window while the form scrolls, «Guardar como plantilla | Bloquear…» with its help line;
 * «Bloquear…» opens the confirmation card in the main window.
 */
import { BookmarkPlus, Check, Lock, MessageSquareQuote, Shield, Timer, X } from 'lucide-react';
import { useState } from 'react';
import { Field, HelpLine, Section, Segmented, Tile, TileRow } from '../../components';
import { ESC_PRIORITY } from '../../hooks/keys';
import { useEscape } from '../../hooks/useKeys';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import type { BlockMode } from '@centrate/shared/domain';
import { BLOQUEOS_ES } from './i18n/es';
import { CommitField, isPlainEnter } from './parts';
import type { BloqueosActions, Notice } from './useBloqueosWindow';
import {
  BLOQUEOS_IDS,
  BLOQUEOS_KEYS,
  TEMPLATE_LABEL_MAX,
  type DurationView,
  type ModeView,
} from './view';

const E = BLOQUEOS_ES;

export function DurationSection(props: {
  view: DurationView;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;
  const [error, setError] = useState<string | null>(null);
  const helpId = 'blq-duration-help';
  const preset = view.presets.find((p) => p.selected);
  return (
    <Section
      id={BLOQUEOS_IDS.duration}
      icon={Timer}
      title={view.title}
      datum={view.datum}
      datumTone="muted"
    >
      <Segmented
        id={BLOQUEOS_IDS.rows.presets}
        label={E.duration.presetsLabel}
        value={preset ? String(preset.minutes) : 'custom'}
        options={view.presets.map((p) => ({
          value: String(p.minutes),
          label: p.label,
          help: p.help,
          tone: 'neutral' as const,
          mnemonic: p.mnemonic,
        }))}
        onChange={(value) => {
          setError(null);
          actions.setPreset(Number(value));
        }}
        help={E.duration.help}
      />
      <div className="blq-two">
        <label className="blq-col">
          <span className="blq-label">{E.duration.minutesLabel}</span>
          <CommitField
            value={view.fields.minutesText}
            label={E.duration.minutesLabel}
            placeholder={E.duration.minutesPlaceholder}
            describedBy={helpId}
            invalid={error !== null}
            onCommit={actions.commitMinutes}
            onError={setError}
          />
        </label>
        <label className="blq-col">
          <span className="blq-label">{E.duration.untilLabel}</span>
          <CommitField
            value={view.fields.untilText}
            label={E.duration.untilLabel}
            placeholder={E.duration.untilPlaceholder}
            describedBy={helpId}
            invalid={error !== null}
            onCommit={actions.commitUntil}
            onError={setError}
          />
        </label>
      </div>
      {error ? (
        <HelpLine id={helpId} tone="orange" live="polite">
          {error}
        </HelpLine>
      ) : (
        <HelpLine id={helpId} tone={props.notice?.tone ?? 'muted'} live="polite">
          {props.notice?.text ?? null}
        </HelpLine>
      )}
    </Section>
  );
}

export function ModeSection(props: {
  view: ModeView;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { view, actions } = props;
  return (
    <Section
      id={BLOQUEOS_IDS.mode}
      icon={Shield}
      title={view.title}
      datum={view.datum}
      datumTone={view.value === 'hardcore' || view.value === 'exam' ? 'red' : 'muted'}
    >
      {/* Four modes do not fit one row of the column: a 2 × 2 grid, the help on two lines. */}
      <div className="blq-grid-2 blq-help-2">
        <Segmented<BlockMode>
          id={BLOQUEOS_IDS.rows.modes}
          label={E.mode.rowLabel}
          value={view.value}
          options={view.options}
          onChange={actions.setMode}
          help={E.mode.help[view.value]}
        />
      </div>
    </Section>
  );
}

function NamingRow(props: {
  name: string;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { actions } = props;
  useEscape(ESC_PRIORITY.card, () => {
    actions.cancelTemplate();
    return true;
  });
  return (
    <>
      <Field
        value={props.name}
        label={E.actions.nameLabel}
        maxLength={TEMPLATE_LABEL_MAX + 10}
        autoFocus
        describedBy={`${BLOQUEOS_IDS.rows.naming}-help`}
        onChange={actions.setTemplateName}
        onKeyDown={(event) => {
          if (!isPlainEnter(event)) return;
          event.preventDefault();
          actions.saveTemplate();
        }}
      />
      <TileRow
        id={BLOQUEOS_IDS.rows.naming}
        label={E.actions.nameRowLabel}
        className="blq-row-2"
        help={props.notice?.text ?? E.actions.saveNameHelp}
        helpTone={props.notice?.tone ?? 'muted'}
      >
        <Tile
          id="save"
          label={E.actions.saveName}
          icon={Check}
          size="door"
          mnemonic={BLOQUEOS_KEYS.saveName}
          help={E.actions.saveNameHelp}
          onPress={actions.saveTemplate}
        />
        <Tile
          id="cancel"
          label={E.actions.cancel}
          icon={X}
          size="door"
          mnemonic={BLOQUEOS_KEYS.cancelName}
          help={E.actions.cancelHelp}
          onPress={actions.cancelTemplate}
        />
      </TileRow>
    </>
  );
}

export function ReasonSection(props: {
  reason: string;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { actions } = props;
  return (
    <Section
      id={BLOQUEOS_IDS.reason}
      icon={MessageSquareQuote}
      title={E.reason.title}
      datum={E.reason.datum}
      datumTone="muted"
    >
      <Field
        value={props.reason}
        label={E.reason.label}
        placeholder={E.reason.placeholder}
        maxLength={GUARDIAN_LIMITS.reasonMaxLength}
        onChange={actions.setReason}
        onKeyDown={(event) => {
          if (!isPlainEnter(event)) return;
          event.preventDefault();
          actions.block();
        }}
        describedBy={`${BLOQUEOS_IDS.rows.actions}-help`}
      />
    </Section>
  );
}

/**
 * «Guardar como plantilla | Bloquear…» (or, while naming a template, the name and «Guardar |
 * Cancelar»), pinned to the bottom of the window so the way forward and why it is disabled
 * («Elige cuánto dura») are always in view. Results are announced by the window's region.
 */
export function FormActions(props: {
  templateName: string | null;
  problemText: string | null;
  notice: Notice | undefined;
  actions: BloqueosActions;
}): React.JSX.Element {
  const { actions, notice } = props;
  return (
    <div className="blq-actions" data-actions="">
      {props.templateName !== null ? (
        <NamingRow name={props.templateName} notice={notice} actions={actions} />
      ) : (
        <TileRow
          id={BLOQUEOS_IDS.rows.actions}
          label={E.actions.rowLabel}
          className="blq-row-2"
          help={notice?.text ?? props.problemText ?? E.actions.blockHelp}
          helpTone={notice?.tone ?? (props.problemText ? 'orange' : 'muted')}
        >
          <Tile
            id="save"
            label={E.actions.save}
            icon={BookmarkPlus}
            size="door"
            mnemonic={BLOQUEOS_KEYS.save}
            help={E.actions.saveHelp}
            disabled={props.problemText !== null}
            disabledReason={props.problemText ?? undefined}
            onPress={actions.startTemplate}
          />
          <Tile
            id="block"
            label={E.actions.block}
            icon={Lock}
            size="door"
            door
            mnemonic={BLOQUEOS_KEYS.block}
            help={E.actions.blockHelp}
            disabled={props.problemText !== null}
            disabledReason={props.problemText ?? undefined}
            onPress={actions.block}
          />
        </TileRow>
      )}
    </div>
  );
}
