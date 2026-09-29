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
 * never shows the pre-write state. The floor only holds for `VERSION_FLOOR_TTL_MS` after the
 * write and only within the epoch it was raised in: a guardian that restarted with a lower
 * version (lazy save, reinstall, recovered log) is shown again within seconds.
 * `apiVersion !== 1` sets the link `down` / `incompatible`.
 *
 * Link watchdog (the «guardian down → warning within 5 s» budget): while a window is visible
 * and the link is `ok`, a run that has not answered `LINK_WATCHDOG_MS` after the last success
 * (and at least `LINK_WATCHDOG_MIN_MS` after it started) sets the link `down` / `timeout`
 * without waiting for the request's own 3 s timeout. A run started when the last success is
 * older than the visible cadence (a show after a hidden period) sets the link `connecting`
 * («Conectando…») if it has not answered `CHECKING_DELAY_MS` later, so the footer and the
 * tray never claim «Guardián activo» on stale knowledge.
 */
import {
  GUARDIAN_API_VERSION,
  GuardianApiError,
  type GuardianClient,
  type GuardianStateResponse,
  type HealthResponse,
} from '@centrate/shared/guardian-api';
import { UI_TIMINGS, toUiError, type UiSnapshot } from '../../shared/ui-state';
import type { Clock, RefreshReason, TimerHandle } from '../contracts';
import { withTimeout } from './client';
import { incompatibleLink, linkOnFailure, linkOnSuccess } from './link';
import type { SnapshotStore } from './store';

/** A write's floor only guards polls that could have raced it (a few seconds). */
export const VERSION_FLOOR_TTL_MS = 10_000;

export interface VersionFloorDeps {
  /** Wall clock (the core's clock). */
  now(): number;
  /** Epoch of the state the app holds when the write returns (`null`: none yet). */
  epoch(): string | null;
}

const DEFAULT_FLOOR_DEPS: VersionFloorDeps = { now: () => Date.now(), epoch: () => null };

/**
 * Highest `stateVersion` returned by a write (201 create, extend, emergency…), tied to the
 * epoch it was raised in and expiring `VERSION_FLOOR_TTL_MS` after the last raise, so a
 * guardian whose version went backwards (restart after a lazy save, reinstall, new epoch) is
 * never hidden for long.
 */
export class VersionFloor {
  private value = 0;
  private epoch: string | null = null;
  private raisedAt: number | null = null;

  constructor(private readonly deps: VersionFloorDeps = DEFAULT_FLOOR_DEPS) {}

  /** The floor value while it still applies, else 0. */
  get(): number {
    return this.live(this.deps.now()) ? this.value : 0;
  }

  raise(version: number): void {
    const now = this.deps.now();
    const epoch = this.deps.epoch();
    const fresh = this.live(now) && (this.epoch === null || epoch === null || epoch === this.epoch);
    if (fresh && version <= this.value) return;
    this.value = version;
    this.epoch = epoch;
    this.raisedAt = now;
  }

  /** `false` when `state` predates a write that may have raced the poll that fetched it. */
  admits(state: Pick<GuardianStateResponse, 'stateVersion' | 'epoch'>): boolean {
    if (!this.live(this.deps.now())) return true;
    if (this.epoch !== null && state.epoch !== this.epoch) return true;
    return state.stateVersion >= this.value;
  }

  private live(now: number): boolean {
    return (
      this.raisedAt !== null && now - this.raisedAt <= VERSION_FLOOR_TTL_MS && now >= this.raisedAt
    );
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
/** Visible and `ok`: no answer this long after the last success → `down` / `timeout`. */
export const LINK_WATCHDOG_MS = 4_000;
/** …but never sooner than this after the run started (a show after a hidden period). */
export const LINK_WATCHDOG_MIN_MS = 2_000;
/** A run on stale knowledge unanswered this long → `connecting` («Conectando…»). */
export const CHECKING_DELAY_MS = 300;

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
  /** Last answer from the guardian (health or state, 200 or 304). */
  private lastSuccessAt: number | null = null;
  private watchdog: TimerHandle | null = null;
  private checking: TimerHandle | null = null;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.refreshNow('start');
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.clearWatchdog();
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

  private clearWatchdog(): void {
    for (const t of [this.watchdog, this.checking]) {
      if (t !== null) this.deps.clock.clearTimeout(t);
    }
    this.watchdog = null;
    this.checking = null;
  }

  /** See «Link watchdog» in the header. Only while visible with the link `ok`. */
  private armWatchdog(startedAt: number): void {
    const { clock, store } = this.deps;
    this.clearWatchdog();
    if (!this.deps.visible() || store.get().link.status !== 'ok') return;
    const lastOk = this.lastSuccessAt ?? startedAt;
    const deadline = Math.max(lastOk + LINK_WATCHDOG_MS, startedAt + LINK_WATCHDOG_MIN_MS);
    this.watchdog = clock.setTimeout(() => {
      this.watchdog = null;
      if (this.stopped || !this.inflight) return;
      this.fail(new GuardianApiError(0, 'timeout', 'guardian did not answer in time'));
    }, deadline - startedAt);
    if (startedAt - lastOk <= UI_TIMINGS.statePollVisibleMs + UI_TIMINGS.linkRetryMs) return;
    this.checking = clock.setTimeout(() => {
      this.checking = null;
      if (this.stopped || !this.inflight) return;
      store.update((s) =>
        s.link.status !== 'ok'
          ? s
          : { ...s, link: { ...s.link, status: 'connecting', reason: null, since: clock.now() } },
      );
    }, CHECKING_DELAY_MS);
  }

  private async run(reason: RefreshReason): Promise<void> {
    this.inflight = true;
    this.lastRunAt = this.deps.clock.now();
    this.armWatchdog(this.lastRunAt);
    try {
      if (this.healthDue(reason)) {
        const healthy = await this.pollHealth();
        if (!healthy) return;
      }
      await this.pollState();
    } finally {
      this.clearWatchdog();
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
    return this.deps.visible() && this.deps.clock.now() - this.lastHealthAt >= HEALTH_INTERVAL_MS;
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
    this.lastSuccessAt = this.lastHealthAt;
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
    this.lastSuccessAt = now;
    const current = store.get();
    const wasUp = current.link.status === 'ok';
    this.retryPending = false;
    const step = linkOnSuccess(current.link, now);
    this.failures = step.failures;
    let link = step.link;
    let next: GuardianStateResponse | null = null;
    // A body older than a recent write's `stateVersion` raced that write: keep the newer state.
    if (!result.notModified && floor.admits(result.state)) {
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
