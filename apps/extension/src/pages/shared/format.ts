/**
 * Numbers, clock times and countdowns, formatted exactly like the desktop app (PROMPT §10
 * «Cuenta atrás, números y textos»), in the pages' locale (`i18n/index.ts`):
 * - `Intl` with `useGrouping: 'always'` («1.240» in es-ES, «1,240» in en-US, never «1240»),
 *   the locale's clock (24 h in Spanish, «5:42 PM» in English) and the typographic minus «−»;
 * - the countdown is `endsAt − now`, `M:SS` under an hour and `H:MM:SS` above, rounded **up**
 *   to the second (it never reads 0:00 while a block is still enforced), and minute words
 *   rounded up the same way («quedan 43 min» while the countdown reads 42:10).
 *
 * Pure module (no DOM; the locale comes from `i18n/index.ts`).
 */
// The formatters only: the package entry `@centrate/shared/parser` would also bundle the
// whole natural-language parser into every page.
import { durationLabel } from '@centrate/shared/parser/format';
import { PAGES, intlTag, pagesLocale, type Locale } from '../i18n';

/** Typographic minus for negative points («−10 puntos»). */
export const MINUS = '−';
/** Added to every countdown timeout so it fires just after the displayed second changes. */
export const TICK_EPSILON_MS = 4;

/** One formatter per locale, built on first use. */
function perLocale<T>(make: (tag: string, locale: Locale) => T): () => T {
  const cache = new Map<Locale, T>();
  return () => {
    const locale = pagesLocale();
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
const dayMonthFormat = perLocale(
  (tag) => new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'numeric' }),
);

/** «1.240», «−340», «0». Rounds to an integer. */
export function formatInt(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return intFormat().format(0);
  return `${rounded < 0 ? MINUS : ''}${intFormat().format(Math.abs(rounded))}`;
}

/** «−10 puntos», «+80 puntos», «1 punto»; «−10 points» in English. */
export function formatPoints(value: number, options: { signed?: boolean } = {}): string {
  const rounded = Math.round(value);
  const amount = options.signed && rounded > 0 ? `+${formatInt(rounded)}` : formatInt(rounded);
  return PAGES.common.points.long(amount, rounded);
}

/** «17:42» in Spanish, «5:42 PM» in English (local time). */
export function formatClock(ms: number): string {
  return clockFormat().format(new Date(ms));
}

/** «28/9» in Spanish, «9/28» in English (local date, no year). */
export function formatDayMonth(ms: number): string {
  return dayMonthFormat().format(new Date(ms));
}

/** Local calendar days from `fromMs` to `toMs` (0 today, 1 tomorrow…). */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * «hasta 17:42», «hasta mañana 08:00», «hasta el 30/9 08:00» (the parser's `untilLabel`
 * wording, like the app); «until 5:42 PM», «until tomorrow 8:00 AM», «until 9/30 8:00 AM» in
 * English. The midnight that ends today reads as today («hasta 00:00»).
 */
export function formatUntil(endsAtMs: number, nowMs: number): string {
  const u = PAGES.common.until;
  const time = formatClock(endsAtMs);
  const end = new Date(endsAtMs);
  const days = calendarDaysBetween(nowMs, endsAtMs);
  const midnight = end.getHours() === 0 && end.getMinutes() === 0;
  if (days <= 0 || (days === 1 && midnight)) return u.today(time);
  if (days === 1) return u.tomorrow(time);
  return u.date(formatDayMonth(endsAtMs), time);
}

/** Whole minutes left, rounded up; 0 when the time has passed. */
export function remainingMinutes(remainingMs: number): number {
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 60_000);
}

/** «quedan 42 min», «queda 1 min», «quedan 1 h 5 min»; «42 min left» in English. */
export function formatRemaining(remainingMs: number): string {
  const minutes = remainingMinutes(remainingMs);
  return PAGES.common.remaining.words(minutes, durationLabel(minutes));
}

/** «43 minutos», «1 hora y 5 minutos» (humor lines), rounded up like the countdown. */
export function formatRemainingProse(remainingMs: number): string {
  const minutes = remainingMinutes(remainingMs);
  return PAGES.common.remaining.prose(Math.floor(minutes / 60), minutes % 60);
}

export interface CountdownParts {
  /** «42» or «1:02»: full opacity. */
  lead: string;
  /** «:10»: shown at `--countdown-seconds-opacity`. */
  seconds: string;
  /** `lead + seconds`, for tests and plain-text surfaces. */
  text: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `M:SS` under an hour, `H:MM:SS` from one hour, rounded up to the second. */
export function splitCountdown(remainingMs: number): CountdownParts {
  const total = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const lead = hours > 0 ? `${hours}:${pad2(minutes)}` : String(minutes);
  const seconds = `:${pad2(secs)}`;
  return { lead, seconds, text: lead + seconds };
}

/**
 * Delay until the displayed countdown second changes, plus `TICK_EPSILON_MS`: schedule one
 * `setTimeout` with it after every render (never decrement a counter, never use rAF).
 * `null` once the time is up.
 */
export function nextTickDelay(remainingMs: number): number | null {
  if (remainingMs <= 0) return null;
  const intoSecond = remainingMs % 1000;
  return (intoSecond === 0 ? 1000 : intoSecond) + TICK_EPSILON_MS;
}

/**
 * Delay until the minute words («quedan 43 min», rounded up) change, plus `TICK_EPSILON_MS`:
 * they change each time the time left crosses a whole minute, which is also when the
 * 15, 5 and 1 min marks and the end are crossed. For surfaces without a seconds countdown
 * (blocked.html). `null` once the time is up.
 */
export function nextMinuteDelay(remainingMs: number): number | null {
  if (remainingMs <= 0) return null;
  const intoMinute = remainingMs % 60_000;
  return (intoMinute === 0 ? 60_000 : intoMinute) + TICK_EPSILON_MS;
}

/** `role="timer"` label: «Quedan 43 minutos», «Quedan 1 hora y 5 minutos». */
export function countdownAria(remainingMs: number): string {
  const minutes = remainingMinutes(remainingMs);
  return PAGES.common.remaining.aria(Math.floor(minutes / 60), minutes % 60);
}

const ANNOUNCE_AT_MINUTES = [1, 5, 15] as const;

/**
 * What the `aria-live="polite"` region says when the countdown moves from `prevMs` to
 * `nextMs`: only when it crosses 15, 5 or 1 min (the lowest crossed mark wins, so waking from
 * sleep never reads a stale one). `null` otherwise, and at 0 too: the block may still be
 * enforced then («Comprobando la hora…»), so «Bloqueo terminado» waits until it has gone
 * (phase.ts `createEndAnnouncer`).
 */
export function countdownAnnouncement(prevMs: number, nextMs: number): string | null {
  for (const minutes of ANNOUNCE_AT_MINUTES) {
    const mark = minutes * 60_000;
    if (prevMs > mark && nextMs <= mark && nextMs > 0) {
      return PAGES.common.remaining.announce(minutes);
    }
  }
  return null;
}

/** Parses an ISO time from the guardian; `null` when unreadable. */
export function parseIso(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}
