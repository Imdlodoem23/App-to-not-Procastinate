/**
 * Text fields: `tile` background, 1 px `control` border, 6 px radius. The main field
 * «¿Qué quieres hacer?» is 44 px with 15 px text; the others 32 px with 13 px. The accessible
 * name is `label` (placeholders are examples, not labels).
 */
import type { InputHTMLAttributes, Ref } from 'react';

export interface FieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'onChange' | 'value' | 'ref'
> {
  value: string;
  onChange(value: string): void;
  label: string;
  size?: 'main' | 'normal';
  /** Marks the field invalid (red border) and names the message element. */
  invalid?: boolean;
  describedBy?: string;
  ref?: Ref<HTMLInputElement>;
}

export function Field(props: FieldProps): React.JSX.Element {
  const {
    value,
    onChange,
    label,
    size = 'normal',
    invalid,
    describedBy,
    className,
    ref,
    type = 'text',
    ...rest
  } = props;
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      value={value}
      aria-label={label}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      autoComplete="off"
      spellCheck={false}
      className={className ? `c-field ${className}` : 'c-field'}
      data-size={size}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
