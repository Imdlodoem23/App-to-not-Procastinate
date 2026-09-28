/**
 * Numbers, clock times and dates in a UI language, with the same `Intl` options as the
 * apps: grouping always on («1.240» in Spanish, «1,240» in English, never «1240»), the
 * typographic minus «−» for negative numbers, a 24 h clock in Spanish («17:42», «08:00»)
 * and the region's own clock in English («5:42 PM» in en-US, «17:42» in en-GB). Local time
 * zone. Pure apart from the formatter cache.
 *
 * Every helper takes the UI `locale` and, optionally, the user's language `tag` (or list
 * of tags, see `intlTag`) for the region: without one, Spanish formats as es-ES and
 * English as en-US.
 */
import { DEFAULT_LOCALE, intlTag, toLocale, type Locale } from './locale';

/** Typographic minus for negative points («−10»). */
export const MINUS = '−';

/** The user's language tag or tags, most preferred first (see `intlTag`). */
export type LanguageTags = string | readonly (string | null | undefined)[];

/** One formatter per locale and resolved tag, built on first use. */
function perLocale<T>(
  make: (tag: string, locale: Locale) => T,
): (locale: Locale, tags?: LanguageTags) => T {
  const cache = new Map<string, T>();
  return (locale, tags) => {
    const language = toLocale(locale);
    const tag = intlTag(language, tags);
    const key = `${language} ${tag}`;
    let value = cache.get(key);
    if (value === undefined) {
      value = make(tag, language);
      cache.set(key, value);
    }
    return value;
  };
}

const intFormat = perLocale(
  (tag) => new Intl.NumberFormat(tag, { useGrouping: 'always', maximumFractionDigits: 0 }),
);

const clockFormat = perLocale((tag, locale) =>
  locale === 'en'
    ? new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' })
    : new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
);

const dayMonthFormat = perLocale(
  (tag) => new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'numeric' }),
);

/**
 * «1.240», «−340», «0» (Spanish); «1,240», «−340» (English). Rounds to an integer; a value
 * that is not a finite number reads «0».
 */
export function formatInteger(
  value: number,
  locale: Locale = DEFAULT_LOCALE,
  tags?: LanguageTags,
): string {
  const format = intFormat(locale, tags);
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  // `Math.round(-0.4)` is −0, which `Intl` would print as «-0».
  if (rounded === 0) return format.format(0);
  const digits = format.format(Math.abs(rounded));
  return rounded < 0 ? `${MINUS}${digits}` : digits;
}

/** «+80», «−10», «0». */
export function formatSignedInteger(
  value: number,
  locale: Locale = DEFAULT_LOCALE,
  tags?: LanguageTags,
): string {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  const text = formatInteger(rounded, locale, tags);
  return rounded > 0 ? `+${text}` : text;
}

/**
 * «17:42», «08:00» (Spanish, always 24 h); «5:42 PM», «8:00 AM» (en-US) or «17:42» (en-GB).
 * Local time.
 */
export function formatClock(
  date: Date,
  locale: Locale = DEFAULT_LOCALE,
  tags?: LanguageTags,
): string {
  return clockFormat(locale, tags).format(date);
}

/** Day and month: «30/9» (Spanish), «9/30» (en-US), «30/09» (en-GB). Local time. */
export function formatDayMonth(
  date: Date,
  locale: Locale = DEFAULT_LOCALE,
  tags?: LanguageTags,
): string {
  return dayMonthFormat(locale, tags).format(date);
}
