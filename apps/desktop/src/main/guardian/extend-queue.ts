/**
 * The 5 s extend queue (docs/DESKTOP.md §6.3, ARCHITECTURE §8.8 «Undo contract»).
 *
 * - Nothing reaches the guardian before `commitAt` (click + 5 s). «Deshacer» removes a
 *   `waiting` entry; after `commitAt` it answers `too_late` («Ya ampliado»).
 * - Clicks on a block that already has a `waiting` entry add up and restart the 5 s
 *   (+15 then +30 = «+45 min · termina a las 18:27»).
 * - A click is refused locally when the block is a punishment (`not_extendable`) or when
 *   remaining + queued + added would pass 24 h (`extension_exceeds_max`, `maxExtendMinutes`).
 * - At `commitAt` the entry becomes `sending` and gets its `Idempotency-Key`, generated then
 *   and reused by every retry: two automatic retries (1 s, 2 s) on a timeout or refused
 *   connection, then `failed` («No se pudo ampliar · Reintentar»).
 * - A guardian refusal the same request can never overturn (any 4xx but 429: 409
 *   `block_not_active` / `not_extendable`, 422 `extension_exceeds_max`, 404…) drops the entry
 *   and returns the error (the renderer shows its `errorCopy`); only an answer that a retry
 *   can change (timeout, unreachable, 429, 401, 503, 5xx) leaves a `failed` entry.
 * - A `failed` entry never lingers: a new click on the same block drops it (the user moved
 *   on, and its minutes no longer count against the 24 h), `dismiss()` drops it, and it
 *   expires `EXTEND_FAILED_TTL_MS` after failing.
 * - On 200 the entry leaves the queue and the returned block replaces the old one in the
 *   same publish (after raising the version floor). The countdown only ever shows the
 *   guardian's `endsAt`; `projectedEndsAt` is for the undo line alone.
 * - The queue lives in main: hiding the window keeps it, the tray «Ampliar ▸» uses it, and
 *   `flush()` («Salir») sends waiting entries at once (the user asked and did not undo).
 */
import type { BlockId } from '@centrate/shared/domain';
import { isIdOf } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  type GuardianClient,
  type GuardianStateResponse,
} from '@centrate/shared/guardian-api';
import {
  UI_TIMINGS,
  fail,
  isGuardianUnresponsive,
  maxExtendMinutes,
  ok,
  toUiError,
  uiError,
  type CommandResult,
  type ExtendEntry,
  type UiError,
  type UiSnapshot,
} from '../../shared/ui-state';
import type { Clock, TimerHandle } from '../contracts';
import { sleep } from './clock';
import { withTimeout } from './client';
import { insertBlockSorted } from './create';
import type { VersionFloor } from './poller';
import type { SnapshotStore } from './store';

/** Waits before the automatic retries of a timed-out or refused extension. */
export const EXTEND_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];

/** A `failed` entry («No se pudo ampliar · Reintentar») leaves the queue this long after failing. */
export const EXTEND_FAILED_TTL_MS = 60_000;

/**
 * A guardian refusal that resending the same request (same key and body, judged again) can
 * never overturn. 429 `rate_limited` is the one 4xx a later «Reintentar» can pass.
 */
export function isFinalExtendRefusal(error: UiError): boolean {
  return error.kind === 'rejected' && error.code !== 'rate_limited';
}

const ENTRY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isExtendEntryId(value: unknown): value is string {
  return typeof value === 'string' && ENTRY_ID_RE.test(value);
}

export interface ExtendDeps {
  clock: Clock;
  client: GuardianClient;
  store: SnapshotStore;
  floor: VersionFloor;
  /** Idempotency key (generated when an entry becomes due). */
  newKey: () => string;
  newEntryId: () => string;
  /** After a 200: refresh the state, kick the event sync. */
  onExtended: () => void;
  /** Retries exhausted on a timeout or refused connection. */
  onUnresponsive: () => void;
  /** A final refusal dropped the entry (e.g. `block_not_active`: refresh the state). */
  onRefused: (error: UiError) => void;
}

