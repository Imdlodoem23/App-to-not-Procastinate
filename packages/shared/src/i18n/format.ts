/**
 * Numbers and clock times in a UI language, with the same `Intl` options as the apps:
 * grouping always on («1.240» in Spanish, «1,240» in English, never «1240»), the
 * typographic minus «−» for negative numbers, and each locale's clock («17:42» on 24 h in
 * Spanish, «5:42 PM» in English). Local time zone. Pure apart from the formatter cache.
 */
import { DEFAULT_LOCALE, intlTag, type Locale } from './locale';

/** Typographic minus for negative points («−10»). */
export const MINUS = '−';

/** One formatter per locale, built on first use. */
function perLocale<T>(make: (tag: string, locale: Locale) => T): (locale: Locale) => T {
  const cache = new Map<Locale, T>();
  return (locale) => {
    let value = cache.get(locale);
    if (value === undefined) {
      value = make(intlTag(locale), locale);
      cache.set(locale, value);
    }
    return value;
  };
}

const intFormat = perLocale(
  (tag) => new Intl.NumberFormat(tag, { useGrouping: 'always', maximumFractionDigits: 0 }),
);

const clockFormat = perLocale((tag, locale) =>
  locale === 'en'
    ? new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit', hour12: true })
    : new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
);

/**
 * «1.240», «−340», «0» (Spanish); «1,240», «−340» (English). Rounds to an integer; a value
 * that is not a finite number reads «0».
 */
export function formatInteger(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  // `Math.round(-0.4)` is −0, which `Intl` would print as «-0».
  if (rounded === 0) return intFormat(locale).format(0);
  const digits = intFormat(locale).format(Math.abs(rounded));
  return rounded < 0 ? `${MINUS}${digits}` : digits;
}

/** «+80», «−10», «0». */
export function formatSignedInteger(value: number, locale: Locale = DEFAULT_LOCALE): string {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  return rounded > 0 ? `+${formatInteger(rounded, locale)}` : formatInteger(rounded, locale);
}

/** «17:42», «08:00» (Spanish); «5:42 PM», «8:00 AM» (English). Local time. */
export function formatClock(date: Date, locale: Locale = DEFAULT_LOCALE): string {
  return clockFormat(locale).format(date);
}
