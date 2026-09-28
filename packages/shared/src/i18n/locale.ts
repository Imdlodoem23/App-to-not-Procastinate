/**
 * UI languages: Spanish (the product's first language) and English. Every shared helper
 * that returns user-visible text takes a `locale` that defaults to Spanish, so callers
 * that pass none keep their Spanish output. Pure module.
 *
 * Language choice is the apps' job (the desktop app's «Idioma» setting or the OS
 * languages, the extension's browser UI language, the website's URL); these helpers only
 * turn what they read into a `Locale` the same way everywhere.
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `value` when it is a locale, Spanish otherwise (stored or untyped values). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** «en», «en-GB», «en_US» → `en`; anything else (and nothing) → `es`. */
export function localeFromLanguage(tag: string | null | undefined): Locale {
  return typeof tag === 'string' && /^en(?:[-_]|$)/i.test(tag.trim()) ? 'en' : DEFAULT_LOCALE;
}

/**
 * The first language of a preference list (`navigator.languages`,
 * `app.getPreferredSystemLanguages()`) as a locale; blank entries are skipped.
 */
export function localeFromLanguages(tags: readonly (string | null | undefined)[]): Locale {
  const first = tags.find((tag): tag is string => typeof tag === 'string' && tag.trim() !== '');
  return localeFromLanguage(first);
}

/** BCP 47 tag for `Intl` (numbers, clock times, dates, lists) and `<html lang>`. */
export function intlTag(locale: Locale = DEFAULT_LOCALE): 'es-ES' | 'en-US' {
  return locale === 'en' ? 'en-US' : 'es-ES';
}
