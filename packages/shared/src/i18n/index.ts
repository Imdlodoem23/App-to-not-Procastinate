import { ACHIEVEMENTS } from '../points';
import { SHARED_EN } from './en';
import { SHARED_ES, type SharedMessages } from './es';
import { DEFAULT_LOCALE, toLocale, type Locale } from './locale';

export type { Locale } from './locale';
export {
  DEFAULT_LOCALE,
  LOCALES,
  intlTag,
  isLocale,
  localeFromLanguage,
  localeFromLanguages,
  toLocale,
} from './locale';
export type { LanguageTags } from './format';
export { MINUS, formatClock, formatDayMonth, formatInteger, formatSignedInteger } from './format';
export type { SharedMessages } from './es';
export { SHARED_EN } from './en';
export { SHARED_ES } from './es';

/** Shared strings per UI language. */
export const SHARED_MESSAGES: Readonly<Record<Locale, SharedMessages>> = Object.freeze({
  es: SHARED_ES,
  en: SHARED_EN,
});

/** The shared strings of `locale` (Spanish for anything that is not a locale). */
export function sharedMessages(locale: Locale = DEFAULT_LOCALE): SharedMessages {
  return SHARED_MESSAGES[toLocale(locale)];
}

/**
 * Name and help line of an achievement: «7 días de racha» · «Cumple tu objetivo diario 7
 * días seguidos»; «7-day streak» · «Meet your daily goal 7 days in a row». Undefined for
 * an unknown id.
 */
export function achievementText(
  id: string,
  locale: Locale = DEFAULT_LOCALE,
): { title: string; help: string } | undefined {
  const achievement = ACHIEVEMENTS.find((a) => a.id === id);
  if (!achievement) return undefined;
  const t = sharedMessages(locale).achievements;
  return {
    title: t.titles[achievement.id],
    help: t.help(achievement.metric, achievement.threshold),
  };
}
