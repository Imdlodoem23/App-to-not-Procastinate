/**
 * A row of chips (PROMPT §10): services with their catalog icon (`ServiceIcon`: the monogram,
 * or a favicon once the catalog has them), categories and the rest with a lucide glyph; a click
 * corrects the chip (typing: selects that part of the phrase; card: edits it in place).
 */
import { Chip, Icon, ServiceIcon } from '../../components';
import type { ChipView } from './chips';
import { chipIcon } from './icons';

function ChipLeading(props: { chip: ChipView }): React.JSX.Element | null {
  const { chip } = props;
  if (chip.kind === 'service') {
    return (
      <ServiceIcon className="bq-monogram" monogram={chip.monogram ?? chip.label.slice(0, 1)} />
    );
  }
  const glyph = chipIcon(chip.kind, chip.categoryId);
  return glyph ? <Icon icon={glyph} size="header" /> : null;
}

export function ChipList(props: {
  chips: readonly ChipView[];
  /** One line (the help line under the field): never wraps. */
  line?: boolean;
  label?: string;
  describedBy?: string;
  /** `null`: the chips are not pressable. */
  onPress?: ((chip: ChipView) => void) | null;
  pressable?: (chip: ChipView) => boolean;
}): React.JSX.Element {
  const { chips, line, onPress, pressable } = props;
  return (
    <div
      className="bq-chips"
      data-line={line ? '' : undefined}
      role="group"
      aria-label={props.label}
    >
      {chips.map((chip) => {
        const canPress = Boolean(onPress) && (pressable ? pressable(chip) : true);
        return (
          <Chip
            key={chip.key}
            label={chip.label}
            leading={<ChipLeading chip={chip} />}
            describedBy={canPress ? props.describedBy : undefined}
            onPress={canPress && onPress ? () => onPress(chip) : undefined}
          />
        );
      })}
    </div>
  );
}
