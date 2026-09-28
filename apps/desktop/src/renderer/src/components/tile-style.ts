/**
 * Visual state of a tile (PROMPT §10 «Estilo visual» › Tile), pure. `Tile` turns it into data
 * attributes that `styles/kit.css` draws:
 * - surface: `tile`, or `tile-2` for doors («…») and secondary buttons;
 * - hover/press move the background 4 % / 8 % toward `fg`, except on tiles with an accent
 *   outline (selected or armed keep their resting background, tokens.ts) and disabled ones;
 * - selected: 2 px accent outline, 15 % lighter on top, plus a 12 % accent tint that fades out
 *   over the first 20 % of the height (G-Helper's RButton). Never a solid fill; the text keeps
 *   its color;
 * - armed «¿Seguro?»: the same outline in red, without the tint;
 * - disabled: 45 % opacity, and the help line gives the reason.
 */
import type { Accent } from '@centrate/shared/design/tokens';

export interface TileStateInput {
  selected?: boolean;
  armed?: boolean;
  disabled?: boolean;
  door?: boolean;
  secondary?: boolean;
  /** Accent of the selected outline (default `neutral`: options with no «better» choice). */
  tone?: Accent;
}

export interface TileVisual {
  surface: 'tile' | 'tile-2';
  /** `data-accent` of the tile (outline color), `null` when it has no outline. */
  accent: Accent | null;
  outline: 'selected' | 'armed' | null;
  tint: boolean;
  hover: boolean;
  dim: boolean;
}

export function tileVisual(input: TileStateInput): TileVisual {
  const surface = input.door || input.secondary ? 'tile-2' : 'tile';
  const dim = input.disabled ?? false;
  if (input.armed && !dim) {
    return { surface, accent: 'red', outline: 'armed', tint: false, hover: false, dim };
  }
  if (input.selected) {
    return {
      surface,
      accent: input.tone ?? 'neutral',
      outline: 'selected',
      tint: !dim,
      hover: false,
      dim,
    };
  }
  return { surface, accent: null, outline: null, tint: false, hover: !dim, dim };
}
