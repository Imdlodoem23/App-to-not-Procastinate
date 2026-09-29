import { GuardianApiError } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { MockGuardian } from '../../../src/main/guardian/mock';
import {
  CHECKING_DELAY_MS,
  Poller,
  VERSION_FLOOR_TTL_MS,
  VersionFloor,
  nextEndDue,
} from '../../../src/main/guardian/poller';
import { createSnapshotStore } from '../../../src/main/guardian/store';
import { HARNESS_NOW, harnessFixture, type HarnessStateId } from '../../../src/shared/fixtures';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import { never, run, settle, spyClient } from './helpers';

function setup(id: HarnessStateId = 'one-block', options: { visible?: boolean } = {}) {
  const fixture = harnessFixture(id);
  const clock = createManualClock(HARNESS_NOW);
  const mock = new MockGuardian({
    clock,
    seed: { state: fixture.snapshot.state, health: fixture.fake.health },
  });
  const spy = spyClient(mock);
  const store = createSnapshotStore(fixture.snapshot);
  const published: UiSnapshot[] = [];
  store.subscribe((s) => published.push(s));
  const view = { visible: options.visible ?? true };
  const floor = new VersionFloor();
  const poller = new Poller({
    clock,
    client: spy.client,
    store,
    floor,
    tokenMissing: () => false,
    visible: () => view.visible,
  });
  poller.setEtag(mock.etag());
  const stateCalls = (): number => spy.calls.filter((c) => c.method === 'getState').length;
  return { fixture, clock, mock, spy, store, published, view, floor, poller, stateCalls };
}

describe('poller cadence', () => {
  it('polls every 2 s while visible and a 304 publishes nothing', async () => {
    const t = setup();
    t.poller.start();
    await settle();
    expect(t.stateCalls()).toBe(1);
    await run(t.clock, 10_000);
    expect(t.stateCalls()).toBe(6);
    expect(t.published).toHaveLength(0);
    t.poller.stop();
  });

  it('polls every 60 s while hidden', async () => {
    const t = setup('idle', { visible: false });
    t.poller.start();
    await settle();
    await run(t.clock, 59_000);
    expect(t.stateCalls()).toBe(1);
    await run(t.clock, 1_000);
    expect(t.stateCalls()).toBe(2);
    t.view.visible = true;
    t.poller.reschedule();
    await run(t.clock, 2_000);
    expect(t.stateCalls()).toBe(3);
    t.poller.stop();
  });

  it('looks every 10 s while hidden and the guardian is down', async () => {
    const t = setup('idle', { visible: false });
    t.spy.overrides.getState = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    t.spy.overrides.health = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    t.poller.start();
    await run(t.clock, 1_000);
    expect(t.store.get().link.status).toBe('down');
    const healthCalls = (): number => t.spy.calls.filter((c) => c.method === 'health').length;
    const before = healthCalls();
    await run(t.clock, 30_000);
    expect(healthCalls() - before).toBe(3);
    delete t.spy.overrides.getState;
    delete t.spy.overrides.health;
    await run(t.clock, 10_000);
    expect(t.store.get().link.status).toBe('ok');
    t.poller.stop();
  });

  it('refreshes 300 ms after the block ends, hidden or not', async () => {
    const t = setup('one-block', { visible: false });
    const endsAt = Date.parse(t.fixture.snapshot.state?.blocks[0]?.endsAt ?? '');
    expect(nextEndDue(t.store.get(), HARNESS_NOW)).toBe(endsAt + 300);
    t.poller.start();
    await settle();
    await run(t.clock, endsAt + 299 - HARNESS_NOW);
    const before = t.stateCalls();
    await run(t.clock, 1);
    expect(t.stateCalls()).toBe(before + 1);
    // The mock completed the block: the new state is published without it.
    expect(t.store.get().state?.blocks).toHaveLength(0);
    expect(t.store.get().state?.recent.endedBlocks[0]?.pointsDelta).toBe(80);
    t.poller.stop();
  });

  it('refreshNow never overlaps a poll in flight', async () => {
    const t = setup();
    let release: () => void = () => undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    t.spy.overrides.getState = (...args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        release = () => {
          inFlight -= 1;
          resolve(t.mock.getState(args[0] as { etag?: string | null }));
        };
      });
    };
    t.poller.start();
    await settle();
    t.poller.refreshNow('write');
    t.poller.refreshNow('event');
    release();
    await settle();
    release();
    await settle();
    expect(maxInFlight).toBe(1);
    expect(t.stateCalls()).toBe(2);
    t.poller.stop();
  });
});

