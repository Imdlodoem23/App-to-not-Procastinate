/**
 * What `Countdown` shows at an instant (PROMPT §10 «Cuenta atrás»), pure: `endsAt − now` with the
 * guardian's `endsAt` (never a decremented counter), `M:SS` under an hour and `H:MM:SS` above,
 * rounded up to the second, the screen reader label, and the delay of the one `setTimeout` that
 * wakes it when the displayed second changes.
 */
import {
  countdownAnnouncement,
  countdownAria,
  nextTickDelay,
  splitCountdown,
  type CountdownParts,
} from '../../../shared/format';

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
 * The polite announcement for a move from `prevMs` to `nextMs` remaining (15, 5 and 1 min, and
 * the end), or `null`. The first render (`prevMs === null`) never speaks.
 */
export function countdownSpeech(prevMs: number | null, nextMs: number): string | null {
  return prevMs === null ? null : countdownAnnouncement(prevMs, nextMs);
}
