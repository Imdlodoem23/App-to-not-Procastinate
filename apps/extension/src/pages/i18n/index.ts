/**
 * The pages' copy in the browser's language (`locale.ts`): import `PAGES` for strings, and
 * `PAGES_ES` / `PAGES_EN` only where one language is meant (tests).
 *
 * `PAGES` is a live binding: read it inside functions (`const b = PAGES.blocked` at the top
 * of one is fine), never copy a string into a module constant, so `setPagesLocale` (tests)
 * reaches every page module.
 */
import { PAGES_EN } from './en';
import { PAGES_ES, type PagesMessages } from './es';
import { detectLocale, intlTag, type Locale } from './locale';

export { PAGES_EN, PAGES_ES, type PagesMessages };
export * from './locale';

const TABLES: Readonly<Record<Locale, PagesMessages>> = { es: PAGES_ES, en: PAGES_EN };

let active: Locale = detectLocale();

/** The active locale's strings. */
export let PAGES: PagesMessages = TABLES[active];

export function pagesLocale(): Locale {
  return active;
}

/** BCP 47 tag of the active locale for `Intl` («es-ES», «en-US»). */
export function pagesIntlTag(): string {
  return intlTag(active);
}

/** Switches the pages' copy (tests; the pages keep the browser's language). */
export function setPagesLocale(locale: Locale): void {
  active = locale;
  PAGES = TABLES[locale];
}

/** Runs `fn` with `locale` active, then restores the previous one (tests). */
export function withPagesLocale<T>(locale: Locale, fn: () => T): T {
  const previous = active;
  setPagesLocale(locale);
  try {
    return fn();
  } finally {
    setPagesLocale(previous);
  }
}

/** `<html lang>` of an extension page, set once its script runs («es», «en»). */
export function applyDocumentLanguage(root: { lang: string } = document.documentElement): void {
  root.lang = active;
}
