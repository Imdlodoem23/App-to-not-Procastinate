/**
 * Section 4 «Progreso» (PROMPT §10), pure. Header: the mascot in its phase as the icon,
 * «Nivel 7 · 1.240 puntos» and, on the right, «Racha: 5 días»; a negative balance turns the
 * title red and adds the «Números rojos» pill (a fact, no blame). Under it, the 4 px daily goal
 * bar «Hoy: 42 de 60 min». Points are never editable. The Estadísticas… / Recompensas… /
 * Logros… doors join with their flags (`stats`, `rewards`, `achievements`).
 *
 * Without guardian data (never reached) there is nothing true to show: the section hides.
 */
import type { PointsSummary } from '@centrate/shared/domain';
import { featureEnabled } from '../../../../shared/features';
import { formatInt, formatPoints } from '../../../../shared/format';
import type { UiSnapshot } from '../../../../shared/ui-state';
import { RENDERER } from '../../i18n/messages';

/** The mascot's phase (placeholder icons until the rewards flag brings the real mascot). */
export type MascotPhase = 'sprout' | 'plant' | 'tree' | 'wilted';

/** Progreso's doors, each shown only with its feature flag (and guardian capability). */
export type ProgresoDoor = 'stats' | 'rewards' | 'achievements';

export interface ProgresoView {
  phase: MascotPhase;
  title: string;
  negative: boolean;
  /** «Números rojos» or `null`. */
  pill: string | null;
  streak: string;
  goal: {
    /** «Hoy: 42 de 60 min». */
    label: string;
    /** Bar fill, 0..1. */
    value: number;
    met: boolean;
    /** Accessible name of the bar. */
    aria: string;
  };
  /** 40 px door tiles (Estadísticas… | Recompensas… | Logros…); empty in Phase 1. */
  doors: ProgresoDoor[];
}

const DOORS: readonly ProgresoDoor[] = ['stats', 'rewards', 'achievements'];

const G = RENDERER.progreso;

/**
 * Wilted in «números rojos» (you gave up more than you earned); otherwise it grows with the
 * level: a sprout up to level 2, a plant up to 5, a tree from 6.
 */
export function mascotPhase(points: Pick<PointsSummary, 'balance' | 'level'>): MascotPhase {
  if (points.balance < 0) return 'wilted';
  if (points.level <= 2) return 'sprout';
  if (points.level <= 5) return 'plant';
  return 'tree';
}

export function deriveProgresoView(snapshot: UiSnapshot): ProgresoView | null {
  const points = snapshot.state?.points;
  if (!points) return null;
  const negative = points.balance < 0;
  const { focusMinutes, goalMinutes, goalMet } = points.today;
  const focus = formatInt(Math.max(0, focusMinutes));
  const goal = formatInt(Math.max(0, goalMinutes));
  return {
    phase: mascotPhase(points),
    title: G.title(formatInt(points.level), formatPoints(points.balance)),
    negative,
    pill: negative ? G.negative : null,
    streak: G.streak(points.streakDays, formatInt(points.streakDays)),
    goal: {
      label: G.goal(focus, goal),
      value:
        goalMinutes > 0 ? Math.min(1, Math.max(0, focusMinutes / goalMinutes)) : goalMet ? 1 : 0,
      met: goalMet || (goalMinutes > 0 && focusMinutes >= goalMinutes),
      aria: G.goalAria(focus, goal),
    },
    doors: DOORS.filter((door) =>
      featureEnabled(snapshot.features, door, snapshot.health?.capabilities ?? null),
    ),
  };
}
