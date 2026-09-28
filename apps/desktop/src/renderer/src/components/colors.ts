/**
 * TypeScript mirror of the color mixes `styles/kit.css` computes with `color-mix()` beyond the
 * ones `tokens.css` already names (tile hover and press). Pure; vitest checks their contrast.
 *
 * The filled confirm button («Bloquear hasta 17:42», the one exception to «never a solid
 * fill») moves 4 % toward `fg` on hover and 8 % when pressed, like tiles:
 * `color-mix(in srgb, var(--fg) var(--hover-mix), var(--blue))`.
 */
import {
  colors,
  composite,
  interaction,
  mix,
  withAlpha,
  type Accent,
  type ThemeName,
} from '@centrate/shared/design/tokens';

export interface ConfirmButtonColors {
  rest: string;
  hover: string;
  active: string;
  text: string;
}

export function confirmButtonColors(theme: ThemeName): ConfirmButtonColors {
  const c = colors[theme];
  return {
    rest: c.blue,
    hover: mix(c.blue, c.fg, interaction.hoverMix),
    active: mix(c.blue, c.fg, interaction.activeMix),
    text: c.onAccent,
  };
}

/**
 * The top of a selected tile, where its 12 % accent tint is strongest: the label (always `fg`)
 * must keep 4.5:1 over it.
 */
export function selectedTileTop(theme: ThemeName, accent: Accent): string {
  const c = colors[theme];
  return composite(withAlpha(c[accent], interaction.selectedTint), c.tile);
}
