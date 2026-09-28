/**
 * Settings controls (the «Extra» of G-Helper, PROMPT §10 «Ajustes»): `Segmented` (a radiogroup
 * of text tiles, applied at once), `Toggle` (a switch that always says «Sí» / «No»), `Checkbox`,
 * `SettingsRow` (48 px: title and description on the left, the control on the right),
 * `TextButton` (grey or blue text actions such as «Desbloqueo de emergencia…») and
 * `EmptyState` (24 px icon, one sentence, one action).
 */
import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import type { Accent } from '@centrate/shared/design/tokens';
import { RENDERER_ES } from '../i18n/es';
import { Icon } from './Icon';
import { Tile, type TileSize } from './Tile';
import { TileRow } from './TileRow';
import type { HelpTone } from './HelpLine';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  help?: string;
  tone?: Accent;
  icon?: LucideIcon;
  mnemonic?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function Segmented<T extends string>(props: {
  id: string;
  label: string;
  /** `T` is inferred from `value` only, so option literals need no `as const`. */
  options: readonly SegmentedOption<NoInfer<T>>[];
  value: T;
  onChange(value: NoInfer<T>): void;
  columns?: 3 | 4;
  size?: TileSize;
  help?: ReactNode;
  helpTone?: HelpTone;
}): React.JSX.Element {
  const { id, label, options, value, onChange, columns = 4, size = 'text' } = props;
  return (
    <TileRow
      id={id}
      label={label}
      columns={columns}
      kind="radiogroup"
      help={props.help}
      helpTone={props.helpTone}
    >
      {options.map((option) => (
        <Tile
          key={option.value}
          id={option.value}
          label={option.label}
          icon={option.icon}
          help={option.help}
          tone={option.tone}
          mnemonic={option.mnemonic}
          size={size}
          selected={option.value === value}
          disabled={option.disabled}
          disabledReason={option.disabledReason}
          onPress={() => {
            if (option.value !== value) onChange(option.value);
          }}
        />
      ))}
    </TileRow>
  );
}

/** Ids for the parts of a `SettingsRow`, so its control can be labelled and described. */
export function settingsRowIds(id: string): { title: string; description: string } {
  return { title: `${id}-title`, description: `${id}-desc` };
}

export function SettingsRow(props: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  const ids = settingsRowIds(props.id);
  return (
    <div className={props.className ? `c-settings-row ${props.className}` : 'c-settings-row'}>
      <div className="c-settings-text">
        <div id={ids.title} className="c-settings-title">
          {props.title}
        </div>
        {props.description ? (
          <div id={ids.description} className="c-settings-desc">
            {props.description}
          </div>
        ) : null}
      </div>
      <div className="c-settings-control">{props.children}</div>
    </div>
  );
}

/** A switch that always shows its state in words («Sí» / «No»), not only by position. */
export function Toggle(props: {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Accessible name: the settings row title id, or a label. */
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}): React.JSX.Element {
  const { checked, onChange, disabled = false } = props;
  return (
    <button
      ref={props.ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.label}
      aria-describedby={props.describedBy}
      aria-disabled={disabled ? true : undefined}
      className="c-toggle"
      data-checked={checked ? '' : undefined}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="c-toggle-text" aria-hidden="true">
        {checked ? RENDERER_ES.kit.toggleOn : RENDERER_ES.kit.toggleOff}
      </span>
      <span className="c-toggle-track" aria-hidden="true">
        <span className="c-toggle-knob" />
      </span>
    </button>
  );
}

export function Checkbox(props: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: ReactNode;
  describedBy?: string;
  disabled?: boolean;
  id?: string;
}): React.JSX.Element {
  return (
    <label className="c-check" data-disabled={props.disabled ? '' : undefined}>
      <span className="c-check-box">
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={props.describedBy}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <Icon icon={Check} size="header" className="c-check-mark" />
      </span>
      <span className="c-check-label">{props.label}</span>
    </label>
  );
}

/** A text action: grey (secondary links) or blue (information, «Actualizar a v1.3.0»). */
export function TextButton(props: {
  children: ReactNode;
  onPress(): void;
  tone?: 'muted' | 'blue' | 'red';
  size?: 12 | 13;
  describedBy?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}): React.JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      className={props.className ? `c-textbutton ${props.className}` : 'c-textbutton'}
      data-tone={props.tone ?? 'muted'}
      data-size={props.size ?? 12}
      aria-describedby={props.describedBy}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/** Empty states: a 24 px icon, one sentence and one action. */
export function EmptyState(props: {
  icon: LucideIcon;
  text: ReactNode;
  action?: { label: string; onPress(): void; icon?: LucideIcon };
}): React.JSX.Element {
  return (
    <div className="c-empty">
      <Icon icon={props.icon} size="empty" />
      <p className="c-empty-text">{props.text}</p>
      {props.action ? (
        <Tile
          id="empty-action"
          label={props.action.label}
          icon={props.action.icon}
          size="text"
          onPress={props.action.onPress}
          className="c-empty-action"
        />
      ) : null}
    </div>
  );
}
