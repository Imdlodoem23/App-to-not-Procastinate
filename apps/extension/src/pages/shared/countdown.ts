/**
 * Live countdowns (PROMPT §10 «Cuenta atrás»): every render computes `endsAt − Date.now()`
 * again, and one `setTimeout` aligned to the next visible change (the next second of a
 * countdown, the next minute of «quedan N min») schedules the next render (never a
 * decrementing counter, never `requestAnimationFrame`). Coming back from sleep or a hidden
 * tab re-renders at once.
 */
import { el, setAttr, setText } from './dom';
import { countdownAria, splitCountdown } from './format';
import type { AnnounceInput } from './phase';
import { createEndAnnouncer } from './phase';

export interface Ticker {
  /** Renders now and reschedules. */
  refresh(): void;
  stop(): void;
}

/**
 * Calls `render(now)` now and then after the delay it returns (`nextTickDelay`), or never
 * again when it returns `null` (until `refresh`).
 */
export function startTicker(
  render: (now: number) => number | null,
  now: () => number = () => Date.now(),
): Ticker {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const run = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const delay = render(now());
    if (delay !== null) timer = setTimeout(run, Math.max(0, delay));
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') run();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', run);
  run();
  return {
    refresh: run,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', run);
    },
  };
}

export interface Announcer {
  /**
   * Takes the page's state on every render; speaks only when a running block crossed 15, 5
   * or 1 min, or when the block has really gone (phase.ts `createEndAnnouncer`).
   */
  update(input: AnnounceInput): void;
}

/**
 * The `aria-live="polite"` region (`live`) of a countdown: it only speaks at 15, 5 and
 * 1 min and at the end, never every second or minute, and never «Bloqueo terminado» while
 * the block is still enforced («Comprobando la hora…»).
 */
export function createAnnouncer(live: HTMLElement): Announcer {
  const announcer = createEndAnnouncer();
  return {
    update(input) {
      const said = announcer.next(input);
      if (said !== null) setText(live, said);
    },
  };
}

export interface CountdownView {
  readonly element: HTMLElement;
  /** Shows `remainingMs` (clamped at 0). The page's `Announcer` speaks the marks. */
  update(remainingMs: number): void;
}

/**
 * The big countdown: `role="timer"` with an `aria-label` («Quedan 43 minutos») and the
 * seconds at 60 % opacity. The 15, 5 and 1 min marks and the end are spoken by the page's
 * `createAnnouncer` region, which also knows when the block has really gone.
 */
export function createCountdownView(element: HTMLElement): CountdownView {
  element.setAttribute('role', 'timer');
  element.classList.add('countdown');
  const lead = el('span', { className: 'countdown-lead' });
  const seconds = el('span', { className: 'countdown-seconds' });
  element.replaceChildren(lead, seconds);
  return {
    element,
    update(remainingMs) {
      const parts = splitCountdown(remainingMs);
      setText(lead, parts.lead);
      setText(seconds, parts.seconds);
      setAttr(element, 'aria-label', countdownAria(remainingMs));
    },
  };
}
