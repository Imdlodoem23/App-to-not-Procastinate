/**
 * Pills, chips, status dots and bars (PROMPT §10): pills 11/600 with a 4 px radius («Nuevo»,
 * «Números rojos», «● Cámara activa»), chips round (what the parser understood, clickable to
 * correct), 8 px status dots, and linear bars of 3, 4 or 6 px. Color is never the only signal:
 * each goes with text.
 */
import type { ReactNode } from 'react';
import type { Accent } from '@centrate/shared/design/tokens';

export function Pill(props: {
  tone?: Accent;
  children: ReactNode;
  /** Makes it a button («Nuevo» goes back to the field). */
  onPress?: () => void;
  /** `aria-describedby` for a pill button. */
  describedBy?: string;
  className?: string;
}): React.JSX.Element {
  const { tone = 'neutral', children, onPress } = props;
  const className = props.className ? `c-pill ${props.className}` : 'c-pill';
  if (onPress) {
    return (
      <button
        type="button"
        className={className}
        data-accent={tone}
        aria-describedby={props.describedBy}
        onClick={onPress}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={className} data-accent={tone}>
      {children}
    </span>
  );
}

export function Chip(props: {
  label: string;
  /** Leading visual (a service monogram); decorative. */
  leading?: ReactNode;
  /** The chip being corrected in place. */
  selected?: boolean;
  onPress?: () => void;
  describedBy?: string;
  className?: string;
}): React.JSX.Element {
  const { label, leading, selected, onPress } = props;
  const className = props.className ? `c-chip ${props.className}` : 'c-chip';
  const content = (
    <>
      {leading ? (
        <span className="c-chip-leading" aria-hidden="true">
          {leading}
        </span>
      ) : null}
      <span data-fit="">{label}</span>
    </>
  );
  if (onPress) {
    return (
      <button
        type="button"
        className={className}
        data-selected={selected ? '' : undefined}
        aria-pressed={selected}
        aria-describedby={props.describedBy}
        onClick={onPress}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={className} data-selected={selected ? '' : undefined}>
      {content}
    </span>
  );
}

/** 8 px status dot (decorative: the text next to it says the same). */
export function StatusDot(props: { tone: Accent; className?: string }): React.JSX.Element {
  return (
    <span
      className={props.className ? `c-dot ${props.className}` : 'c-dot'}
      data-accent={props.tone}
      aria-hidden="true"
    />
  );
}

/**
 * Linear bar: 3 px (mode bar under the countdown), 4 px (daily goal), 6 px (Study meter).
 * With `label` it is a `progressbar`; without, decorative (the text next to it says it).
 */
export function Bar(props: {
  value: number;
  height: 3 | 4 | 6;
  tone: Accent;
  label?: string;
  /** `aria-valuetext` («42 de 60 min»). */
  valueText?: string;
  className?: string;
}): React.JSX.Element {
  const value = Number.isFinite(props.value) ? Math.min(1, Math.max(0, props.value)) : 0;
  const percent = Math.round(value * 100);
  const a11y = props.label
    ? {
        role: 'progressbar' as const,
        'aria-label': props.label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': percent,
        'aria-valuetext': props.valueText,
      }
    : { 'aria-hidden': true as const };
  return (
    <div
      className={props.className ? `c-bar ${props.className}` : 'c-bar'}
      data-height={props.height}
      data-accent={props.tone}
      {...a11y}
    >
      <div className="c-bar-fill" style={{ transform: `scaleX(${value})` }} />
    </div>
  );
}

/** Alias with the brief's name. */
export const ProgressBar = Bar;
