/**
 * One-line text that never clips (PROMPT §10 «ni texto cortado»): shows the longest of
 * `candidates` that fits its container (the element it is rendered in, which must hide its
 * overflow on one line, like the section title). Measured before paint in the real font, so
 * Windows' narrower Segoe UI keeps «Bloqueo: YouTube, Instagram · Estricto» while a wider
 * fallback font steps down to «Bloqueo: YouTube +1 · Estricto».
 */
import { useLayoutEffect, useRef, useState } from 'react';

export function FitText(props: {
  candidates: readonly string[];
  /** Anything else that changes the room left (the datum, the pill). */
  fitKey?: string;
}): React.JSX.Element {
  const { candidates } = props;
  const key = `${props.fitKey ?? ''}\u0000${candidates.join('\u0000')}`;
  const [fit, setFit] = useState({ key, index: 0 });
  const index = fit.key === key ? fit.index : 0;
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box || index >= candidates.length - 1) return;
    if (box.scrollWidth > box.clientWidth + 1) setFit({ key, index: index + 1 });
  });

  return <span ref={ref}>{candidates[Math.min(index, candidates.length - 1)] ?? ''}</span>;
}