describe('guardian link', () => {
  it('shows the warning within 5 s of a refused connection and never on one blip', async () => {
    const t = setup();
    t.poller.start();
    await run(t.clock, 2_000);
    // One blip: a single refused poll, then fine again.
    t.spy.overrides.getState = () => {
      delete t.spy.overrides.getState;
      return Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    };
    await run(t.clock, 10_000);
    expect(t.store.get().link.status).toBe('ok');
    expect(t.published.some((s) => s.link.status === 'down')).toBe(false);
    // The guardian stops for good.
    const stoppedAt = t.clock.now();
    t.spy.overrides.getState = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    t.spy.overrides.health = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    let downAt: number | null = null;
    t.store.subscribe((s) => {
      if (downAt === null && s.link.status === 'down') downAt = t.clock.now();
    });
    await run(t.clock, 10_000);
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'unreachable' });
    expect(downAt).not.toBeNull();
    expect((downAt ?? 0) - stoppedAt).toBeLessThanOrEqual(5_000);
    // The last good state stays under the warning.
    expect(t.store.get().state?.blocks).toHaveLength(1);
    // Recovery.
    delete t.spy.overrides.getState;
    delete t.spy.overrides.health;
    await run(t.clock, 2_000);
    expect(t.store.get().link.status).toBe('ok');
    t.poller.stop();
  });

  it('a hung guardian (no answer) shows the warning within 5 s', async () => {
    const t = setup();
    t.poller.start();
    await run(t.clock, 2_000);
    const hungAt = t.clock.now();
    t.spy.overrides.getState = () => never();
    let downAt: number | null = null;
    t.store.subscribe((s) => {
      if (downAt === null && s.link.status === 'down') downAt = t.clock.now();
    });
    await run(t.clock, 8_000);
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'timeout' });
    expect((downAt ?? Infinity) - hungAt).toBeLessThanOrEqual(5_000);
    t.poller.stop();
  });

  it('the watchdog flags a hang 4 s after the last answer, before the 3 s request timeout', async () => {
    const t = setup();
    t.poller.start();
    await run(t.clock, 2_000);
    const lastOkAt = t.clock.now();
    t.spy.overrides.getState = () => never();
    let downAt: number | null = null;
    t.store.subscribe((s) => {
      if (downAt === null && s.link.status === 'down') downAt = t.clock.now();
    });
    await run(t.clock, 6_000);
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'timeout' });
    expect((downAt ?? Infinity) - lastOkAt).toBeLessThanOrEqual(4_000);
    t.poller.stop();
  });

  it('a show after a hidden period says «connecting» until the guardian answers', async () => {
    const t = setup('idle', { visible: false });
    t.poller.start();
    await run(t.clock, 30_000);
    expect(t.store.get().link.status).toBe('ok');
    t.spy.overrides.getState = () => never();
    t.spy.overrides.health = () => never();
    t.view.visible = true;
    t.poller.refreshNow('show');
    await run(t.clock, CHECKING_DELAY_MS - 1);
    expect(t.store.get().link.status).toBe('ok');
    await run(t.clock, 1);
    expect(t.store.get().link.status).toBe('connecting');
    await run(t.clock, 2_000);
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'timeout' });
    t.poller.stop();
  });

  it('a quick answer after a show never flickers to «connecting»', async () => {
    const t = setup('idle', { visible: false });
    t.poller.start();
    await run(t.clock, 30_000);
    const statuses: string[] = [];
    t.store.subscribe((s) => statuses.push(s.link.status));
    t.view.visible = true;
    t.poller.refreshNow('show');
    await run(t.clock, 2_000);
    expect(statuses).not.toContain('connecting');
    expect(t.store.get().link.status).toBe('ok');
    t.poller.stop();
  });

  it('marks the link not installed when client.json is missing', async () => {
    const t = setup('idle');
    const poller = new Poller({
      clock: t.clock,
      client: t.spy.client,
      store: t.store,
      floor: t.floor,
      tokenMissing: () => true,
      visible: () => true,
    });
    t.spy.overrides.health = () =>
      Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    poller.start();
    await settle();
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'not_installed' });
    poller.stop();
  });

  it('flags an incompatible API version', async () => {
    const t = setup('idle');
    t.spy.overrides.health = async () => ({ ...t.fixture.fake.health, apiVersion: 2 });
    t.poller.start();
    await settle();
    expect(t.store.get().link).toMatchObject({ status: 'down', reason: 'incompatible' });
    expect(t.stateCalls()).toBe(0);
    t.poller.stop();
  });
});

