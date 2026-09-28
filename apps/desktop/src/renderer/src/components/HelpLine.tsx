/**
 * The grey 12 px help line (PROMPT §10): one line, its height always reserved so nothing jumps,
 * bound to its controls with `aria-describedby`. Never clipped: views pick copy that fits
 * (`data-fit` lets the e2e layout check catch overflow). No tooltips anywhere.
 */
import type { ReactNode } from 'react';
import type { HelpTone } from './tones';

export type { HelpTone } from './tones';

export function HelpLine(props: {
  id?: string;
  tone?: HelpTone;
  /** `polite` for results that appear after an action (errors, «Hecho»). */
  live?: 'polite' | 'off';
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const { id, tone = 'muted', live, className, children } = props;
  return (
    <div
      id={id}
      className={className ? `c-help ${className}` : 'c-help'}
      data-tone={tone}
      data-fit=""
      aria-live={live}
    >
      {children}
    </div>
  );
}
