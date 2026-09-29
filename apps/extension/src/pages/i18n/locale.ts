/**
 * The pages' language: Spanish or English, from the browser's UI language
 * (`chrome.i18n.getUILanguage()`): a tag starting with `en` gives English, anything else
 * Spanish (the product's first language). The browser only changes it on a restart, so each
 * page reads it once when it loads.
 *
 * Pure apart from `browserUiLanguage` (guarded: tests and pages opened outside the extension
 * have no `chrome.i18n`, and get Spanish).
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** «en», «en-GB», «en_US» → `en`; anything else (and nothing) → `es`. */
export function localeFromLanguage(tag: string | null | undefined): Locale {
  return typeof tag === 'string' && /^en(?:[-_]|$)/i.test(tag.trim()) ? 'en' : DEFAULT_LOCALE;
}

/** The browser's UI language, or `null` outside an extension page. */
export function browserUiLanguage(): string | null {
  try {
    if (typeof chrome === 'undefined' || typeof chrome.i18n?.getUILanguage !== 'function') {
      return null;
    }
    return chrome.i18n.getUILanguage();
  } catch {
    return null;
  }
}

/** The pages' locale for this browser. */
export function detectLocale(): Locale {
  return localeFromLanguage(browserUiLanguage());
}

/** BCP 47 tag for `Intl` (numbers, clock times, dates) and `<html lang>`. */
export function intlTag(locale: Locale): string {
  return locale === 'en' ? 'en-US' : 'es-ES';
}
