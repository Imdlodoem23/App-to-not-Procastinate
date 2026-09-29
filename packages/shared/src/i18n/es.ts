import { dailyLabel, daysLabel, durationLabel } from '../parser/format';
import type { AchievementId, AchievementMetric } from '../points';
import { formatInteger } from './format';
import type { Locale } from './locale';

/** Shared user-visible strings (same shape in every language). */
export interface SharedMessages {
  achievements: {
    /** Name on the Logros grid. */
    titles: Readonly<Record<AchievementId, string>>;
    /** Help line: how to get it, from its metric and threshold. */
    help: (metric: AchievementMetric, threshold: number) => string;
  };
  /**
   * Daily limits («YouTube máximo 30 minutos al día»), for every surface that shows one:
   * the confirmation card, the Bloqueos window, notifications and the extension's blocked
   * page. `name` is the limit's name («YouTube», «Redes sociales»); minutes are whole.
   */
  dailyLimits: {
    /** Kind of the confirmation card and of a limit block: «Límite diario». */
    title: string;
    /** Section of the Bloqueos window: «Límites diarios». */
    sectionTitle: string;
    /** «30 min al día», «1 h 30 min al día». */
    perDay: (dailyMinutes: number) => string;
    /** «todos los días», «entre semana», «fines de semana», «de lunes a jueves». */
    days: (days: readonly number[]) => string;
    /** Progress of today: «12 de 30 min hoy», «1 h 10 min de 2 h hoy». */
    usedToday: (usedMinutes: number, dailyMinutes: number) => string;
    /** State of a limit already used up today: «Bloqueado hasta mañana». */
    blockedUntilTomorrow: string;
    /** Warning notification: «Te quedan 5 min de YouTube hoy». */
    warning: (name: string, minutesLeft: number) => string;
    /** Notification when it runs out: «Has gastado tus 30 min de YouTube de hoy». */
    reached: (name: string, dailyMinutes: number) => string;
    /** Extension blocked page: «Has usado tus 30 min de YouTube de hoy. Vuelve mañana.». */
    blockedPage: (name: string, dailyMinutes: number) => string;
    /**
     * Main window card of a limit block: «Límite diario de YouTube: bloqueado hasta las
     * 0:00». `time` is the end, already formatted for the locale.
     */
    blockCard: (name: string, time: string) => string;
  };
}

/**
 * «12 de 30 min», «1 h 10 min de 2 h» (the unit once when both are under an hour); `of` is
 * the language's «de». Used by `es.ts` and `en.ts`.
 */
export function usedOfLabel(used: number, total: number, locale: Locale, of: string): string {
  const whole = Math.max(0, Math.floor(used));
  if (total < 60 && whole < 60) return `${whole} ${of} ${durationLabel(total, locale)}`;
  return `${durationLabel(whole, locale)} ${of} ${durationLabel(total, locale)}`;
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
  dailyLimits: {
    title: 'Límite diario',
    sectionTitle: 'Límites diarios',
    perDay: (dailyMinutes: number): string => dailyLabel(dailyMinutes, 'es'),
    days: (days: readonly number[]): string => daysLabel(days, 'es'),
    usedToday: (usedMinutes: number, dailyMinutes: number): string =>
      `${usedOfLabel(usedMinutes, dailyMinutes, 'es', 'de')} hoy`,
    blockedUntilTomorrow: 'Bloqueado hasta mañana',
    warning: (name: string, minutesLeft: number): string =>
      `Te quedan ${durationLabel(minutesLeft, 'es')} de ${name} hoy`,
    reached: (name: string, dailyMinutes: number): string =>
      `Has gastado tus ${durationLabel(dailyMinutes, 'es')} de ${name} de hoy`,
    blockedPage: (name: string, dailyMinutes: number): string =>
      `Has usado tus ${durationLabel(dailyMinutes, 'es')} de ${name} de hoy. Vuelve mañana.`,
    blockCard: (name: string, time: string): string =>
      `Límite diario de ${name}: bloqueado hasta las ${time}`,
  },
};
