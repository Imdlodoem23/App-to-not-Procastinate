/**
 * Small pieces of the Bloqueos window: the removable entry and suggestion chips, the group
 * expander (a text button, never an icon alone) and a field that edits a derived value
 * («Duración», «Hasta las») and commits on Enter or when the focus leaves.
 */
import { Plus, X } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Field, Icon } from '../../components';
import { ESC_PRIORITY } from '../../hooks/keys';
import { useEscape } from '../../hooks/useKeys';

export function isPlainEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !event.nativeEvent.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/**
 * «marca.com ×»: a chip whose press removes the entry (its name is the visible text). `pending`
 * draws it dashed: an addition that is still waiting to apply («geogebra.org · desde mañana»).
 */
export function EntryChip(props: {
  label: string;
  ariaLabel: string;
  describedBy?: string;
  pending?: boolean;
  onPress(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="blq-chip"
      data-kind={props.pending ? 'pending' : undefined}
      aria-label={props.ariaLabel}
      aria-describedby={props.describedBy}
      onClick={props.onPress}
    >
      <span className="blq-chip-text">{props.label}</span>
      <Icon icon={X} size="header" className="blq-chip-icon" />
    </button>
  );
}

/** «+ Discord»: a suggestion the user can add with one click. */
export function SuggestionChip(props: {
  label: string;
  ariaLabel: string;
  onPress(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="blq-chip"
      data-kind="suggestion"
      aria-label={props.ariaLabel}
      onClick={props.onPress}
    >
      <Icon icon={Plus} size="header" className="blq-chip-icon" />
      <span className="blq-chip-text">{props.label}</span>
    </button>
  );
}

/** «Ver 9 servicios» / «Ocultar». */
export function ExpandButton(props: {
  expanded: boolean;
  controls: string;
  children: ReactNode;
  onPress(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="c-textbutton blq-expand"
      data-tone="muted"
      data-size={12}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/**
 * A field showing a value derived from the draft. While focused it keeps what the user types;
 * Enter or leaving the field commits it (`onCommit` returns an error or `null`); Esc puts the
 * derived value back.
 */
export function CommitField(props: {
  value: string;
  label: string;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
  inputMode?: 'text' | 'numeric';
  onCommit(text: string): string | null;
  onError(message: string | null): void;
}): React.JSX.Element {
  const { value, onCommit, onError } = props;
  const [editing, setEditing] = useState<string | null>(null);

  const commit = (text: string): void => {
    if (text.trim() === value.trim()) {
      onError(null);
      return;
    }
    onError(onCommit(text));
  };

  useEscape(
    ESC_PRIORITY.extendOther,
    () => {
      if (editing === null || editing === value) return false;
      setEditing(value);
      onError(null);
      return true;
    },
    editing !== null,
  );

  return (
    <Field
      value={editing ?? value}
      label={props.label}
      placeholder={props.placeholder}
      describedBy={props.describedBy}
      invalid={props.invalid}
      inputMode={props.inputMode}
      onChange={(text) => setEditing(text)}
      onFocus={() => setEditing(value)}
      onBlur={() => {
        if (editing !== null) commit(editing);
        setEditing(null);
      }}
      onKeyDown={(event) => {
        if (!isPlainEnter(event)) return;
        event.preventDefault();
        if (editing !== null) {
          commit(editing);
          setEditing(null);
          event.currentTarget.select();
        }
      }}
    />
  );
}
