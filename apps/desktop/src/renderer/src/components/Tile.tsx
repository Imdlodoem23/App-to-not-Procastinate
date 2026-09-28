/**
 * A tile (PROMPT §10 «Estilo visual» › Tile): `tile` background, 1 px `border`, 6 px radius, a
 * 20 px icon over a 13 px label. Heights: 56 px (`regular`; 40 px in compact density, icon left
 * of the label), 40 px (`door`: Progreso's doors), 32 px (`text`: text-only tiles and the
 * footer's secondary buttons, 16 px icon on the left).
 *
 * States (see `tile-style.ts`): hover/press, selected (accent outline + fading tint, never a
 * solid fill), armed «¿Seguro? …» (red outline), disabled (45 %, still focusable so the help
 * line can say why), door (`tile-2` and a label ending in «…»). Every tile has a text label;
 * `mnemonic` makes Alt + that letter press it.
 *
 * Inside a `TileRow` it reports its help to the row's help line on hover and focus, and is a
 * radio when the row is a radiogroup. Outside a row, `describedBy` names the element that shows
 * its help (a `SettingsRow` description, a card's help line), where the owner renders the
 * disabled reason or the armed consequence; without one, the tile's current help text is its
 * `aria-description`, so a reason or a «¿Seguro?» consequence is never silent.
 */
import type { LucideIcon } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, type Ref } from 'react';
import type { Accent } from '@centrate/shared/design/tokens';
import { useMnemonic } from '../hooks/useKeys';
import { RENDERER } from '../i18n/messages';
import { Icon } from './Icon';
import { splitMnemonic } from './mnemonic';
import { tileDescription, tileHelpText, tileVisual } from './tile-style';
import { useRowContext } from './TileRow';

export type TileSize = 'regular' | 'door' | 'text';

export interface TileProps {
  /** Unique within its row (help focus `{row, item}`). */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Help line text while hovered or focused. */
  help?: string;
  /** Accent of the selected outline (`neutral` by default). */
  tone?: Accent;
  selected?: boolean;
  /** Opens something instead of applying: `tile-2` background, label ends in «…». */
  door?: boolean;
  /** Secondary button (footer): `tile-2` background, no «…». */
  secondary?: boolean;
  disabled?: boolean;
  /** Shown on the help line while the disabled tile is hovered or focused. */
  disabledReason?: string;
  /** In-place «¿Seguro? …» (see `InPlaceConfirm`). */
  armed?: boolean;
  /** The consequence shown in red on the help line while armed. */
  armedHelp?: string;
  /**
   * Id of the element that describes this tile outside a `TileRow` (its owner shows the help,
   * the disabled reason or the armed consequence there). Inside a row, the row's help line.
   */
  describedBy?: string;
  /** Alt + this letter presses the tile (unique among visible tiles). */
  mnemonic?: string;
  size?: TileSize;
  /** `detail` is the click count (0 from the keyboard). */
  onPress?: (info: { detail: number }) => void;
  onMouseLeave?: () => void;
  onBlur?: () => void;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

export function MnemonicLabel(props: { label: string; mnemonic?: string }): React.JSX.Element {
  const split = splitMnemonic(props.label, props.mnemonic);
  if (!split) return <>{props.label}</>;
  return (
    <>
      {split.before}
      <span className="c-mnemonic">{split.key}</span>
      {split.after}
    </>
  );
}

export function Tile(props: TileProps): React.JSX.Element {
  const {
    id,
    label,
    icon,
    help,
    tone,
    selected,
    door,
    secondary,
    disabled = false,
    disabledReason,
    armed = false,
    armedHelp,
    describedBy,
    mnemonic,
    size = 'regular',
    onPress,
    ref,
  } = props;
  const row = useRowContext();
  const element = useRef<HTMLButtonElement | null>(null);
  const visual = tileVisual({ selected, armed, disabled, door, secondary, tone });

  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      element.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  // Report the current help text to the row (after every render, before paint).
  const registry = row?.registry ?? null;
  const helpText = tileHelpText({ help, disabled, disabledReason, armed, armedHelp });
  useLayoutEffect(() => {
    if (!registry) return;
    registry.set(id, { text: helpText, tone: armed ? 'red' : 'muted', armed });
  });
  const description = tileDescription(row?.helpId ?? null, describedBy, helpText);
  useLayoutEffect(() => {
    if (!registry) return undefined;
    return () => registry.delete(id);
  }, [registry, id]);

  useMnemonic(
    mnemonic,
    () => {
      const el = element.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.click();
    },
    !disabled,
  );

  const focusedItemInRow = (): string | null => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !row) return null;
    return active.dataset['rowTile'] === row.rowId ? (active.dataset['tileId'] ?? null) : null;
  };

  let text = door ? RENDERER.kit.door(label) : label;
  if (armed) text = RENDERER.kit.armed(text);
  const radio = row?.kind === 'radiogroup';

  return (
    <button
      ref={setRef}
      type="button"
      className={props.className ? `c-tile ${props.className}` : 'c-tile'}
      data-size={size}
      data-surface={visual.surface}
      data-accent={visual.accent ?? undefined}
      data-outline={visual.outline ?? undefined}
      data-tint={visual.tint ? '' : undefined}
      data-hover={visual.hover ? '' : undefined}
      data-dim={visual.dim ? '' : undefined}
      data-row-tile={row?.rowId}
      data-tile-id={id}
      role={radio ? 'radio' : undefined}
      aria-checked={radio ? Boolean(selected) : undefined}
      aria-pressed={!radio && selected !== undefined ? selected : undefined}
      aria-disabled={disabled ? true : undefined}
      aria-describedby={description.describedBy}
      aria-description={description.text}
      aria-keyshortcuts={mnemonic ? `Alt+${mnemonic.toUpperCase()}` : undefined}
      onClick={(event) => {
        if (disabled) return;
        onPress?.({ detail: event.detail });
      }}
      onMouseEnter={() => row?.help.enter(id)}
      onMouseLeave={() => {
        row?.help.leave(id, focusedItemInRow());
        props.onMouseLeave?.();
      }}
      onFocus={() => row?.help.enter(id)}
      onBlur={() => {
        row?.help.leave(id);
        props.onBlur?.();
      }}
    >
      {icon && size !== 'text' ? <Icon icon={icon} size="tile" /> : null}
      {icon && size === 'text' ? <Icon icon={icon} size="header" /> : null}
      <span className="c-tile-label" data-fit="">
        <MnemonicLabel label={text} mnemonic={mnemonic} />
      </span>
    </button>
  );
}

/** The last tile of a row that opens something: `tile-2` background, label ending in «…». */
export function DoorTile(props: Omit<TileProps, 'door' | 'selected' | 'tone'>): React.JSX.Element {
  return <Tile {...props} door />;
}
