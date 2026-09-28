import { GuardianApiError, isBlock } from '@centrate/shared/guardian-api';
import { parseIntent } from '@centrate/shared/parser';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { CreateOperation } from '../../../src/main/guardian/create';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { VersionFloor } from '../../../src/main/guardian/poller';
import { createSnapshotStore } from '../../../src/main/guardian/store';
import { HARNESS_NOW, harnessFixture } from '../../../src/shared/fixtures';
import {
  DEFAULT_PREFS,
  draftFromParse,
  draftToCreateRequest,
  type UiSnapshot,
} from '../../../src/shared/ui-state';
import { never, run, settle, spyClient } from './helpers';

function request(reason = 'Quiero aprobar mates') {
  const draft = draftFromParse(
    parseIntent('no veo YouTube en una hora', { now: new Date(HARNESS_NOW) }),
    { ...DEFAULT_PREFS, lastReason: reason },
  );
  if (!draft) throw new Error('phrase not understood');
  return draftToCreateRequest(draft, HARNESS_NOW);
}

function setup(options: { linkDown?: boolean } = {}) {
  const fixture = harnessFixture('idle');
  const clock = createManualClock(HARNESS_NOW);
  const mock = new MockGuardian({ clock, seed: { state: fixture.snapshot.state } });
  const spy = spyClient(mock);
  const snapshot: UiSnapshot = options.linkDown
    ? { ...fixture.snapshot, link: { ...fixture.snapshot.link, status: 'down', reason: 'unreachable' } }
    : fixture.snapshot;
  const store = createSnapshotStore(snapshot);
  const published: UiSnapshot[] = [];
  store.subscribe((s) => published.push(s));
  const floor = new VersionFloor();
  const events: string[] = [];
  const op = new CreateOperation({
    clock,
    client: spy.client,
    store,
    floor,
    tokenMissing: () => false,
    onCreated: (_block, reason) => events.push(`created:${reason}`),
    onUnresponsive: () => events.push('unresponsive'),
  });
  return { clock, mock, spy, store, published, floor, op, events };
}

const keysOf = (calls: { method: string; args: unknown[] }[]): unknown[] =>
  calls
    .filter((c) => c.method === 'createBlock')
    .map((c) => (c.args[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey);

describe('«Bloqueando…»', () => {
  it('shows sending at once, then the block and lastCreated in the same publish', async () => {
    const t = setup();
    const promise = t.op.create('intent-0001', request());
    expect(t.store.get().ops.create).toMatchObject({ status: 'sending', intentId: 'intent-0001' });
    const result = await promise;
    await settle();
    expect(result.ok).toBe(true);
    const final = t.store.get();
    expect(final.ops.create).toBeNull();
    expect(final.ops.lastCreated?.intentId).toBe('intent-0001');
    expect(final.state?.blocks).toHaveLength(1);
    expect(isBlock(final.state?.blocks[0])).toBe(true);
    expect(final.prefs.lastReason).toBe('Quiero aprobar mates');
    // No snapshot ever shows the create closed without the block.
    for (const s of t.published) {
      if (s.ops.lastCreated?.intentId === 'intent-0001') {
        expect(s.ops.create).toBeNull();
        expect(s.state?.blocks.some((b) => b.id === s.ops.lastCreated?.blockId)).toBe(true);
      }
    }
    expect(t.floor.get()).toBeGreaterThan(0);
    expect(keysOf(t.spy.calls)).toEqual(['intent-0001']);
    expect(t.events).toEqual(['created:Quiero aprobar mates']);
  });

  it('fails after 3 s without an answer; «Reintentar» resends with the same key', async () => {
    const t = setup();
    t.spy.overrides.createBlock = () => never();
    const first = t.op.create('intent-0002', request());
    await run(t.clock, 2_999);
    expect(t.store.get().ops.create?.status).toBe('sending');
    await run(t.clock, 1);
    const r1 = await first;
    expect(r1.ok).toBe(false);
    expect(t.store.get().ops.create).toMatchObject({ status: 'failed', error: { kind: 'timeout' } });
    expect(t.events).toContain('unresponsive');
    // The guardian is back: the retry replays with the same key.
    delete t.spy.overrides.createBlock;
    const r2 = await t.op.retry('intent-0002');
    expect(r2.ok).toBe(true);
    expect(keysOf(t.spy.calls)).toEqual(['intent-0002', 'intent-0002']);
    expect(t.store.get().ops.create).toBeNull();
  });

  it('a create that landed during the timeout is never duplicated', async () => {
    const t = setup();
    // The guardian creates the block but the answer is lost.
    t.spy.overrides.createBlock = (...args) => {
      void t.mock.createBlock(args[0] as never, args[1] as never);
      return never();
    };
    const first = t.op.create('intent-0003', request());
    await run(t.clock, 3_000);
    expect((await first).ok).toBe(false);
    delete t.spy.overrides.createBlock;
    const retry = await t.op.retry('intent-0003');
    expect(retry.ok).toBe(true);
    const state = await t.mock.getState();
    expect(state.notModified ? null : state.state.blocks).toHaveLength(1);
  });

  it('keeps the card editable on a guardian rejection', async () => {
    const t = setup();
    t.spy.overrides.createBlock = () =>
      Promise.reject(new GuardianApiError(422, 'protected_target', 'nope', { path: 'x' }));
    const r = await t.op.create('intent-0004', request());
    expect(r).toMatchObject({ ok: false, error: { kind: 'rejected', code: 'protected_target' } });
    expect(t.store.get().ops.create?.status).toBe('failed');
    t.op.dismiss('intent-0004');
    expect(t.store.get().ops.create).toBeNull();
  });

  it('fails fast while the link is down (connection refused)', async () => {
    const t = setup({ linkDown: true });
    const r = await t.op.create('intent-0005', request());
    expect(r).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
    expect(t.spy.calls.filter((c) => c.method === 'createBlock')).toHaveLength(0);
    expect(t.store.get().ops.create?.status).toBe('failed');
  });

  it('validates the request and the intent id', async () => {
    const t = setup();
    expect(await t.op.create('bad id!', request())).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(await t.op.create('intent-0006', { ...request(), durationMinutes: null })).toMatchObject({
      ok: false,
    });
    expect(t.spy.calls).toHaveLength(0);
  });
});
