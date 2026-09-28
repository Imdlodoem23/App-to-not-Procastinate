import { GuardianApiError, type ExtendBlockRequest } from '@centrate/shared/guardian-api';
import type { BlockId } from '@centrate/shared/domain';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { ExtendQueue } from '../../../src/main/guardian/extend-queue';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { VersionFloor } from '../../../src/main/guardian/poller';
import { createSnapshotStore } from '../../../src/main/guardian/store';
import {
  HARNESS_NOW,
  harnessFixture,
  makeBlock,
  makeGuardianState,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import { prng, run, settle, spyClient } from './helpers';

const MIN = 60_000;

function setup(id: HarnessStateId = 'one-block', snapshot?: UiSnapshot) {
  const fixture = harnessFixture(id);
  const base = snapshot ?? fixture.snapshot;
  const clock = createManualClock(HARNESS_NOW);
  const mock = new MockGuardian({ clock, seed: { state: base.state } });
  const spy = spyClient(mock);
  const store = createSnapshotStore(base);
  let n = 0;
  const queue = new ExtendQueue({
    clock,
    client: spy.client,
    store,
    floor: new VersionFloor(),
    newKey: () => `key-${++n}`,
    newEntryId: () => `entry-${++n}`,
    onExtended: () => undefined,
    onUnresponsive: () => undefined,
  });
  const block = base.state?.blocks[0];
  if (!block) throw new Error('fixture without a block');
  const sent = () =>
    spy.calls
      .filter((c) => c.method === 'extendBlock')
      .map((c) => ({
        blockId: c.args[0] as BlockId,
        add: (c.args[1] as ExtendBlockRequest).addMinutes,
        key: (c.args[2] as { idempotencyKey?: string }).idempotencyKey,
      }));
  return { clock, mock, spy, store, queue, block, sent };
}

describe('extend queue (5 s undo)', () => {
  it('sends nothing before 5 s, then one request; the countdown only moves on the 200', async () => {
    const t = setup();
    const r = t.queue.extend(t.block.id, 30);
    expect(r).toMatchObject({ ok: true, value: { commitAt: HARNESS_NOW + 5_000 } });
    const entry = t.store.get().ops.extendQueue[0];
    expect(entry).toMatchObject({ status: 'waiting', addMinutes: 30 });
    expect(Date.parse(entry?.projectedEndsAt ?? '')).toBe(Date.parse(t.block.endsAt) + 30 * MIN);
    expect(t.store.get().state?.blocks[0]?.endsAt).toBe(t.block.endsAt);
    await run(t.clock, 4_999);
    expect(t.sent()).toHaveLength(0);
    await run(t.clock, 1);
    expect(t.sent()).toEqual([{ blockId: t.block.id, add: 30, key: expect.any(String) }]);
    expect(t.store.get().ops.extendQueue).toHaveLength(0);
    expect(Date.parse(t.store.get().state?.blocks[0]?.endsAt ?? '')).toBe(
      Date.parse(t.block.endsAt) + 30 * MIN,
    );
  });

  it('«Deshacer» before 5 s sends nothing; after that it is too late', async () => {
    const t = setup();
    const r = t.queue.extend(t.block.id, 15);
    if (!r.ok) throw new Error('refused');
    await run(t.clock, 3_000);
    expect(t.queue.undo(r.value.entryId)).toBe('undone');
    await run(t.clock, 10_000);
    expect(t.sent()).toHaveLength(0);
    expect(t.store.get().ops.extendQueue).toHaveLength(0);

    const r2 = t.queue.extend(t.block.id, 15);
    if (!r2.ok) throw new Error('refused');
    await run(t.clock, 5_000);
    expect(t.queue.undo(r2.value.entryId)).toBe('too_late');
    expect(t.sent()).toHaveLength(1);
  });

  it('clicks on the same block add up and restart the 5 s', async () => {
    const t = setup();
    const a = t.queue.extend(t.block.id, 15);
    await run(t.clock, 3_000);
    const b = t.queue.extend(t.block.id, 30);
    expect(a.ok && b.ok && a.value.entryId === b.value.entryId).toBe(true);
    expect(t.store.get().ops.extendQueue).toHaveLength(1);
    expect(t.store.get().ops.extendQueue[0]?.addMinutes).toBe(45);
    await run(t.clock, 4_999);
    expect(t.sent()).toHaveLength(0);
    await run(t.clock, 1);
    expect(t.sent().map((s) => s.add)).toEqual([45]);
  });

  it('retries a timeout twice with the same key, then fails; «Reintentar» keeps the key', async () => {
    const t = setup();
    t.spy.overrides.extendBlock = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    const r = t.queue.extend(t.block.id, 60);
    if (!r.ok) throw new Error('refused');
    await run(t.clock, 5_000 + 1_000 + 2_000);
    const keys = t.sent().map((s) => s.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(t.store.get().ops.extendQueue[0]).toMatchObject({ status: 'failed', error: { kind: 'unreachable' } });
    delete t.spy.overrides.extendBlock;
    const retry = await t.queue.retry(r.value.entryId);
    expect(retry.ok).toBe(true);
    expect(t.sent().map((s) => s.key)).toEqual([keys[0], keys[0], keys[0], keys[0]]);
    expect(t.store.get().ops.extendQueue).toHaveLength(0);
  });

  it('refuses punishments and anything past 24 h remaining', async () => {
    const t = setup('punishment');
    expect(t.queue.extend(t.block.id, 15)).toMatchObject({ ok: false, error: { code: 'not_extendable' } });
    const long = makeBlock({ n: 30, services: ['youtube'], mode: 'normal', leftMs: 1_430 * MIN, elapsedMs: MIN }, HARNESS_NOW);
    const base = harnessFixture('idle').snapshot;
    const snap: UiSnapshot = { ...base, state: makeGuardianState(HARNESS_NOW, { blocks: [long] }) };
    const u = setup('idle', snap);
    expect(u.queue.extend(long.id, 15)).toMatchObject({
      ok: false,
      error: { code: 'extension_exceeds_max', details: { maxAddMinutes: 10 } },
    });
    expect(u.queue.extend(long.id, 5).ok).toBe(true);
    expect(u.queue.extend(long.id, 6)).toMatchObject({ ok: false, error: { code: 'extension_exceeds_max' } });
  });

  it('«Salir» sends the waiting entries at once', async () => {
    const t = setup();
    t.queue.extend(t.block.id, 15);
    await t.queue.flush();
    expect(t.sent().map((s) => s.add)).toEqual([15]);
  });

  it('drops entries of blocks that ended', async () => {
    const t = setup();
    t.queue.extend(t.block.id, 15);
    const state = t.store.get().state;
    if (!state) throw new Error('no state');
    t.queue.reconcile({ ...state, blocks: [] });
    expect(t.store.get().ops.extendQueue).toHaveLength(0);
    await run(t.clock, 10_000);
    expect(t.sent()).toHaveLength(0);
  });

  it('arms fixture entries (harness load)', async () => {
    const t = setup('extend-undo');
    t.queue.adopt();
    await run(t.clock, 3_799);
    expect(t.sent()).toHaveLength(0);
    await run(t.clock, 1);
    expect(t.sent().map((s) => s.add)).toEqual([30]);
  });

  it('property: minutes sent = minutes clicked and not undone', async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const rand = prng(seed);
      const blocks = [
        makeBlock({ n: 40, services: ['youtube'], mode: 'normal', leftMs: 120 * MIN, elapsedMs: MIN }, HARNESS_NOW),
        makeBlock({ n: 41, categories: ['games'], mode: 'strict', leftMs: 90 * MIN, elapsedMs: MIN }, HARNESS_NOW),
      ];
      const snap: UiSnapshot = {
        ...harnessFixture('idle').snapshot,
        state: makeGuardianState(HARNESS_NOW, { blocks }),
      };
      const t = setup('idle', snap);
      const expected = new Map<string, number>();
      const pending: Array<{ entryId: string; blockId: string }> = [];
      for (let step = 0; step < 40; step += 1) {
        const roll = rand();
        if (roll < 0.5) {
          const block = blocks[Math.floor(rand() * blocks.length)];
          if (!block) continue;
          const add = [15, 30, 60, 7][Math.floor(rand() * 4)] ?? 15;
          const r = t.queue.extend(block.id, add);
          if (r.ok) {
            expected.set(block.id, (expected.get(block.id) ?? 0) + add);
            pending.push({ entryId: r.value.entryId, blockId: block.id });
          }
        } else if (roll < 0.7 && pending.length > 0) {
          const pick = pending[Math.floor(rand() * pending.length)];
          if (!pick) continue;
          const entry = t.store.get().ops.extendQueue.find((e) => e.id === pick.entryId);
          const outcome = t.queue.undo(pick.entryId);
          if (outcome === 'undone' && entry) {
            expected.set(pick.blockId, (expected.get(pick.blockId) ?? 0) - entry.addMinutes);
          }
        } else {
          await run(t.clock, Math.floor(rand() * 7_000));
        }
      }
      await run(t.clock, 20_000);
      await settle();
      const sentPerBlock = new Map<string, number>();
      for (const s of t.sent()) sentPerBlock.set(s.blockId, (sentPerBlock.get(s.blockId) ?? 0) + s.add);
      for (const block of blocks) {
        expect(sentPerBlock.get(block.id) ?? 0, `seed ${seed}`).toBe(expected.get(block.id) ?? 0);
      }
    }
  });
});
