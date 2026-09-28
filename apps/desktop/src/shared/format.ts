/**
 * Numbers, clock times, countdowns and target lists, formatted the one way the whole app
 * shows them (PROMPT §10 «Cuenta atrás, números y textos»), in the active locale
 * (`src/shared/i18n/locale.ts`):
 * - `Intl` with `useGrouping: 'always'` («1.240» in es-ES, «1,240» in en-US, never «1240»),
 *   the locale's clock (24 h in Spanish, «5:42 PM» in English) and the typographic minus «−»;
 * - the countdown is `endsAt − now`, shown as `M:SS` under an hour and `H:MM:SS` above, rounded
 *   **up** to the second (it never reads 0:00 while a block is still enforced), with minute
 *   words rounded up the same way («quedan 43 min» while the countdown reads 42:10).
 *
 * Clock times use the process time zone (the OS zone; tests and screenshots run with
 * `TZ=Europe/Madrid`). Pure module: no DOM, Node or Electron imports.
 */
import { appName, getCategory, getService } from '@centrate/shared/catalog';
import type { BlockMode, TargetSpec } from '@centrate/shared/domain';
import { durationLabel } from '@centrate/shared/parser';
import type { CategoryId } from '@centrate/shared/catalog';
import { SHARED, activeLocale, intlTag, type Locale } from './i18n';

/** BCP 47 tag of the active locale for `Intl` («es-ES», «en-US»). */
export function intlLocale(): string {
  return intlTag(activeLocale());
}
/** Typographic minus for negative points («−10 puntos»). */
export const MINUS = '−';
/** Added to every countdown timeout so it fires just after the displayed second changes. */
export const TICK_EPSILON_MS = 4;

/** One formatter per locale, built on first use. */
function perLocale<T>(make: (locale: Locale) => T): () => T {
  const cache = new Map<Locale, T>();
  return () => {
    const locale = activeLocale();
    let value = cache.get(locale);
    if (value === undefined) {
      value = make(locale);
      cache.set(locale, value);
    }
    return value;
  };
}