describe('no stale overwrite', () => {
  it('drops a poll body older than a write', async () => {
    const t = setup('idle');
    t.poller.setEtag(null);
    t.store.update((s) => ({ ...s, state: null }));
    t.floor.raise(Number.MAX_SAFE_INTEGER);
    t.poller.start();
    await settle();
    expect(t.store.get().state).toBeNull();
    t.poller.stop();
  });

  it('publishes a lower version from a restarted guardian once the floor expires', async () => {
    const t = setup('idle');
    const floor = new VersionFloor({ now: () => t.clock.now(), epoch: () => null });
    const poller = new Poller({
      clock: t.clock,
      client: t.spy.client,
      store: t.store,
      floor,
      tokenMissing: () => false,
      visible: () => true,
    });
    const base = t.fixture.snapshot.state;
    if (!base) throw new Error('no state');
    t.store.update((s) => ({ ...s, state: { ...base, stateVersion: 50 } }));
    floor.raise(50);
    // The guardian restarted and reloaded an older version from disk.
    const restarted = { ...base, stateVersion: 3 };
    t.spy.overrides.getState = async () => ({
      notModified: false,
      state: restarted,
      etag: '"s-3"',
    });
    poller.start();
    await settle();
    expect(t.store.get().state?.stateVersion).toBe(50); // could still be a racing poll
    await run(t.clock, VERSION_FLOOR_TTL_MS + 2_000);
    expect(t.store.get().state?.stateVersion).toBe(3);
    poller.stop();
  });

  it('ignores the floor for a state from another epoch', () => {
    let now = 0;
    let epoch: string | null = 'ep_a';
    const floor = new VersionFloor({ now: () => now, epoch: () => epoch });
    floor.raise(50);
    expect(floor.admits({ stateVersion: 3, epoch: 'ep_a' as never })).toBe(false);
    expect(floor.admits({ stateVersion: 3, epoch: 'ep_b' as never })).toBe(true);
    expect(floor.admits({ stateVersion: 50, epoch: 'ep_a' as never })).toBe(true);
    // A write to the new guardian starts a new floor even with a lower version.
    epoch = 'ep_b';
    floor.raise(4);
    expect(floor.get()).toBe(4);
    expect(floor.admits({ stateVersion: 3, epoch: 'ep_b' as never })).toBe(false);
    now = VERSION_FLOOR_TTL_MS + 1;
    expect(floor.admits({ stateVersion: 3, epoch: 'ep_b' as never })).toBe(true);
    expect(floor.get()).toBe(0);
  });
});
