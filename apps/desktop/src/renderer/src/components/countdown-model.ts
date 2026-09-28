/**
 * What `Countdown` shows at an instant (PROMPT §10 «Cuenta atrás»), pure: `endsAt − now` with the
 * guardian's `endsAt` (never a decremented counter), `M:SS` under an hour and `H:MM:SS` above,
 * rounded up to the second, the screen reader label, and the delay of the one `setTimeout` that
 * wakes it when the displayed second changes.
 */
import {
  countdownAria,
  nextTickDelay,
  splitCountdown,
  type CountdownParts,
} from '../../../shared/format';
import { SHARED_ES } from '../../../shared/i18n/es';

export interface CountdownModel {
  remainingMs: number;
  parts: CountdownParts;
  /** `role="timer"` label: «Quedan 43 minutos». */
  aria: string;
  /** Next wake-up, or `null` once the time is up. */
  nextDelayMs: number | null;
}

export function endsAtMs(endsAt: string | number): number {
  return typeof endsAt === 'number' ? endsAt : Date.parse(endsAt);
}

export function countdownModel(endsAt: string | number, nowMs: number): CountdownModel {
  const remainingMs = endsAtMs(endsAt) - nowMs;
  return {
    remainingMs,
    parts: splitCountdown(remainingMs),
    aria: countdownAria(remainingMs),
    nextDelayMs: nextTickDelay(remainingMs),
  };
}

/**
 * What a countdown's polite region says: `mark(15 | 5 | 1)` as it crosses those minutes and
 * `end` when it reaches zero. `false`: the countdown has no live region (its owner announces,
 * or nothing is worth announcing).
 */
export type CountdownAnnounce = false | { mark(minutes: number): string; end: string };

/** A block's countdown: «Quedan 15 minutos», «Queda 1 minuto», «Bloqueo terminado». */
export const BLOCK_COUNTDOWN_ANNOUNCE: Exclude<CountdownAnnounce, false> = {
  mark: SHARED_ES.remaining.announce,
  end: SHARED_ES.remaining.ended,
};

/** The minutes a countdown announces as it crosses them. */
export const COUNTDOWN_MARKS_MINUTES = [15, 5, 1] as const;

/**
 * A mark is spoken only while it is still true: within this long after crossing it. A jump
 * over a mark (a sleep while visible, a stalled renderer) stays quiet rather than saying
 * «Quedan 5 minutos» when 3 are left.
 */
export const COUNTDOWN_MARK_FRESH_MS = 30_000;

/**
 * The polite announcement for a move from `prevMs` to `nextMs` remaining, or `null`:
 * - the first reading (`prevMs === null`, also after the window was hidden) never speaks;
 * - reaching zero says `end`;
 * - crossing exactly one mark says it, if that happened in the last 30 s; crossing several
 *   at once, or long ago, says nothing.
 */
export function countdownSpeech(
  prevMs: number | null,
  nextMs: number,
  texts: Exclude<CountdownAnnounce, false> = BLOCK_COUNTDOWN_ANNOUNCE,
): string | null {
  if (prevMs === null || nextMs >= prevMs) return null;
  if (prevMs > 0 && nextMs <= 0) return texts.end;
  if (nextMs <= 0) return null;
  const crossed = COUNTDOWN_MARKS_MINUTES.filter(
    (m) => prevMs > m * 60_000 && nextMs <= m * 60_000,
  );
  if (crossed.length !== 1) return null;
  const minutes = crossed[0] as number;
  return minutes * 60_000 - nextMs <= COUNTDOWN_MARK_FRESH_MS ? texts.mark(minutes) : null;
}
