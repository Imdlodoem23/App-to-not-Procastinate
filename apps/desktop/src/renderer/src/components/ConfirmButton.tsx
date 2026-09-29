/**
 * The one filled control (PROMPT §10 «Única excepción de relleno»): the button that confirms
 * («Bloquear hasta 17:42», «Sí, bloquear 6 h», «Empezar»), in `blue` with `on-accent` text
 * (#111 in dark, white in light). Disabled at 45 % (the consequence step keeps it disabled 2 s).
 * Focus ring offset 2 px so it sits on the background, not on the blue.
 */
import { useRef, type Ref } from 'react';
import { useMnemonic } from '../hooks/useKeys';
import { MnemonicLabel } from './Tile';

export interface ConfirmButtonProps {
  label: string;
  disabled?: boolean;
  /** 40 px by default (a card row); `text` 32 px, `regular` follows the tile height. */
  size?: 'regular' | 'door' | 'text';
  mnemonic?: string;
  /** `aria-describedby` (the card's help line). */
  describedBy?: string;
  onPress(): void;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

export function ConfirmButton(props: ConfirmButtonProps): React.JSX.Element {
  const { label, disabled = false, size = 'door', mnemonic, describedBy, onPress, ref } = props;
  const element = useRef<HTMLButtonElement | null>(null);
  useMnemonic(
    mnemonic,
    () => {
      element.current?.focus({ preventScroll: true });
      element.current?.click();
    },
    !disabled,
  );
  return (
    <button
      ref={(node) => {
        element.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      type="button"
      className={props.className ? `c-confirm ${props.className}` : 'c-confirm'}
      data-size={size}
      aria-disabled={disabled ? true : undefined}
      aria-describedby={describedBy}
      aria-keyshortcuts={mnemonic ? `Alt+${mnemonic.toUpperCase()}` : undefined}
      onClick={() => {
        if (!disabled) onPress();
      }}
    >
      <span className="c-tile-label" data-fit="">
        <MnemonicLabel label={label} mnemonic={mnemonic} />
      </span>
    </button>
  );
}
