/**
 * `/v1/state` + `/v1/health` poller (docs/DESKTOP.md §6.1).
 *
 * Cadence (one `setTimeout` chain on the injected clock, never overlapping):
 * - any window visible: `getState({etag})` every 2 s; hidden: every 60 s (10 s while the
 *   guardian is down, so the tray notices it came back);
 * - always: at the earliest future block end + 300 ms (and the boot-hold end), so «Hecho» and
 *   the tray follow within about a second;
 * - `refreshNow(reason)`: after writes, on show, resume, each event batch and link retries;
 * - `health()` at start, while the link is not ok, and every 60 s while visible.
 *
 * A 304 only confirms the link (nothing is published). A body older than the highest
 * `stateVersion` a write returned (`VersionFloor`) is dropped, so a poll that raced a write
 * never shows the pre-write state. `apiVersion !== 1` sets the link `down` / `incompatible`.
 */
import {
  GUARDIAN_API_VERSION,
  type GuardianClient,
  type GuardianStateResponse,
  type HealthResponse,
} from '@centrate/shared/guardian-api';
import { UI_TIMINGS, toUiError, type UiSnapshot } from '../../shared/ui-state';
import type { Clock, RefreshReason, TimerHandle } from '../contracts';
import { withTimeout } from './client';
import { incompatibleLink, linkOnFailure, linkOnSuccess } from './link';
import type { SnapshotStore } from './store';

/** Highest `stateVersion` returned by a write (201 create, extend, emergency…). */
export class VersionFloor {
  private value = 0;
  get(): number {
    return this.value;
  }
  raise(version: number): void {
    if (version > this.value) this.value = version;
  }
}

export interface PollerDeps {
  clock: Clock;
  client: GuardianClient;
  store: SnapshotStore;
  floor: VersionFloor;
  /** `client.json` is missing (a refused connection then reads as «not installed»). */
  tokenMissing: () => boolean;
  /** Any Céntrate window visible. */
  visible: () => boolean;
  /** After every publish of a new `state` (extend-queue pruning, five-minute timer). */
  onState?: (state: GuardianStateResponse, previous: GuardianStateResponse | null) => void;
  /** After every successful health call (guardian version check). */
  onHealth?: (health: HealthResponse) => void;
  /** Link went from not-ok to ok (event sync kick). */
  onLinkUp?: () => void;
}

export const HEALTH_INTERVAL_MS = 60_000;
/** Hidden with the guardian down: look again this often, so the tray recovers quickly. */
export const HIDDEN_DOWN_POLL_MS = 10_000;

export class Poller {
  private timer: TimerHandle | null = null;
  private inflight = false;
  private again: RefreshReason | null = null;
  private stopped = true;
  private failures = 0;
  private retryPending = false;
  private etag: string | null = null;
  private lastHealthAt: number | null = null;
  private lastRunAt: number | null = null;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.refreshNow('start');
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  /** Harness: the seeded snapshot already holds this ETag's state (first poll is a 304). */
  setEtag(etag: string | null): void {
    this.etag = etag;
  }

  /** Poll now (or right after the poll in flight). */
  refreshNow(reason: RefreshReason): void {
    if (this.stopped) return;
    if (this.inflight) {
      this.again = reason;
      return;
    }
    this.clearTimer();
    void this.run(reason);
  }

  /** Visibility changed: re-plan the next poll from the last one. */
  reschedule(): void {
    if (this.stopped || this.inflight) return;
    this.schedule();
  }

