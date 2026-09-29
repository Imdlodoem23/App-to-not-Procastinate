import { GuardianApiError, emptyAllow, emptyTargets } from '@centrate/shared/guardian-api';
import type { EventsResponse } from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { openEventsDb } from '../../../src/main/db/events-db';
import { createManualClock } from '../../../src/main/guardian/clock';
import { EventSync, type PageInfo } from '../../../src/main/guardian/event-sync';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { HARNESS_NOW } from '../../../src/shared/fixtures';
import { run, settle, spyClient } from './helpers';

function setup() {
  const clock = createManualClock(HARNESS_NOW);
  const mock = new MockGuardian({ clock });
  const spy = spyClient(mock);
  const db = openEventsDb(':memory:');
  const pages: Array<{ page: EventsResponse; info: PageInfo }> = [];
  const sync = new EventSync({ clock, client: spy.client, db, onPage: (page, info) => pages.push({ page, info }) });
  return { clock, mock, spy, db, pages, sync };
}

const block = {
  targets: { ...emptyTargets(), serviceIds: ['youtube'] },
  whitelistOnly: false,
  allow: emptyAllow(),
  mode: 'normal' as const,
  durationMinutes: 10,
  endsAt: null,
  reason: '',
  acknowledgeLong: false,
  acknowledgeNoEmergency: false,
};

describe('event sync', () => {
  it('syncs from the epoch start, then long-polls new events', async () => {
    const t = setup();
    t.sync.start();
    await settle();
    expect(t.pages[0]?.page.reset).toBe(true);
    expect(t.pages[0]?.info.notify).toBe(true);
    expect(t.db.cursor().lastSeq).toBe(1);
    await t.mock.createBlock(block);
    await run(t.clock, 1_000);
    expect(t.db.eventCount()).toBe(2);
    expect(t.pages.at(-1)?.page.events.map((e) => e.type)).toEqual(['block_created']);
    t.sync.stop();
  });

  it('marks backlog pages (before the first caught-up page) as not notifying', async () => {
    const t = setup();
    const { block: b } = await t.mock.createBlock({ ...block, durationMinutes: 5 });
    for (let i = 0; i < 600; i += 1) await t.mock.extendBlock(b.id, { addMinutes: 1 });
    t.sync.start();
    await run(t.clock, 2_000);
    expect(t.pages.length).toBeGreaterThanOrEqual(2);
    expect(t.pages[0]?.page.hasMore).toBe(true);
    expect(t.pages[0]?.info.notify).toBe(false);
    const caughtUp = t.pages.findIndex((p) => !p.page.hasMore);
    expect(t.pages[caughtUp]?.info.notify).toBe(true);
    expect(t.db.eventCount()).toBe(602);
    expect(t.sync.isCaughtUp()).toBe(true);
    t.sync.stop();
  });

  it('backs off 1, 2, 5, 10, 30 s on failures and a kick retries at once', async () => {
    const t = setup();
    t.spy.overrides.getEvents = () => Promise.reject(new GuardianApiError(0, 'unreachable', 'refused'));
    t.sync.start();
    await settle();
    const count = (): number => t.spy.calls.filter((c) => c.method === 'getEvents').length;
    expect(count()).toBe(1);
    await run(t.clock, 1_000);
    expect(count()).toBe(2);
    await run(t.clock, 2_000);
    expect(count()).toBe(3);
    await run(t.clock, 4_999);
    expect(count()).toBe(3);
    await run(t.clock, 1);
    expect(count()).toBe(4);
    delete t.spy.overrides.getEvents;
    t.sync.kick();
    await settle();
    // The retry succeeds at once (5th call), then the long poll starts (6th).
    expect(count()).toBe(6);
    expect(t.db.cursor().epoch).not.toBeNull();
    t.sync.stop();
  });

  it('resets when the guardian starts a new epoch (data deletion)', async () => {
    const t = setup();
    t.sync.start();
    await settle();
    await t.mock.createBlock(block);
    await run(t.clock, 1_000);
    const before = t.db.cursor().epoch;
    await t.mock.deleteData({ confirm: 'BORRAR' });
    await run(t.clock, 2_000);
    expect(t.db.cursor().epoch).not.toBe(before);
    expect(t.db.eventCount()).toBe(1);
    t.sync.stop();
  });
});
