import { durationLabel } from '../parser/format';
import type { AchievementId, AchievementMetric } from '../points';
import { formatInteger } from './format';

/** Shared user-visible strings (same shape in every language). */
export interface SharedMessages {
  achievements: {
    /** Name on the Logros grid. */
    titles: Readonly<Record<AchievementId, string>>;
    /** Help line: how to get it, from its metric and threshold. */
    help: (metric: AchievementMetric, threshold: number) => string;
  };
}

/** Spanish shared strings. */
export const SHARED_ES: SharedMessages = {
  achievements: {
    titles: {
      'first-session': 'Primera sesión',
      'first-block': 'Primer bloqueo',
      'streak-7': '7 días de racha',
      'study-10h': '10 h de Study Mode',
      'clean-week': 'Una semana sin intentos',
      'sessions-25': '25 sesiones',
      'streak-30': '30 días de racha',
      'study-50h': '50 h de Study Mode',
    },
    help: (metric: AchievementMetric, threshold: number): string => {
      const n = formatInteger(threshold, 'es');
      switch (metric) {
        case 'completedStudySessions':
          return threshold === 1
            ? 'Termina una sesión de Study Mode'
            : `Termina ${n} sesiones de Study Mode`;
        case 'completedBlocks':
          return threshold === 1
            ? 'Cumple un bloqueo hasta el final'
            : `Cumple ${n} bloqueos hasta el final`;
        case 'bestStreakDays':
          return threshold === 1
            ? 'Cumple tu objetivo diario un día'
            : `Cumple tu objetivo diario ${n} días seguidos`;
        case 'focusMinutesTotal':
          return `Suma ${durationLabel(threshold, 'es')} concentrado en Study Mode`;
        case 'bestCleanDayRun':
          return threshold === 1
            ? 'Pasa un día con actividad y sin ningún intento'
            : `Pasa ${n} días seguidos con actividad y sin ningún intento`;
      }
    },
  },
};
