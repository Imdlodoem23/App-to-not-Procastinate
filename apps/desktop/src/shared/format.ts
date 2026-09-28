/**
 * Numbers, clock times, countdowns and target lists, formatted the one way the whole app
 * shows them (PROMPT §10 «Cuenta atrás, números y textos»):
 * - `Intl` in `es-ES` with `useGrouping: 'always'` («1.240», never «1240»), 24 h clock and the
 *   typographic minus «−»;
 * - the countdown is `endsAt − now`, shown as `M:SS` under an hour and `H:MM:SS` above, rounded
 *   **up** to the second (it never reads 0:00 while a block is still enforced), with minute
 *   words rounded up the same way («quedan 43 min» while the countdown reads 42:10).
 *
 * Clock times use the process time zone (the OS zone; tests and screenshots run with
 * `TZ=Europe/Madrid`). Pure module: no DOM, Node or Electron imports.
 */
import { getApp, getCategory, getService } from '@centrate/shared/catalog';
import type { BlockMode, TargetSpec } from '@centrate/shared/domain';
import { durationLabel } from '@centrate/shared/parser';
import { SHARED_ES } from './i18n/es';

export const LOCALE = 'es-ES';
/** Typographic minus for negative points («−10 puntos»). */
export const MINUS = '−';
/** Added to every countdown timeout so it fires just after the displayed second changes. */
export const TICK_EPSILON_MS = 4;

const intFormat = new Intl.NumberFormat(LOCALE, {
  useGrouping: 'always',
  maximumFractionDigits: 0,
});
const clockFormat = new Intl.DateTimeFormat(LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «1.240», «−340», «0». Rounds to an integer. */
export function formatInt(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return intFormat.format(0);
  return `${rounded < 0 ? MINUS : ''}${intFormat.format(Math.abs(rounded))}`;
}

/** «+80», «−10», «0». */
export function formatSignedInt(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatInt(rounded)}` : formatInt(rounded);
}

/** «1.240 puntos», «1 punto»; with `signed`, «+80 puntos», «−10 puntos». */
export function formatPoints(value: number, options: { signed?: boolean } = {}): string {
  const amount = options.signed ? formatSignedInt(value) : formatInt(value);
  return SHARED_ES.points.long(amount, Math.round(value));
}

/** «1.240 pts» (tray tooltip). */
export function formatPointsShort(value: number): string {
  return SHARED_ES.points.short(formatInt(value));
}

/** «17:42» (24 h, local time). */
export function formatClock(ms: number): string {
  return clockFormat.format(new Date(ms));
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
  return SHARED_ES.remaining.words(minutes, durationLabel(minutes));
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
  return SHARED_ES.remaining.aria(Math.floor(minutes / 60), minutes % 60);
}

const ANNOUNCE_AT_MINUTES = [1, 5, 15] as const;

/**
 * What the `aria-live="polite"` region says when the countdown moves from `prevMs` to
 * `nextMs`: only when it crosses 15, 5 or 1 min, or the end (the lowest crossed mark wins, so
 * waking from sleep never reads a stale one). `null` otherwise.
 */
export function countdownAnnouncement(prevMs: number, nextMs: number): string | null {
  if (prevMs > 0 && nextMs <= 0) return SHARED_ES.remaining.ended;
  for (const minutes of ANNOUNCE_AT_MINUTES) {
    const mark = minutes * 60_000;
    if (prevMs > mark && nextMs <= mark && nextMs > 0) return SHARED_ES.remaining.announce(minutes);
  }
  return null;
}

/** «Normal», «Estricto», «Hardcore», «Examen». */
export function modeLabel(mode: BlockMode): string {
  return SHARED_ES.modes[mode];
}

/** Display names of what a block blocks, in the order services, categories, apps, custom. */
export function targetNames(targets: TargetSpec, whitelistOnly: boolean): string[] {
  if (whitelistOnly) return [SHARED_ES.targets.whitelistOnly];
  return [
    ...targets.serviceIds.map((id) => getService(id)?.name ?? id),
    ...targets.categoryIds.map((id) => getCategory(id)?.name ?? id),
    ...targets.appIds.map((id) => getApp(id)?.name ?? id),
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
  if (names.length === 0) return SHARED_ES.targets.none;
  const shown = Math.max(1, maxNames);
  if (names.length <= shown) return names.join(SHARED_ES.targets.separator);
  const head = names.slice(0, shown).join(SHARED_ES.targets.separator);
  return `${head} ${SHARED_ES.targets.more(names.length - shown)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
