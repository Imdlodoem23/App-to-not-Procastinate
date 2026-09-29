/**
 * The mascot (PROMPT §7 «Mascota o árbol», §10 «Progreso» and «Recompensas»), drawn from the
 * brand SVGs in `assets/mascot/` through their CSS mask (`mascotStyle`), never an `<img>`, so
 * its color is a token that follows the theme:
 *
 * - `mascotIcon(stage)`: the 16 px glyph of the Progreso header (`maskGlyph`), a component with the shape of
 *   a lucide icon, so `Section` / `Icon` draw it like any other header icon (the header's color,
 *   red in «números rojos»);
 * - `Mascot`: «la mascota en grande» of Recompensas (96–160 px), green while alive and neutral
 *   once wilted.
 *
 * Both are decorative (`aria-hidden`): the text next to them says the phase.
 */
import type { LucideIcon, LucideProps } from 'lucide-react';
import { forwardRef, type CSSProperties } from 'react';
import type { MascotStage } from '@centrate/shared/points';
import { mascotStyle } from '../../assets/mascot';
import './mascot.css';

const glyphs = new Map<string, LucideIcon>();

/**
 * A one-color glyph painted through a CSS mask (`glyphMask`: the mascot, the achievement
 * badges) as a component with the shape of a lucide icon, so `Icon`, `Section` and `Tile` draw
 * it like any other icon: an empty `<svg>` of `size` px (CSS may size it too) with `className`.
 * Stroke props are ignored (the SVGs already draw a 1.75 px non-scaling stroke). One stable
 * component per `key`, which the element also carries as `data-glyph`.
 */
export function maskGlyph(key: string, style: CSSProperties): LucideIcon {
  const cached = glyphs.get(key);
  if (cached) return cached;
  const Glyph = forwardRef<SVGSVGElement, LucideProps>(function MaskGlyph(props, ref) {
    const size = props.size ?? 24;
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        className={props.className}
        data-glyph={key}
        style={style}
      />
    );
  });
  Glyph.displayName = `MaskGlyph(${key})`;
  glyphs.set(key, Glyph);
  return Glyph;
}

/** The header glyph of `stage` (the header's own color, like any other header icon). */
export function mascotIcon(stage: MascotStage): LucideIcon {
  return maskGlyph(`mascot:${stage}`, mascotStyle(stage, 'icon'));
}

/** The mascot in large (Recompensas): give it a `size` in CSS px. */
export function Mascot(props: {
  stage: MascotStage;
  size: number;
  className?: string;
}): React.JSX.Element {
  const { stage, size } = props;
  return (
    <span
      className={props.className ? `c-mascot ${props.className}` : 'c-mascot'}
      aria-hidden="true"
      data-mascot={stage}
      style={{ width: size, height: size, ...mascotStyle(stage, 'large') }}
    />
  );
}