const intFormat = perLocale(
  (locale) =>
    new Intl.NumberFormat(intlTag(locale), { useGrouping: 'always', maximumFractionDigits: 0 }),
);
const clockFormat = perLocale((locale) =>
  locale === 'en'
    ? new Intl.DateTimeFormat(intlTag(locale), { hour: 'numeric', minute: '2-digit', hour12: true })
    : new Intl.DateTimeFormat(intlTag(locale), {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
);
const weekdayFormat = perLocale(
  (locale) => new Intl.DateTimeFormat(intlTag(locale), { weekday: 'short' }),
);
const listFormat = perLocale(
  (locale) => new Intl.ListFormat(intlTag(locale), { style: 'long', type: 'conjunction' }),
);

/** «1.240», «−340», «0». Rounds to an integer. */
export function formatInt(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return intFormat().format(0);
  return `${rounded < 0 ? MINUS : ''}${intFormat().format(Math.abs(rounded))}`;
}

/** «+80», «−10», «0». */
export function formatSignedInt(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatInt(rounded)}` : formatInt(rounded);
}

/** «1.240 puntos», «1 punto»; with `signed`, «+80 puntos», «−10 puntos». */
export function formatPoints(value: number, options: { signed?: boolean } = {}): string {
  const amount = options.signed ? formatSignedInt(value) : formatInt(value);
  return SHARED.points.long(amount, Math.round(value));
}

/** «1.240 pts» (tray tooltip). */
export function formatPointsShort(value: number): string {
  return SHARED.points.short(formatInt(value));
}

/** «17:42» in Spanish, «5:42 PM» in English (local time). */
export function formatClock(ms: number): string {
  return clockFormat().format(new Date(ms));
}

/** Short weekday of `ms` without a trailing dot («jue», «Thu»). */
export function formatWeekday(ms: number): string {
  return weekdayFormat().format(new Date(ms)).replace(/\.$/, '');
}

/** «YouTube e Instagram», «YouTube, TikTok y Twitch»; «YouTube and Instagram» in English. */
export function formatList(items: readonly string[]): string {
  return listFormat().format(items);
}

/** Display name of a catalog category in the active locale («Redes sociales», «Social media»). */
export function categoryName(id: CategoryId | string): string {
  const names: Readonly<Record<string, string>> = SHARED.categories;
  return names[id] ?? getCategory(id)?.name ?? id;
}

/** Whole minutes left, rounded up; 0 when the time has passed. */
export function remainingMinutes(remainingMs: number): number {
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 60_000);
}

/** «42 min», «1 h», «1 h 30 min» (same wording as the parser chips). */
export function formatMinutes(minutes: number): string {
  return durationLabel(minutes);
}

/** «quedan 42 min», «queda 1 min», «quedan 1 h 5 min» (title, tooltip, rows). */
export function formatRemaining(remainingMs: number): string {
  const minutes = remainingMinutes(remainingMs);
  return SHARED.remaining.words(minutes, durationLabel(minutes));
}

export interface CountdownParts {
  /** «42» or «1:02»: full opacity. */
  lead: string;
  /** «:10»: shown at `countdownSecondsOpacity`. */
  seconds: string;
  /** `lead + seconds`, for tests and plain-text surfaces. */
  text: string;
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

/** `role="timer"` label: «Quedan 43 minutos», «Quedan 1 hora y 5 minutos». */
export function countdownAria(remainingMs: number): string {
  const minutes = remainingMinutes(remainingMs);
  return SHARED.remaining.aria(Math.floor(minutes / 60), minutes % 60);
}

const ANNOUNCE_AT_MINUTES = [1, 5, 15] as const;

/**
 * What the `aria-live="polite"` region says when the countdown moves from `prevMs` to
 * `nextMs`: only when it crosses 15, 5 or 1 min, or the end (the lowest crossed mark wins, so
 * waking from sleep never reads a stale one). `null` otherwise.
 */
export function countdownAnnouncement(prevMs: number, nextMs: number): string | null {
  if (prevMs > 0 && nextMs <= 0) return SHARED.remaining.ended;
  for (const minutes of ANNOUNCE_AT_MINUTES) {
    const mark = minutes * 60_000;
    if (prevMs > mark && nextMs <= mark && nextMs > 0) return SHARED.remaining.announce(minutes);
  }
  return null;
}

/** Display name of a catalog app in the active locale («Juegos de PC populares», «Popular PC games»). */
export function appLabel(id: string): string {
  return appName(id, activeLocale());
}

/** «Normal», «Estricto», «Hardcore», «Examen». */
export function modeLabel(mode: BlockMode): string {
  return SHARED.modes[mode];
}

/** Display names of what a block blocks, in the order services, categories, apps, custom. */
export function targetNames(targets: TargetSpec, whitelistOnly: boolean): string[] {
  if (whitelistOnly) return [SHARED.targets.whitelistOnly];
  return [
    ...targets.serviceIds.map((id) => getService(id)?.name ?? id),
    ...targets.categoryIds.map((id) => categoryName(id)),
    ...targets.appIds.map((id) => appLabel(id)),
    ...targets.customDomains,
    ...targets.customProcesses,
  ];
}

/**
 * «YouTube, Instagram», «YouTube, Instagram +2», «Redes sociales», «Todo salvo la lista
 * blanca». Never clipped by CSS: callers pick `maxNames` for the space they have.
 */
export function targetsLabel(
  targets: TargetSpec,
  whitelistOnly: boolean,
  maxNames: number = 2,
): string {
  const names = targetNames(targets, whitelistOnly);
  if (names.length === 0) return SHARED.targets.none;
  const shown = Math.max(1, maxNames);
  if (names.length <= shown) return names.join(SHARED.targets.separator);
  const head = names.slice(0, shown).join(SHARED.targets.separator);
  return `${head} ${SHARED.targets.more(names.length - shown)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
