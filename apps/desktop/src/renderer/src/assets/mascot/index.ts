/**
 * The mascot (PROMPT §7 «Mascota o árbol», docs/brand.md «Mascota»): a potted plant that grows
 * while you focus and wilts if you give up, one SVG per phase of `MASCOT_STAGES`, drawn from
 * the masters in `assets/brand/mascot-*.svg` (brote, planta, árbol, marchita).
 *
 * Two drawings per phase:
 * - `icon`: the Progreso header (16 px, `iconSizes.header`). Stroke 1.75 px at any size
 *   (`vector-effect: non-scaling-stroke`), like lucide's `absoluteStrokeWidth` in `Icon`.
 * - `large`: «la mascota en grande» in Recompensas (96–160 px), stroke 1.25 on the 24 grid.
 *
 * The SVGs hold no colors: they draw in `currentColor` and are painted through a CSS mask
 * (`glyphMask`), so the color is a token resolved in the page and follows light, dark, the
 * theme forced in Ajustes and Windows high contrast. Do not put them in an `<img>`: an image
 * document cannot see the page's CSS variables and would draw them black in both themes.
 *
 * `?url&inline` makes every URL a `data:` URL, in dev and in the build: a mask from a `file:`
 * URL is blocked in the packaged app (CORS), and the CSP allows `img-src data:`.
 */
import type { CSSProperties } from 'react';
import type { MascotStage } from '@centrate/shared/points';
import { cssVar, type ColorToken } from '@centrate/shared/design/tokens';
import sprout from './sprout.svg?url&inline';
import sproutLarge from './sprout-large.svg?url&inline';
import plant from './plant.svg?url&inline';
import plantLarge from './plant-large.svg?url&inline';
import tree from './tree.svg?url&inline';
import treeLarge from './tree-large.svg?url&inline';
import wilted from './wilted.svg?url&inline';
import wiltedLarge from './wilted-large.svg?url&inline';

/** `icon` for the 16 px header, `large` for Recompensas (96–160 px). */
export type MascotSize = 'icon' | 'large';

/** A glyph's color: a token, or `currentColor` to take the surrounding text color. */
export type GlyphTone = ColorToken | 'currentColor';

/** Every mascot SVG as a `data:` URL, by size and phase. */
export const MASCOT_SVGS: Readonly<Record<MascotSize, Readonly<Record<MascotStage, string>>>> =
  Object.freeze({
    icon: Object.freeze({ sprout, plant, tree, wilted }),
    large: Object.freeze({
      sprout: sproutLarge,
      plant: plantLarge,
      tree: treeLarge,
      wilted: wiltedLarge,
    }),
  });

/** URL of the mascot in `stage` (the phase `mascotStage()` returns) at `size`. */
export function mascotStageFor(stage: MascotStage, size: MascotSize = 'icon'): string {
  return MASCOT_SVGS[size][stage];
}

/**
 * The mascot's color (docs/brand.md): in the header, the header's own color like any other
 * icon; in large, `green` while alive and `neutral` (never red) once wilted.
 */
export function mascotTone(stage: MascotStage, size: MascotSize = 'icon'): GlyphTone {
  if (size === 'icon') return 'currentColor';
  return stage === 'wilted' ? 'neutral' : 'green';
}

/**
 * Inline style that paints the mascot in `stage`: give the element a size (16 px in the
 * header, 96–160 px in Recompensas) and `aria-hidden="true"`; the text next to it says the
 * phase.
 */
export function mascotStyle(stage: MascotStage, size: MascotSize = 'icon'): CSSProperties {
  return glyphMask(mascotStageFor(stage, size), mascotTone(stage, size));
}

/**
 * Inline style that paints the SVG at `url` as a one-color glyph in `tone` (the mascot and the
 * achievement badges). Only the SVG's alpha counts. The element needs a width and a height;
 * the glyph is centered and scaled to fit. In Windows high contrast the tokens already map to
 * system colors (tokens.css), so the glyph keeps its color instead of being flattened.
 */
export function glyphMask(url: string, tone: GlyphTone): CSSProperties {
  return {
    maskImage: `url("${url}")`,
    maskPosition: 'center',
    maskRepeat: 'no-repeat',
    maskSize: 'contain',
    backgroundColor: tone === 'currentColor' ? 'currentColor' : cssVar(tone),
    forcedColorAdjust: 'none',
  };
}