  /** Delay until the next poll (exported for tests through `nextDelay`). */
  nextDelay(): number {
    const now = this.deps.clock.now();
    if (this.retryPending) return UI_TIMINGS.linkRetryMs;
    const linkUp = this.deps.store.get().link.status === 'ok';
    const cadence = this.deps.visible()
      ? UI_TIMINGS.statePollVisibleMs
      : linkUp
        ? UI_TIMINGS.statePollHiddenMs
        : HIDDEN_DOWN_POLL_MS;
    const since = this.lastRunAt === null ? cadence : now - this.lastRunAt;
    let delay = Math.max(0, cadence - since);
    const endDue = nextEndDue(this.deps.store.get(), now);
    if (endDue !== null) delay = Math.min(delay, Math.max(0, endDue - now));
    return delay;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (this.stopped) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null;
      void this.run('poll');
    }, this.nextDelay());
  }

  private async run(reason: RefreshReason): Promise<void> {
    this.inflight = true;
    this.lastRunAt = this.deps.clock.now();
    try {
      if (this.healthDue(reason)) {
        const healthy = await this.pollHealth();
        if (!healthy) return;
      }
      await this.pollState();
    } finally {
      this.inflight = false;
      if (!this.stopped) {
        const again = this.again;
        this.again = null;
        if (again !== null) void this.run(again);
        else this.schedule();
      }
    }
  }

  private healthDue(reason: RefreshReason): boolean {
    if (reason === 'start' || this.lastHealthAt === null) return true;
    const snapshot = this.deps.store.get();
    if (snapshot.link.status !== 'ok') return true;
    return (
      this.deps.visible() && this.deps.clock.now() - this.lastHealthAt >= HEALTH_INTERVAL_MS
    );
  }

  /** `false` when the state call should be skipped (failure or incompatible API). */
  private async pollHealth(): Promise<boolean> {
    const { clock, client, store } = this.deps;
    let health: HealthResponse;
    try {
      health = await withTimeout(client.health(), clock, UI_TIMINGS.requestTimeoutMs);
    } catch (error) {
      if (this.stopped) return false;
      this.fail(error);
      return false;
    }
    if (this.stopped) return false;
    this.lastHealthAt = clock.now();
    const compatible = health.apiVersion === GUARDIAN_API_VERSION;
    store.update((s) => {
      const sameHealth = s.health !== null && sameHealthIgnoringClock(s.health, health);
      const link = compatible ? s.link : incompatibleLink(s.link, clock.now());
      if (sameHealth && link === s.link) return s;
      return { ...s, health: sameHealth ? s.health : health, link };
    });
    this.deps.onHealth?.(health);
    return compatible;
  }

  private async pollState(): Promise<void> {
    const { clock, client, store, floor } = this.deps;
    const before = store.get();
    const etag = before.state === null ? null : this.etag;
    let result: Awaited<ReturnType<GuardianClient['getState']>>;
    try {
      result = await withTimeout(client.getState({ etag }), clock, UI_TIMINGS.requestTimeoutMs);
    } catch (error) {
      if (this.stopped) return;
      this.fail(error);
      return;
    }
    if (this.stopped) return;
    const now = clock.now();
    const current = store.get();
    const wasUp = current.link.status === 'ok';
    this.retryPending = false;
    const step = linkOnSuccess(current.link, now);
    this.failures = step.failures;
    let link = step.link;
    let next: GuardianStateResponse | null = null;
    // A body older than a write's `stateVersion` raced that write: keep the newer state.
    if (!result.notModified && result.state.stateVersion >= floor.get()) {
      next = result.state;
      this.etag = result.etag;
      if (next.guardian.apiVersion !== GUARDIAN_API_VERSION) link = incompatibleLink(link, now);
    }
    const previous = current.state;
    const published = next;
    store.update((s) => {
      if (published === null) return link === s.link ? s : { ...s, link };
      return { ...s, link, state: published, stateReceivedAt: now };
    });
    if (published !== null) this.deps.onState?.(published, previous);
    if (!wasUp && store.get().link.status === 'ok') this.deps.onLinkUp?.();
  }

  private fail(error: unknown): void {
    const { clock, store } = this.deps;
    const uiErr = toUiError(error, { clientJsonMissing: this.deps.tokenMissing() });
    const step = linkOnFailure(store.get().link, this.failures, uiErr, clock.now());
    this.failures = step.failures;
    this.retryPending = step.retry;
    store.update((s) => (step.link === s.link ? s : { ...s, link: step.link }));
  }
}

/** Earliest future «end + 300 ms» among active blocks and the boot hold, or `null`. */
export function nextEndDue(snapshot: UiSnapshot, nowMs: number): number | null {
  const state = snapshot.state;
  if (!state) return null;
  let due: number | null = null;
  const consider = (iso: string | null): void => {
    if (iso === null) return;
    const at = Date.parse(iso) + UI_TIMINGS.blockEndRefreshDelayMs;
    if (Number.isFinite(at) && at > nowMs && (due === null || at < due)) due = at;
  };
  for (const block of state.blocks) consider(block.endsAt);
  consider(state.clock.bootHoldUntil);
  consider(state.emergency?.readyAt ?? null);
  return due;
}

function sameHealthIgnoringClock(a: HealthResponse, b: HealthResponse): boolean {
  return JSON.stringify({ ...a, serverNow: '' }) === JSON.stringify({ ...b, serverNow: '' });
}
