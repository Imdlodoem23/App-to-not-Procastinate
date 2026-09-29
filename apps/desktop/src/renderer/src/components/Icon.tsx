/**
 * lucide-react icons the one way the app draws them: `currentColor`, stroke 1.75 px at every
 * size (absolute), 16 px in headers and the footer, 20 px in tiles, 24 px in empty states.
 * Decorative: every control carries text, so icons are hidden from assistive technology.
 */
import type { LucideIcon } from 'lucide-react';
import { iconSizes, iconStroke } from '@centrate/shared/design/tokens';

export type IconSize = keyof typeof iconSizes;

export function Icon(props: {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
}): React.JSX.Element {
  const { icon: Glyph, size = 'header', className } = props;
  return (
    <Glyph
      size={iconSizes[size]}
      strokeWidth={iconStroke}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
      className={className ? `c-icon ${className}` : 'c-icon'}
    />
  );
}
