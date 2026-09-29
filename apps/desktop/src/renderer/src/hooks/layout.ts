/**
 * «Alto automático» decision (PROMPT §10, docs/DESKTOP.md §7.4), pure. The main window reports
 * its content height; main fits the window to it from the anchored edge. Regular density is
 * always tried first (so no hysteresis is needed), then compact (40 px tiles with the icon on
 * the left, 40 px countdown, 8 px between sections), and only below the screenshot matrix the
 * section column scrolls (never the footer).
 */
import type { Density } from '@centrate/shared/design/tokens';
import type { LayoutReport } from '../../../shared/ui-state';

export function chooseLayout(measure: (density: Density) => number, max: number): LayoutReport {
  const budget = Math.max(1, Math.floor(max));
  const regular = Math.max(1, Math.ceil(measure('regular')));
  if (regular <= budget) return { height: regular, density: 'regular', scroll: false };
  const compact = Math.max(1, Math.ceil(measure('compact')));
  if (compact <= budget) return { height: compact, density: 'compact', scroll: false };
  return { height: budget, density: 'compact', scroll: true };
}

export function sameLayout(a: LayoutReport | null, b: LayoutReport | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.height === b.height &&
      a.density === b.density &&
      a.scroll === b.scroll)
  );
}
