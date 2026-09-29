/**
 * A section of a window (PROMPT §10 «El título es el estado»): a `<section>` named by its title,
 * starting with a 20 px header: 16 px icon, «Cosa: valor» in 13/600 and, right-aligned in
 * normal weight, a live datum («hasta 17:42»). No cards, no separators: sections are stacked
 * with air between them. A section that does not star in the current state folds to its
 * header (no children).
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type TextTone = 'default' | 'muted' | 'red' | 'orange' | 'green' | 'blue';

export interface SectionHeaderProps {
  /** Section id: the title gets `${id}-title`. */
  id: string;
  icon: LucideIcon;
  title: ReactNode;
  /** Colors the icon and the title («Nivel 3 · −340 puntos» in red). */
  titleTone?: TextTone;
  /** Right-aligned live datum. */
  datum?: ReactNode;
  datumTone?: TextTone;
  /** Pill right after the title («Nuevo», «Números rojos», «● Cámara activa»). */
  pill?: ReactNode;
  /** Let a long title wrap instead of staying on one line (warnings only). */
  wrap?: boolean;
}

export function SectionHeader(props: SectionHeaderProps): React.JSX.Element {
  const {
    id,
    icon,
    title,
    titleTone = 'default',
    datum,
    datumTone = 'default',
    pill,
    wrap,
  } = props;
  return (
    <div className="c-section-header" data-wrap={wrap ? '' : undefined}>
      <span className="c-section-icon" data-tone={titleTone}>
        <Icon icon={icon} size="header" />
      </span>
      <h2 id={`${id}-title`} className="c-section-title" data-tone={titleTone} data-fit="">
        {title}
      </h2>
      {pill}
      {datum !== undefined && datum !== null && datum !== '' ? (
        <span className="c-section-datum" data-tone={datumTone} data-fit="">
          {datum}
        </span>
      ) : null}
    </div>
  );
}

export interface SectionProps extends SectionHeaderProps {
  children?: ReactNode;
  className?: string;
  /** `aria-describedby` of the section root (read when a door focuses it). */
  describedBy?: string;
}

/**
 * `data-section={id}` and `tabIndex={-1}` let the shell focus the section root when a block
 * hides «¿Qué quieres hacer?».
 */
export function Section(props: SectionProps): React.JSX.Element {
  const { children, className, describedBy, ...header } = props;
  return (
    <section
      aria-labelledby={`${header.id}-title`}
      aria-describedby={describedBy}
      data-section={header.id}
      tabIndex={-1}
      className={className ? `c-section ${className}` : 'c-section'}
    >
      <SectionHeader {...header} />
      {children}
    </section>
  );
}
