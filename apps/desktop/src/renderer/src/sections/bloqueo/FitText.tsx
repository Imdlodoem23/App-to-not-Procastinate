/**
 * One-line text that never clips (PROMPT §10 «ni texto cortado»): shows the longest of
 * `candidates` that fits its container (the element it is rendered in, which must hide its
 * overflow on one line, like the section title). Measured before paint in the real font, so
 * Windows' narrower Segoe UI keeps «Bloqueo: YouTube, Instagram · Estricto» while a wider
 * fallback font steps down to «Bloqueo: YouTube +1 · Estricto».
 *
 * If not even the last candidate fits (a huge text scale), `wrap` turns true: the caller lets
 * the line wrap (`SectionHeader`'s `wrap`) instead of cutting «Cosa:» away.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface FitText {
  /** Put it on the element that renders `text` (its parent is the measured box). */
  ref: RefObject<HTMLSpanElement | null>;
  text: string;
  wrap: boolean;
}

export function useFitText(
  candidates: readonly string[],
  /** Anything else that changes the room left (the datum, the pill). */
  fitKey = '',
): FitText {
  const key = `${fitKey}\u0000${candidates.join('\u0000')}`;
  const [fit, setFit] = useState({ key, index: 0, wrap: false });
  const current = fit.key === key ? fit : { key, index: 0, wrap: false };
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || current.wrap || box.scrollWidth <= box.clientWidth + 1) return;
    const last = current.index >= candidates.length - 1;
    setFit({ key, index: last ? current.index : current.index + 1, wrap: last });
  });

  return {
    ref,
    text: candidates[Math.min(current.index, candidates.length - 1)] ?? '',
    wrap: current.wrap,
  };
}
