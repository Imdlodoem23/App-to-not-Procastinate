/**
 * The mascot (PROMPT §7 «Mascota o árbol», §10 «Progreso» and «Recompensas»), drawn from the
 * brand SVGs in `assets/mascot/` through their CSS mask (`mascotStyle`), never an `<img>`, so
 * its color is a token that follows the theme:
 *
 * - `mascotIcon(stage)`: the 16 px glyph of the Progreso header, a component with the shape of
 *   a lucide icon, so `Section` / `Icon` draw it like any other header icon (the header's color,
 *   red in «números rojos»);
 * - `Mascot`: «la mascota en grande» of Recompensas (96–160 px), green while alive and neutral
 *   once wilted.
 *
 * Both are decorative (`aria-hidden`): the text next to them says the phase.
 */
import type { LucideIcon, LucideProps } from 'lucide-react';
import { forwardRef } from 'react';
import type { MascotStage } from '@centrate/shared/points';
import { mascotStyle } from '../../assets/mascot';
import './mascot.css';

const icons = new Map<MascotStage, LucideIcon>();

/**
 * The header glyph of `stage`. An empty `<svg>` painted `currentColor` through the mascot's
 * mask: it takes `size` and `className` like a lucide icon (stroke props are ignored: the SVG
 * already draws a 1.75 px non-scaling stroke). One stable component per phase.
 */
export function mascotIcon(stage: MascotStage): LucideIcon {
  const cached = icons.get(stage);
  if (cached) return cached;
  const Glyph = forwardRef<SVGSVGElement, LucideProps>(function MascotGlyph(props, ref) {
    const size = props.size ?? 24;
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        className={props.className}
        data-mascot={stage}
        style={mascotStyle(stage, 'icon')}
      />
    );
  });
  Glyph.displayName = `MascotIcon(${stage})`;
  icons.set(stage, Glyph);
  return Glyph;
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
