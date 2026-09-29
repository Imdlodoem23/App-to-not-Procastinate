/**
 * Runs the notification policy on the core's clock (docs/DESKTOP.md §6.4):
 *
 * - at most **one OS notification per 60 s**: notices that arrive meanwhile wait and are
 *   grouped into the next one (`composeNotification`);
 * - stale notices are dropped at flush (`isStale`);
 * - nothing is shown while the main window is visible and focused (the UI already shows it):
 *   the queue is dropped instead;
 * - «Quedan 5 min» comes from a single timer at the next `endsAt − 5 min`, recomputed on
 *   every new state and on resume. Timers count monotonic time (suspend does not advance
 *   them on Linux and macOS), so the wait is cut into steps of at most
 *   `FIVE_MINUTES_STEP_MS` that re-read the wall clock; a mark more than
 *   `FIVE_MINUTES_LATE_MS` in the past (the machine slept through it) is skipped, since the
 *   text says «5 min»;
 * - the one-time close hint bypasses the wait (it still counts as the minute's
 *   notification, so the next one waits).
 */
import type { WireEvent } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { UI_TIMINGS } from '../../shared/ui-state';
import type { Clock, ShownNotification, TimerHandle } from '../contracts';
import { NOTIFY } from './i18n';
import {
  composeNotification,
  isStale,
  nextFiveMinuteDue,
  noticesFromEvents,
  withLimitBlockEnds,
  type Notice,
} from './policy';
import type { NotificationContent, Notifier } from './types';

export const SHOWN_HISTORY_MAX = 100;
/** Longest single wait of the five-minute timer before the wall clock is read again. */
export const FIVE_MINUTES_STEP_MS = 60_000;
/** A five-minute mark reached this late is skipped (the notice would lie). */
export const FIVE_MINUTES_LATE_MS = 60_000;

export interface NotificationSchedulerDeps {
  clock: Clock;
  notifier: Notifier;
  /** Main window visible **and** focused: notices are dropped. */
  mainFocused: () => boolean;
  /** Latest guardian state (staleness, five-minute marks). */
  getState: () => GuardianStateResponse | null;
}

export class NotificationScheduler {
  private queue: Notice[] = [];
  private lastShownAt: number | null = null;
  private flushTimer: TimerHandle | null = null;
  private fiveTimer: TimerHandle | null = null;
  private readonly fired = new Set<string>();
  private readonly history: ShownNotification[] = [];
  private stopped = false;

  constructor(private readonly deps: NotificationSchedulerDeps) {}

  /** A page of events (`notify: false` for pages before the first caught-up one). */
  ingestEvents(events: readonly WireEvent[], notify: boolean): void {
    if (!notify || this.stopped) return;
    this.enqueue(noticesFromEvents(events, this.deps.clock.now()));
  }

  /** A new guardian state: re-plan «Quedan 5 min» and forget marks of ended blocks. */
  onState(state: GuardianStateResponse | null): void {
    if (this.stopped) return;
    if (state) {
      const active = new Set(state.blocks.map((b) => b.id as string));
      for (const key of [...this.fired]) {
        if (!active.has(key.slice(0, key.indexOf('@')))) this.fired.delete(key);
      }
    }
    this.armFiveMinutes(state);
  }

  /** «Céntrate sigue en la bandeja. Los bloqueos siguen activos.» (first X only). */
  showCloseHint(): void {
    if (this.stopped) return;
    this.show({
      title: NOTIFY.closeHint.title,
      body: NOTIFY.closeHint.body,
      kinds: ['close_hint'],
    });
  }

  /** Everything shown so far (harness `notifications()`), oldest first. */
  shown(): ShownNotification[] {
    return this.history.map((n) => ({ ...n, kinds: [...n.kinds] }));
  }

  /** Notices waiting for the next slot (tests). */
  pending(): readonly Notice[] {
    return this.queue;
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    for (const timer of [this.flushTimer, this.fiveTimer]) {
      if (timer !== null) this.deps.clock.clearTimeout(timer);
    }
    this.flushTimer = null;
    this.fiveTimer = null;
  }

  private enqueue(notices: readonly Notice[]): void {
    if (notices.length === 0) return;
    this.queue.push(...notices);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.stopped || this.queue.length === 0 || this.flushTimer !== null) return;
    const now = this.deps.clock.now();
    const dueAt =
      this.lastShownAt === null ? now : this.lastShownAt + UI_TIMINGS.notifyMinIntervalMs;
    if (dueAt <= now) {
      this.flush();
      return;
    }
    this.flushTimer = this.deps.clock.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, dueAt - now);
  }

  private flush(): void {
    const now = this.deps.clock.now();
    const state = this.deps.getState();
    const live = withLimitBlockEnds(
      this.queue.filter((n) => !isStale(n, state, now)),
      state,
    );
    this.queue = [];
    if (live.length === 0) return;
    if (this.deps.mainFocused()) return;
    const content = composeNotification(live);
    if (content) this.show(content);
  }

  private show(content: NotificationContent): void {
    const now = this.deps.clock.now();
    this.lastShownAt = now;
    this.history.push({
      at: now,
      title: content.title,
      body: content.body,
      kinds: [...content.kinds],
    });
    if (this.history.length > SHOWN_HISTORY_MAX) this.history.shift();
    try {
      this.deps.notifier.show(content);
    } catch {
      // A notification backend failure must never break the core.
    }
    // Anything queued while this one was shown waits for the next slot.
    if (this.flushTimer !== null) {
      this.deps.clock.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.scheduleFlush();
  }

  private armFiveMinutes(state: GuardianStateResponse | null): void {
    if (this.fiveTimer !== null) {
      this.deps.clock.clearTimeout(this.fiveTimer);
      this.fiveTimer = null;
    }
    const now = this.deps.clock.now();
    const next = nextFiveMinuteDue(state, this.fired, now);
    if (!next) return;
    const wait = (): void => {
      const at = this.deps.clock.now();
      this.fiveTimer = this.deps.clock.setTimeout(
        () => {
          this.fiveTimer = null;
          if (this.stopped) return;
          const firedAt = this.deps.clock.now();
          // Woken early by the step, or the wall clock went back: keep waiting.
          if (firedAt < next.dueAt) {
            wait();
            return;
          }
          this.fired.add(next.key);
          if (firedAt - next.dueAt <= FIVE_MINUTES_LATE_MS) this.enqueue([next.notice]);
          this.armFiveMinutes(this.deps.getState());
        },
        Math.min(next.dueAt - at, FIVE_MINUTES_STEP_MS),
      );
    };
    wait();
  }
}
