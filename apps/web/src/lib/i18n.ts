/**
 * Languages of the website: Spanish (the default, at /) and English (under /en). Routes per
 * language, the language of a URL, and the locale-aware formatters shared by pages and client
 * scripts.
 *
 * Safe to import from client scripts: it has no dependencies (it does not import copy.ts).
 */

export const langs = ['es', 'en'] as const;
export type Lang = (typeof langs)[number];
export const defaultLang: Lang = 'es';

/** BCP 47 tag for Intl and hreflang. */
export const intlLocale: Record<Lang, string> = { es: 'es-ES', en: 'en-US' };
/** Open Graph locale. */
export const ogLocale: Record<Lang, string> = { es: 'es_ES', en: 'en_US' };
/** Each language's name in itself (the text of the language switch). */
export const langNames: Record<Lang, string> = { es: 'Español', en: 'English' };

/** localStorage key that remembers the visitor chose a language (switch or hint). */
export const LANG_CHOICE_KEY = 'centrate-lang';

/** Which page a layout is rendering: drives the bar's download pill and the language switch. */
export type PageKey = 'home' | 'download' | 'changelog' | 'privacy' | 'not-found';

/** Internal routes of each language. The 404 has none: Render serves it for any path. */
export const routes = {
  es: { home: '/', download: '/descargar', changelog: '/novedades', privacy: '/privacidad' },
  en: { home: '/en', download: '/en/download', changelog: '/en/changelog', privacy: '/en/privacy' },
} as const satisfies Record<Lang, Record<Exclude<PageKey, 'not-found'>, string>>;
export type Routes = (typeof routes)[Lang];

/** The language of a path: /en and everything under /en/ is English, the rest Spanish. */
export function langFromPath(pathname: string): Lang {
  return /^\/en(?:\/|\.html$|$)/.test(pathname) ? 'en' : 'es';
}

/** The same page in another language (the home page for the 404). */
export function pathFor(page: PageKey | undefined, lang: Lang): string {
  const map = routes[lang];
  return page && page !== 'not-found' ? map[page] : map.home;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Clock time in each language's usual form: 24-hour «17:42» and «08:00» in Spanish (the app's
 * own form), «5:42 PM» in English.
 */
export function formatTime(date: Date, lang: Lang): string {
  if (lang === 'es') return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Intl.DateTimeFormat(intlLocale[lang], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/** Day and month, «30/9» or «9/30». */
export function formatDayMonth(date: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(intlLocale[lang], { day: 'numeric', month: 'numeric' }).format(
    date,
  );
}

/** The document's language, for client scripts (from <html lang>). */
export function documentLang(): Lang {
  if (typeof document === 'undefined') return defaultLang;
  return document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'es';
}
