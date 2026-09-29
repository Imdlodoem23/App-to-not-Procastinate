/**
 * The UI kit (docs/DESKTOP.md §7.3): G-Helper's organisation with Céntrate's tokens. No cards,
 * shadows, gradients (except the selected tint) or icon-only controls; the confirm button is the
 * only solid fill. Section 2 and the detail windows build on these; they do not build parallel
 * versions.
 */
export { Icon, type IconSize } from './Icon';
export {
  Section,
  SectionHeader,
  type SectionProps,
  type SectionHeaderProps,
  type TextTone,
} from './Section';
export { TileRow, useRowContext, type TileRowProps } from './TileRow';
export { Tile, DoorTile, MnemonicLabel, type TileProps, type TileSize } from './Tile';
export { InPlaceConfirm, type InPlaceConfirmProps } from './InPlaceConfirm';
export { ConfirmButton, type ConfirmButtonProps } from './ConfirmButton';
export { HelpLine, type HelpTone } from './HelpLine';
export { Pill, Chip, StatusDot, Bar, ProgressBar } from './Pill';
export { Countdown } from './Countdown';
export { ServiceIcon, NEUTRAL_SERVICE_ICONS } from './ServiceIcon';
export { Field, type FieldProps } from './Field';
export {
  Segmented,
  SettingsRow,
  settingsRowIds,
  Toggle,
  Checkbox,
  TextButton,
  EmptyState,
  type SegmentedOption,
} from './controls';
export { tileVisual, type TileVisual, type TileStateInput } from './tile-style';