interface EntryRuntime {
  /** `waiting`: the commit at `commitAt`; `failed`: the expiry after `EXTEND_FAILED_TTL_MS`. */
  timer: TimerHandle | null;
  key: string | null;
  sending: Promise<CommandResult<null>> | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class ExtendQueue {
  private readonly runtime = new Map<string, EntryRuntime>();
  private stopped = false;

  constructor(private readonly deps: ExtendDeps) {}

  /** Arm timers for entries already in the snapshot (harness load). */
  adopt(): void {
    for (const entry of this.deps.store.get().ops.extendQueue) {
      if (entry.status === 'waiting') this.arm(entry);
      else if (entry.status === 'failed') this.armExpiry(entry.id);
    }
  }

  extend(
    blockId: unknown,
    addMinutes: unknown,
  ): CommandResult<{ entryId: string; commitAt: number }> {
    if (
      !isIdOf('block', blockId) ||
      typeof addMinutes !== 'number' ||
      !Number.isInteger(addMinutes) ||
      addMinutes < 1 ||
      addMinutes > GUARDIAN_LIMITS.extendMaxAddMinutes
    ) {
      return fail(uiError('rejected', 'validation_failed', 422));
    }
    const id = blockId as BlockId;
    const { clock, store } = this.deps;
    const now = clock.now();
    const s = store.get();
    const block = s.state?.blocks.find((b) => b.id === id) ?? null;
    if (!block) return fail(uiError('rejected', 'block_not_active', 409));
    if (block.kind === 'punishment') return fail(uiError('rejected', 'not_extendable', 409));
    // An accepted click drops this block's failed entries: they no longer count.
    const stale = new Set(
      s.ops.extendQueue.filter((e) => e.blockId === id && e.status === 'failed').map((e) => e.id),
    );
    const live =
      stale.size === 0
        ? s.ops
        : { ...s.ops, extendQueue: s.ops.extendQueue.filter((e) => !stale.has(e.id)) };
    const max = maxExtendMinutes(block, live, now);
    if (addMinutes > max) {
      return fail(uiError('rejected', 'extension_exceeds_max', 422, { maxAddMinutes: max }));
    }
    const commitAt = now + UI_TIMINGS.extendUndoMs;
    const waiting = s.ops.extendQueue.find((e) => e.blockId === id && e.status === 'waiting');
    const total = (waiting?.addMinutes ?? 0) + addMinutes;
    const entry: ExtendEntry = {
      id: waiting?.id ?? this.deps.newEntryId(),
      blockId: id,
      addMinutes: total,
      createdAt: waiting?.createdAt ?? now,
      commitAt,
      projectedEndsAt: iso(Date.parse(block.endsAt) + total * 60_000),
      status: 'waiting',
      error: null,
    };
    for (const staleId of stale) this.forget(staleId);
    store.update((snap) => withEntry(withoutEntries(snap, stale), entry));
    this.arm(entry);
    return ok({ entryId: entry.id, commitAt });
  }

  /** «Deshacer». */
  undo(entryId: unknown): 'undone' | 'too_late' {
    const entry = this.find(entryId);
    if (!entry || entry.status !== 'waiting') return 'too_late';
    this.disarm(entry.id);
    this.runtime.delete(entry.id);
    this.deps.store.update((s) => withoutEntry(s, entry.id));
    return 'undone';
  }

  /** «Reintentar» on a failed entry (same key). */
  retry(entryId: unknown): Promise<CommandResult<null>> {
    const entry = this.find(entryId);
    if (!entry) return Promise.resolve(fail(uiError('rejected', 'not_found', 404)));
    const rt = this.rt(entry.id);
    if (entry.status === 'sending' && rt.sending) return rt.sending;
    if (entry.status !== 'failed')
      return Promise.resolve(fail(uiError('rejected', 'not_failed', 409)));
    this.disarm(entry.id);
    this.setStatus(entry.id, 'sending', null);
    return this.send(entry.id);
  }

  /**
   * Drops a `failed` entry without resending it (Esc or «Descartar» on «No se pudo ampliar»,
   * once a channel exists). `false` when the entry is not failed (any more).
   */
  dismiss(entryId: unknown): boolean {
    const entry = this.find(entryId);
    if (!entry || entry.status !== 'failed') return false;
    this.drop(entry.id);
    return true;
  }

  /** Commit every waiting entry now and wait for the sends («Salir»). */
  async flush(): Promise<void> {
    const waiting = this.deps.store.get().ops.extendQueue.filter((e) => e.status === 'waiting');
    const sends = waiting.map((e) => this.commit(e.id));
    const inflight = [...this.runtime.values()]
      .map((r) => r.sending)
      .filter((p): p is Promise<CommandResult<null>> => p !== null);
    await Promise.allSettled([...sends, ...inflight]);
  }

  /**
   * A new guardian state: entries of blocks that are no longer active leave the queue (the
   * guardian would answer `block_not_active`), and waiting projections follow `endsAt`.
   */
  reconcile(state: GuardianStateResponse): void {
    const blocks = new Map(state.blocks.map((b) => [b.id, b] as const));
    for (const entry of this.deps.store.get().ops.extendQueue) {
      if (!blocks.has(entry.blockId) && entry.status !== 'sending') this.forget(entry.id);
    }
    this.deps.store.update((s) => {
      let changed = false;
      const queue: ExtendEntry[] = [];
      for (const entry of s.ops.extendQueue) {
        const block = blocks.get(entry.blockId);
        if (!block) {
          if (entry.status === 'sending') queue.push(entry);
          else changed = true;
          continue;
        }
        if (entry.status === 'waiting') {
          const projectedEndsAt = iso(Date.parse(block.endsAt) + entry.addMinutes * 60_000);
          if (projectedEndsAt !== entry.projectedEndsAt) {
            changed = true;
            queue.push({ ...entry, projectedEndsAt });
            continue;
          }
        }
        queue.push(entry);
      }
      return changed ? { ...s, ops: { ...s.ops, extendQueue: queue } } : s;
    });
  }

  stop(): void {
    this.stopped = true;
    for (const id of this.runtime.keys()) this.disarm(id);
  }

  private find(entryId: unknown): ExtendEntry | null {
    if (!isExtendEntryId(entryId)) return null;
    return this.deps.store.get().ops.extendQueue.find((e) => e.id === entryId) ?? null;
  }

  private rt(id: string): EntryRuntime {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = { timer: null, key: null, sending: null };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  private arm(entry: ExtendEntry): void {
    if (this.stopped) return;
    const rt = this.rt(entry.id);
    this.disarm(entry.id);
    const delay = Math.max(0, entry.commitAt - this.deps.clock.now());
    rt.timer = this.deps.clock.setTimeout(() => {
      rt.timer = null;
      void this.commit(entry.id);
    }, delay);
  }

  private disarm(id: string): void {
    const rt = this.runtime.get(id);
    if (rt?.timer) {
      this.deps.clock.clearTimeout(rt.timer);
      rt.timer = null;
    }
  }

  /** A failed entry leaves the queue `EXTEND_FAILED_TTL_MS` from now, unless retried. */
  private armExpiry(id: string): void {
    if (this.stopped) return;
    const rt = this.rt(id);
    this.disarm(id);
    rt.timer = this.deps.clock.setTimeout(() => {
      rt.timer = null;
      const entry = this.deps.store.get().ops.extendQueue.find((e) => e.id === id);
      if (entry?.status === 'failed') this.drop(id);
    }, EXTEND_FAILED_TTL_MS);
  }

  /** Stop the entry's timer and forget its key (the entry leaves the queue). */
  private forget(id: string): void {
    this.disarm(id);
    this.runtime.delete(id);
  }

  private drop(id: string): void {
    this.forget(id);
    this.deps.store.update((s) => withoutEntry(s, id));
  }

  private commit(id: string): Promise<CommandResult<null>> {
    const entry = this.deps.store.get().ops.extendQueue.find((e) => e.id === id);
    if (!entry || entry.status !== 'waiting') {
      return this.runtime.get(id)?.sending ?? Promise.resolve(ok(null));
    }
    this.disarm(id);
    const rt = this.rt(id);
    rt.key ??= this.deps.newKey();
    this.setStatus(id, 'sending', null);
    return this.send(id);
  }

  private send(id: string): Promise<CommandResult<null>> {
    const rt = this.rt(id);
    const promise = this.doSend(id).finally(() => {
      if (rt.sending === promise) rt.sending = null;
    });
    rt.sending = promise;
    return promise;
  }

  private async doSend(id: string): Promise<CommandResult<null>> {
    const { clock, client, store, floor } = this.deps;
    const rt = this.rt(id);
    rt.key ??= this.deps.newKey();
    const key = rt.key;
    for (let attempt = 0; ; attempt += 1) {
      const entry = store.get().ops.extendQueue.find((e) => e.id === id);
      if (!entry) return ok(null);
      try {
        const response = await withTimeout(
          client.extendBlock(
            entry.blockId,
            { addMinutes: entry.addMinutes },
            { idempotencyKey: key },
          ),
          clock,
          UI_TIMINGS.requestTimeoutMs,
        );
        floor.raise(response.stateVersion);
        store.update((s) => {
          const next = withoutEntry(s, id);
          if (!next.state) return next;
          return {
            ...next,
            state: { ...next.state, blocks: insertBlockSorted(next.state.blocks, response.block) },
          };
        });
        this.runtime.delete(id);
        this.deps.onExtended();
        return ok(null);
      } catch (error) {
        const uiErr = toUiError(error);
        const delay = EXTEND_RETRY_DELAYS_MS[attempt];
        if (isGuardianUnresponsive(uiErr) && delay !== undefined && !this.stopped) {
          await sleep(clock, delay).promise;
          continue;
        }
        if (isFinalExtendRefusal(uiErr)) {
          // Same key and body would get the same answer: no «Reintentar», nothing lingers.
          this.drop(id);
          this.deps.onRefused(uiErr);
          return fail(uiErr);
        }
        this.setStatus(id, 'failed', uiErr);
        this.armExpiry(id);
        if (isGuardianUnresponsive(uiErr)) this.deps.onUnresponsive();
        return fail(uiErr);
      }
    }
  }

  private setStatus(id: string, status: ExtendEntry['status'], error: UiError | null): void {
    this.deps.store.update((s) => {
      const entry = s.ops.extendQueue.find((e) => e.id === id);
      if (!entry || (entry.status === status && entry.error === error)) return s;
      return withEntry(s, { ...entry, status, error });
    });
  }
}

function withEntry(s: UiSnapshot, entry: ExtendEntry): UiSnapshot {
  const exists = s.ops.extendQueue.some((e) => e.id === entry.id);
  const extendQueue = exists
    ? s.ops.extendQueue.map((e) => (e.id === entry.id ? entry : e))
    : [...s.ops.extendQueue, entry];
  return { ...s, ops: { ...s.ops, extendQueue } };
}

function withoutEntry(s: UiSnapshot, id: string): UiSnapshot {
  return withoutEntries(s, new Set([id]));
}

function withoutEntries(s: UiSnapshot, ids: ReadonlySet<string>): UiSnapshot {
  if (ids.size === 0 || !s.ops.extendQueue.some((e) => ids.has(e.id))) return s;
  return { ...s, ops: { ...s.ops, extendQueue: s.ops.extendQueue.filter((e) => !ids.has(e.id)) } };
}
