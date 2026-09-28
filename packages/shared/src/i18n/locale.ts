/**
 * UI languages: Spanish (the product's first language) and English. Every shared helper
 * that returns user-visible text takes a `locale` that defaults to Spanish, so callers
 * that pass none keep their Spanish output. Pure module.
 *
 * Language choice is the apps' job (the desktop app's «Idioma» setting or the OS
 * languages, the extension's browser UI language, the website's URL); these helpers only
 * turn what they read into a `Locale` the same way everywhere:
 * - the first Spanish or English entry of the user's language list wins, so
 *   `['fr-FR', 'en-US']` is English and `['ca-ES', 'es-ES']` is Spanish;
 * - a list with neither falls back to Spanish, the product's first language (the
 *   extension's `default_locale` and the website's `x-default` are Spanish too).
 *
 * `Locale` only picks the copy. Numbers, clock times and dates follow the user's region
 * through `intlTag(locale, languages)`: an en-GB user reads English copy with a 24 h clock
 * and day/month dates.
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

/** Tags `Intl` uses when the user's languages name no region for the locale. */
const DEFAULT_TAGS: Readonly<Record<Locale, string>> = Object.freeze({
  es: 'es-ES',
  en: 'en-US',
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `value` when it is a locale, Spanish otherwise (stored or untyped values). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

const LANGUAGE_RE = /^(es|en)(?:[-_]|$)/i;

/** «en-GB» → `en`, «es_419» → `es`; null for other languages («fr», «eng», «ca») and blanks. */
function languageOf(tag: unknown): Locale | null {
  if (typeof tag !== 'string') return null;
  const match = LANGUAGE_RE.exec(tag.trim());
  return match?.[1] ? toLocale(match[1].toLowerCase()) : null;
}

/** «en», «en-GB», «en_US» → `en`; anything else (and nothing) → `es`. */
export function localeFromLanguage(tag: string | null | undefined): Locale {
  return languageOf(tag) ?? DEFAULT_LOCALE;
}

/**
 * The UI language for a preference list (`navigator.languages`,
 * `app.getPreferredSystemLanguages()`), most preferred first: its first Spanish or English
 * entry, or Spanish when it has neither.
 */
export function localeFromLanguages(tags: readonly (string | null | undefined)[]): Locale {
  for (const tag of tags) {
    const language = languageOf(tag);
    if (language) return language;
  }
  return DEFAULT_LOCALE;
}

/** The canonical form of a BCP 47 tag («en_gb» → «en-GB»), or null when `Intl` rejects it. */
function canonicalTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.trim().replace(/_/g, '-'))[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * BCP 47 tag for `Intl` (numbers, clock times, dates) and `<html lang>`. `languages` are
 * the user's OS or browser languages, most preferred first (or a single tag): the first one
 * in `locale`'s language is used, so an en-GB, en-AU or es-MX user gets their region's
 * formats. Without one that matches (or with none given), es-ES or en-US.
 */
export function intlTag(
  locale: Locale = DEFAULT_LOCALE,
  languages: string | readonly (string | null | undefined)[] = [],
): string {
  const language = toLocale(locale);
  const list = typeof languages === 'string' ? [languages] : languages;
  for (const tag of list) {
    if (languageOf(tag) !== language || typeof tag !== 'string') continue;
    const canonical = canonicalTag(tag);
    if (canonical) return canonical;
  }
  return DEFAULT_TAGS[language];
}
