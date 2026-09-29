/**
 * Event-log sync (docs/DESKTOP.md §6.1, ARCHITECTURE §8.8 `/v1/events`).
 *
 * Always on (window visible or not): one long poll at a time,
 * `getEvents({epoch, after, limit: 500, waitMs: hasMore ? 0 : 25 000})`. Each page goes into
 * the local database in one transaction with the cursor (wiped first on `reset`); then the
 * notification policy sees it and the state is refreshed (`onPage`). Failures back off 1, 2,
 * 5, 10, 30 s; `kick()` (resume, writes, link recovery) cuts a backoff short.
 *
 * Pages read before the first caught-up page (`hasMore: false`) are marked `notify: false`,
 * so a long backlog (first sync, a night asleep) never produces a storm of notifications.
 */
import type { EventsResponse, GuardianClient } from '@centrate/shared/guardian-api';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import type { EventsDb } from '../db/events-db';
import type { Clock } from '../contracts';
import { sleep } from './clock';

export const EVENT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
export const EVENTS_PAGE_LIMIT = GUARDIAN_LIMITS.eventsPageDefault;
export const EVENTS_WAIT_MS = GUARDIAN_LIMITS.longPollMaxMs;
/** A long poll that answered empty faster than this waits before the next one (no hot loop). */
export const EMPTY_LONG_POLL_MIN_MS = 1_000;

export interface PageInfo {
  /** Notices may come from this page (it is, or follows, the first caught-up page). */
  notify: boolean;
  inserted: number;
}

export interface EventSyncDeps {
  clock: Clock;
  client: GuardianClient;
  db: EventsDb;
  onPage: (page: EventsResponse, info: PageInfo) => void;
  onError?: (stage: 'fetch' | 'store', error: unknown) => void;
}

export class EventSync {
  private stopped = true;
  private failures = 0;
  private hasMore = false;
  private caughtUp = false;
  private wait: { cancel(): void } | null = null;
  private generation = 0;

  constructor(private readonly deps: EventSyncDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    void this.loop(generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.wait?.cancel();
    this.wait = null;
  }

  /** Retry now if waiting after a failure (resume, a write, the link coming back). */
  kick(): void {
    this.failures = 0;
    this.wait?.cancel();
  }

  /** The first caught-up page was read. */
  isCaughtUp(): boolean {
    return this.caughtUp;
  }

  private alive(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private async pause(ms: number): Promise<void> {
    const s = sleep(this.deps.clock, ms);
    this.wait = s;
    await s.promise;
    if (this.wait === s) this.wait = null;
  }

  private async loop(generation: number): Promise<void> {
    const { clock, client, db } = this.deps;
    while (this.alive(generation)) {
      const cursor = db.cursor();
      const waitMs = this.hasMore ? 0 : EVENTS_WAIT_MS;
      const startedAt = clock.now();
      let page: EventsResponse;
      try {
        page = await client.getEvents({
          ...(cursor.epoch !== null ? { epoch: cursor.epoch } : {}),
          after: cursor.lastSeq,
          limit: EVENTS_PAGE_LIMIT,
          waitMs,
        });
      } catch (error) {
        if (!this.alive(generation)) return;
        this.deps.onError?.('fetch', error);
        await this.backoff();
        continue;
      }
      if (!this.alive(generation)) return;
      // The guardian always resets on an epoch change. A page of another epoch without
      // `reset` (the epoch changed during a long poll) is not applied: the cursor restarts
      // and the next request gets the reset page from the new epoch's start.
      if (!page.reset && cursor.epoch !== null && page.epoch !== cursor.epoch) {
        try {
          db.wipe();
        } catch (error) {
          this.deps.onError?.('store', error);
        }
        this.hasMore = true;
        continue;
      }
      let inserted: number;
      try {
        inserted = db.applyPage(page).inserted;
      } catch (error) {
        this.deps.onError?.('store', error);
        await this.backoff();
        continue;
      }
      this.failures = 0;
      this.hasMore = page.hasMore;
      const notify = this.caughtUp || !page.hasMore;
      if (!page.hasMore) this.caughtUp = true;
      try {
        this.deps.onPage(page, { notify, inserted });
      } catch (error) {
        this.deps.onError?.('store', error);
      }
      if (
        page.events.length === 0 &&
        waitMs > 0 &&
        clock.now() - startedAt < EMPTY_LONG_POLL_MIN_MS &&
        this.alive(generation)
      ) {
        await this.pause(EMPTY_LONG_POLL_MIN_MS);
      }
    }
  }

  private async backoff(): Promise<void> {
    const delay = EVENT_BACKOFF_MS[Math.min(this.failures, EVENT_BACKOFF_MS.length - 1)] ?? 30_000;
    this.failures += 1;
    await this.pause(delay);
  }
}
