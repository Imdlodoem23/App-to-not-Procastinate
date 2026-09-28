/**
 * Reminder timers: one timer at the next planned reminder (`plan.ts`), re-planned on every new
 * guardian state or prefs change. Shows native notifications (the core's notifier: at most a
 * few a day, so outside the 1-per-minute grouping of block notices). Off with the `reminders`
 * flag, and in the harness (frozen clock, fixture state).
 */
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { formatClock } from '../../shared/format';
import type { ReminderPrefs } from '../../shared/prefs';
import type { Clock, TimerHandle } from '../contracts';
import type { NotificationContent } from '../notifications/types';
import { REMINDERS } from './i18n';
import { nextReminder, type PlannedReminder } from './plan';

/** Keys of shown reminders are forgotten after this many (a few days' worth). */
const SHOWN_MAX = 200;

export interface ReminderSchedulerOptions {
  clock: Clock;
  show(content: NotificationContent): void;
}

export function reminderContent(reminder: PlannedReminder): NotificationContent {
  if (reminder.kind === 'eye-break') {
    return {
      title: REMINDERS.eyeBreak.title,
      body: REMINDERS.eyeBreak.body,
      kinds: ['reminder_eye_break'],
    };
  }
  const s = reminder.schedule;
  return {
    title: REMINDERS.schedule.title,
    body: s
      ? s.lead
        ? REMINDERS.schedule.soon(s.name, formatClock(s.startsAt))
        : REMINDERS.schedule.now(s.name)
      : REMINDERS.schedule.title,
    kinds: ['reminder_schedule'],
  };
}

export class ReminderScheduler {
  private state: GuardianStateResponse | null = null;
  private prefs: ReminderPrefs | null = null;
  private enabled = false;
  private planned: PlannedReminder | null = null;
  private timer: TimerHandle | null = null;
  private readonly shown = new Set<string>();
  private stopped = false;

  constructor(private readonly options: ReminderSchedulerOptions) {}

  /** New state, prefs or flag: plan again. */
  sync(state: GuardianStateResponse | null, prefs: ReminderPrefs, enabled: boolean): void {
    if (this.stopped) return;
    this.state = state;
    this.prefs = prefs;
    this.enabled = enabled;
    this.plan();
  }

  /** The reminder waiting to show (tests). */
  next(): PlannedReminder | null {
    return this.planned;
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.options.clock.clearTimeout(this.timer);
    this.timer = null;
    this.planned = null;
  }

  private plan(): void {
    const now = this.options.clock.now();
    const next =
      this.enabled && this.prefs ? nextReminder(this.state, this.prefs, now, this.shown) : null;
    if (next && this.planned && next.key === this.planned.key && next.at === this.planned.at)
      return;
    this.clear();
    if (!next) return;
    this.planned = next;
    this.timer = this.options.clock.setTimeout(() => this.fire(next), Math.max(0, next.at - now));
  }

  private fire(reminder: PlannedReminder): void {
    this.timer = null;
    if (this.stopped || this.planned?.key !== reminder.key) return;
    this.planned = null;
    this.shown.add(reminder.key);
    if (this.shown.size > SHOWN_MAX) {
      const oldest = this.shown.values().next().value;
      if (oldest !== undefined) this.shown.delete(oldest);
    }
    try {
      if (!isStale(reminder, this.options.clock.now()))
        this.options.show(reminderContent(reminder));
    } finally {
      this.plan();
    }
  }

  /** After a suspend timers ran late: plan from the wall clock again. */
  resume(): void {
    if (this.stopped) return;
    this.clear();
    this.plan();
  }
}

/** A reminder whose moment passed while the computer slept is dropped. */
export function isStale(reminder: PlannedReminder, nowMs: number): boolean {
  if (reminder.schedule) return nowMs >= reminder.schedule.startsAt;
  return nowMs - reminder.at > 60_000;
}
