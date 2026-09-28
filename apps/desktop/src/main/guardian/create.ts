/**
 * «Bloqueando…» (docs/DESKTOP.md §6.2, PROMPT §10 «Nada aparece como activo hasta que el
 * guardián lo confirma»).
 *
 * 1. `ops.create = sending` is published at once: every window shows «Bloqueando…».
 * 2. `POST /v1/blocks` with `Idempotency-Key: intentId` and a 3 s timeout.
 * 3. On the 201, in **one** publish: `create` cleared, `lastCreated` set, the returned block
 *    inserted into `state.blocks` (sorted by `endsAt` desc) and `prefs.lastReason` updated;
 *    the version floor is raised first so a racing poll never shows the pre-create state.
 * 4. Timeout or unreachable: `failed` («El guardián no responde · Reintentar · Reparar»).
 *    «Reintentar» resends the **same request with the same key**: a create that landed
 *    during the timeout replays its stored 201 and is never duplicated.
 * 5. A guardian 4xx: `failed` with a `rejected` error (the card stays editable).
 */
import type { Block, BlockId } from '@centrate/shared/domain';
import { isCreateBlockRequest, type GuardianClient } from '@centrate/shared/guardian-api';
import {
  UI_TIMINGS,
  fail,
  isGuardianUnresponsive,
  isIntentId,
  ok,
  toUiError,
  uiError,
  type CommandResult,
  type IntentId,
  type PendingCreate,
  type UiSnapshot,
} from '../../shared/ui-state';
import type { Clock } from '../contracts';
import { withTimeout } from './client';
import type { VersionFloor } from './poller';
import type { SnapshotStore } from './store';

export type CreateResult = CommandResult<{ blockId: BlockId }>;

export interface CreateDeps {
  clock: Clock;
  client: GuardianClient;
  store: SnapshotStore;
  floor: VersionFloor;
  tokenMissing: () => boolean;
  /** After the 201 publish: persist `lastReason`, refresh the state, kick the event sync. */
  onCreated: (block: Block, reason: string) => void;
  /** The guardian did not answer: poll now so the link (section 1) follows. */
  onUnresponsive: () => void;
}

/** `blocks` with `block` inserted (or replaced), sorted by `endsAt` descending. */
export function insertBlockSorted(blocks: readonly Block[], block: Block): Block[] {
  const others = blocks.filter((b) => b.id !== block.id);
  return [...others, block].sort((a, b) => Date.parse(b.endsAt) - Date.parse(a.endsAt));
}

export class CreateOperation {
  private inflight: { intentId: IntentId; promise: Promise<CreateResult> } | null = null;

  constructor(private readonly deps: CreateDeps) {}

  create(intentId: unknown, request: unknown): Promise<CreateResult> {
    if (!isIntentId(intentId) || !isCreateBlockRequest(request)) {
      return Promise.resolve(fail(uiError('rejected', 'validation_failed', 422)));
    }
    const current = this.deps.store.get().ops.create;
    if (current && current.intentId === intentId) return this.retry(intentId);
    if (current && current.status === 'sending') {
      return Promise.resolve(fail(uiError('rejected', 'create_in_progress', 409)));
    }
    const link = this.deps.store.get().link;
    const pending: PendingCreate = {
      intentId,
      request,
      status: 'sending',
      startedAt: this.deps.clock.now(),
      attempts: 1,
      error: null,
    };
    if (link.status === 'down' && (link.reason === 'unreachable' || link.reason === 'not_installed')) {
      // Fail fast: the connection is already known to be refused.
      const error = uiError(link.reason, link.reason);
      this.setCreate({ ...pending, status: 'failed', error });
      return Promise.resolve(fail(error));
    }
    this.setCreate(pending);
    return this.send(pending);
  }

  /** «Reintentar»: same request, same key. */
  retry(intentId: unknown): Promise<CreateResult> {
    const current = this.deps.store.get().ops.create;
    if (!isIntentId(intentId) || !current || current.intentId !== intentId) {
      return Promise.resolve(fail(uiError('rejected', 'not_found', 404)));
    }
    if (this.inflight && this.inflight.intentId === intentId) return this.inflight.promise;
    const next: PendingCreate = {
      ...current,
      status: 'sending',
      attempts: current.attempts + 1,
      error: null,
    };
    this.setCreate(next);
    return this.send(next);
  }

  /**
   * A `sending` create already in the snapshot (harness load) is really sent, with its key,
   * so the fixture completes on `advance`.
   */
  adoptPending(): void {
    const current = this.deps.store.get().ops.create;
    if (!current || current.status !== 'sending' || this.inflight) return;
    void this.send(current);
  }

  /** Esc on a failed card: forget it (a sending create cannot be dismissed). */
  dismiss(intentId: unknown): void {
    this.deps.store.update((s) => {
      const c = s.ops.create;
      if (!c || c.intentId !== intentId || c.status !== 'failed') return s;
      return { ...s, ops: { ...s.ops, create: null } };
    });
  }

  private setCreate(create: PendingCreate | null): void {
    this.deps.store.update((s) => ({ ...s, ops: { ...s.ops, create } }));
  }

  private send(pending: PendingCreate): Promise<CreateResult> {
    const promise = this.doSend(pending).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { intentId: pending.intentId, promise };
    return promise;
  }

  private async doSend(pending: PendingCreate): Promise<CreateResult> {
    const { clock, client, store, floor } = this.deps;
    try {
      const response = await withTimeout(
        client.createBlock(pending.request, { idempotencyKey: pending.intentId }),
        clock,
        UI_TIMINGS.requestTimeoutMs,
      );
      floor.raise(response.stateVersion);
      const reason = pending.request.reason.trim();
      store.update((s) => confirmCreate(s, pending.intentId, response.block, reason));
      this.deps.onCreated(response.block, reason);
      return ok({ blockId: response.block.id });
    } catch (error) {
      const uiErr = toUiError(error, { clientJsonMissing: this.deps.tokenMissing() });
      store.update((s) => {
        const c = s.ops.create;
        if (!c || c.intentId !== pending.intentId) return s;
        return { ...s, ops: { ...s.ops, create: { ...c, status: 'failed', error: uiErr } } };
      });
      if (isGuardianUnresponsive(uiErr)) this.deps.onUnresponsive();
      return fail(uiErr);
    }
  }
}

/** The 201 publish: one snapshot with the block active and the card's create closed. */
export function confirmCreate(
  s: UiSnapshot,
  intentId: IntentId,
  block: Block,
  reason: string,
): UiSnapshot {
  const create = s.ops.create && s.ops.create.intentId === intentId ? null : s.ops.create;
  return {
    ...s,
    state: s.state ? { ...s.state, blocks: insertBlockSorted(s.state.blocks, block) } : s.state,
    ops: { ...s.ops, create, lastCreated: { intentId, blockId: block.id } },
    prefs: reason !== '' && reason !== s.prefs.lastReason ? { ...s.prefs, lastReason: reason } : s.prefs,
  };
}
