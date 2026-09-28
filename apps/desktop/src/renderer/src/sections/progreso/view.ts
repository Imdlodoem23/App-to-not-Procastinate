/**
 * Section 4 «Progreso» (PROMPT §10), pure. Header: the mascot in its phase as the icon
 * (`snapshot.progress.mascot`, main's reading of the event log), «Nivel 7 · 1.240 puntos» and,
 * on the right, «Racha: 5 días»; a negative balance turns the title red and adds the «Números
 * rojos» pill (a fact, no blame). Under it, the 4 px daily goal bar «Hoy: 42 de 60 min», then
 * the 40 px doors Estadísticas… | Recompensas… | Logros…, each with its flag (`stats`,
 * `rewards`, `achievements`), its Alt + letter and a help line that says what is behind it
 * («3 de 8 conseguidos…», «Cerradas mientras dure el castigo»). Points are never editable.
 *
 * Without guardian data (never reached) there is nothing true to show: the section hides.
 */
import { achievementText } from '@centrate/shared/i18n';
import type { AchievementId, MascotStage } from '@centrate/shared/points';
import { featureEnabled } from '../../../../shared/features';
import { formatInt, formatPoints } from '../../../../shared/format';
import { activeLocale } from '../../../../shared/i18n/locale';
import {
  defaultDetailRequest,
  type DetailName,
  type DetailRequest,
} from '../../../../shared/ui-state';
import type { UiSnapshot } from '../../../../shared/ui-state';
import { mascotStageOf } from '../../components/mascot/stage';
import { RENDERER } from '../../i18n/messages';
import { PROGRESO } from './i18n';

/** The mascot's phase: `MASCOT_STAGES` of points.ts (brote, planta, árbol, marchita). */
export type MascotPhase = MascotStage;

/** Progreso's doors, each shown only with its feature flag (and guardian capability). */
export type ProgresoDoor = 'stats' | 'rewards' | 'achievements';

/** The detail view each door opens. */
export const PROGRESO_DOOR_VIEWS: Readonly<Record<ProgresoDoor, DetailName>> = {
  stats: 'estadisticas',
  rewards: 'recompensas',
  achievements: 'logros',
};

/** Id of the doors' row (help focus `{row, item}`, `${id}-help`). */
export const PROGRESO_DOORS_ROW = 'progreso-puertas';

export interface ProgresoDoorView {
  id: ProgresoDoor;
  /** «Estadísticas…», «Recompensas…», «Logros…». */
  label: string;
  help: string;
  /** Alt + this letter opens it. */
  mnemonic: string;
  /** What `window:open-detail` receives. */
  request: DetailRequest;
}

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
  /** 40 px door tiles (Estadísticas… | Recompensas… | Logros…) with their flags. */
  doors: ProgresoDoorView[];
}

const DOORS: readonly ProgresoDoor[] = ['stats', 'rewards', 'achievements'];

const G = RENDERER.progreso;

/**
 * The doors' Alt + letters in the active language. Section 2 must never take them: they are
 * part of the letters the main window's shell reserves (docs/DESKTOP.md §7.4).
 */
export function progresoMnemonics(): string[] {
  return DOORS.map((door) => PROGRESO.mnemonics[door]);
}

function achievementTitle(id: AchievementId): string {
  return achievementText(id, activeLocale())?.title ?? id;
}

function doorHelp(door: ProgresoDoor, snapshot: UiSnapshot): string {
  if (door === 'rewards') {
    const lock = snapshot.state?.rewardsLock ?? null;
    return lock ? PROGRESO.rewardsLocked[lock] : G.doorsHelp.rewards;
  }
  if (door === 'achievements') {
    const progress = snapshot.progress;
    if (!progress) return G.doorsHelp.achievements;
    const [first] = progress.fresh;
    if (progress.fresh.length === 1 && first) {
      return PROGRESO.achievementsFresh(achievementTitle(first));
    }
    if (progress.fresh.length > 1) {
      return PROGRESO.achievementsFreshMany(formatInt(progress.fresh.length));
    }
    return PROGRESO.achievementsCount(formatInt(progress.achieved), formatInt(progress.total));
  }
  return G.doorsHelp.stats;
}

function doorRequest(door: ProgresoDoor, snapshot: UiSnapshot): DetailRequest {
  const request = defaultDetailRequest(PROGRESO_DOOR_VIEWS[door]);
  // A new achievement: Logros opens on it.
  const [fresh] = snapshot.progress?.fresh ?? [];
  if (request.name === 'logros' && fresh) return { ...request, focus: fresh };
  return request;
}

export function deriveProgresoView(snapshot: UiSnapshot): ProgresoView | null {
  const points = snapshot.state?.points;
  const phase = mascotStageOf(snapshot);
  if (!points || !phase) return null;
  const negative = points.balance < 0;
  const { focusMinutes, goalMinutes, goalMet } = points.today;
  const focus = formatInt(Math.max(0, focusMinutes));
  const goal = formatInt(Math.max(0, goalMinutes));
  const capabilities = snapshot.health?.capabilities ?? null;
  return {
    phase,
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
    doors: DOORS.filter((door) => featureEnabled(snapshot.features, door, capabilities)).map(
      (door) => ({
        id: door,
        label: G.doors[door],
        help: doorHelp(door, snapshot),
        mnemonic: PROGRESO.mnemonics[door],
        request: doorRequest(door, snapshot),
      }),
    ),
  };
}
