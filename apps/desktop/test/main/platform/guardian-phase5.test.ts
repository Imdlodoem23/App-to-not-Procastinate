/**
 * The Phase 5 guardian-backed channels of the core (docs/DESKTOP.md §15.3) against the fake
 * guardian seeded from fixtures, the in-memory guardian's shop and settings rules, and the
 * Nuclear heartbeat.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardianSettings } from '@centrate/shared/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
}));

import type { Core, CoreOptions } from '../../../src/main/contracts';
import { createManualClock } from '../../../src/main/guardian/clock';
import { createCore } from '../../../src/main/guardian/core';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { checkRedeem, rewardsShop } from '../../../src/main/guardian/mock-rewards';
import { applyDuePending, applySettingsPut } from '../../../src/main/guardian/mock-settings';
import {
  NuclearHeartbeat,
  nuclearBeatDisplays,
} from '../../../src/main/guardian/nuclear-heartbeat';
import { createMemoryLogger } from '../../../src/main/logs/logger';
import { FEATURES } from '../../../src/shared/features';
import {
  HARNESS_NOW,
  harnessFixture,
  makeBlock,
  makeSettings,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import { hostStub, run, settle } from '../guardian/helpers';

const ctx = { window: 'detail' as const };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const cores: Core[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of cores.splice(0)) await c.shutdown(0);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harnessCore(id: HarnessStateId): Core {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-p5-'));
  dirs.push(dir);
  const options: CoreOptions = {
    platform: 'linux',
    appVersion: '0.1.0',
    packaged: false,
    userDataDir: dir,
    sysDir: '/nonexistent/centrate',
    guardianBinary: null,
    clock: createManualClock(HARNESS_NOW),
    features: FEATURES,
    harness: harnessFixture(id),
    host: hostStub(),
  };
  const core = createCore(options, {
    logger: createMemoryLogger(),
    exec: async () => ({ code: 1, stdout: '', stderr: '', error: null }),
  });
  cores.push(core);
  core.start();
  return core;
}

describe('core: guardian-backed Phase 5 channels (harness)', () => {
  it('serves the shop from the fixture and redeems through the guardian', async () => {
    const core = harnessCore('rewards');
    const fixture = harnessFixture('rewards');
    const list = await core.handlers['rewards:list'](null, ctx);
    expect(list).toEqual({ ok: true, value: fixture.fake.rewards });
    const redeemed = await core.handlers['rewards:redeem'](
      { intentId: 'intent-r1', offerId: 'youtube-15' },
      ctx,
    );
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.value.pointsDelta).toBe(-150);
    expect(core.getSnapshot().state?.points.balance).toBe(redeemed.value.balanceAfter);
    expect(core.getSnapshot().state?.allowances.map((a) => a.serviceId)).toEqual(['youtube']);
    const calls = core.harness?.guardianCalls() ?? [];
    expect(calls.find((c) => c.method === 'redeemReward')).toMatchObject({
      idempotencyKey: 'intent-r1',
      body: { offerId: 'youtube-15' },
    });
    // An offer not covered by a block is refused with the guardian's code.
    const refused = await core.handlers['rewards:redeem'](
      { intentId: 'intent-r2', offerId: 'netflix-45' },
      ctx,
    );
    expect(refused.ok ? null : refused.error.code).toBe('service_not_blocked');
  });

  it('answers «Te faltan 40 puntos» data', async () => {
    const core = harnessCore('rewards-short-points');
    const r = await core.handlers['rewards:list'](null, ctx);
    if (!r.ok) throw new Error('rewards failed');
    expect(r.value.offers.find((o) => o.offerId === 'youtube-15')).toMatchObject({
      shortBy: 40,
      affordable: false,
    });
  });

  it('reads settings with their pending changes and turns weakening into pending', async () => {
    const core = harnessCore('ajustes-full');
    const got = await core.handlers['settings:get'](null, ctx);
    if (!got.ok) throw new Error('settings failed');
    expect(got.value.pending.map((p) => p.field)).toEqual(['dailyGoalMinutes', 'attemptPenalties']);
    const put = await core.handlers['settings:put'](
      {
        settings: {
          ...got.value.settings,
          dailyGoalMinutes: 30,
          closeBrowsersWithoutExtension: true,
        },
      },
      ctx,
    );
    if (!put.ok) throw new Error('put failed');
    expect(put.value.settings.closeBrowsersWithoutExtension).toBe(true);
    expect(put.value.settings.dailyGoalMinutes).toBe(60);
    expect(put.value.pending.find((p) => p.field === 'dailyGoalMinutes')?.value).toBe(30);
    const bad = await core.handlers['settings:put']({ settings: {} as GuardianSettings }, ctx);
    expect(bad.ok ? null : bad.error.code).toBe('validation_failed');
  });

  it('creates, edits and deletes schedules with the intent as key', async () => {
    const core = harnessCore('schedules');
    const fixture = harnessFixture('schedules');
    const input = fixture.detail.bloqueos.schedule?.input;
    if (!input) throw new Error('fixture without a schedule draft');
    const created = await core.handlers['schedules:create']({ intentId: 'intent-s1', input }, ctx);
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    expect(created.value.name).toBe(input.name);
    const updated = await core.handlers['schedules:update'](
      { id: created.value.id, input: { ...input, name: 'Otra' } },
      ctx,
    );
    expect(updated.ok && updated.value.name).toBe('Otra');
    const deleted = await core.handlers['schedules:delete']({ id: created.value.id }, ctx);
    expect(deleted).toEqual({ ok: true, value: null });
    const listed = await core.handlers['schedules:list'](null, ctx);
    expect(listed.ok && listed.value.some((s) => s.id === created.value.id)).toBe(false);
    expect(
      core.harness?.guardianCalls().find((c) => c.method === 'createSchedule')?.idempotencyKey,
    ).toBe('intent-s1');
  });

  it('points and the harness answers of local channels', async () => {
    const core = harnessCore('logros');
    const points = await core.handlers['points:summary'](null, ctx);
    expect(points.ok && points.value.balance).toBe(
      harnessFixture('logros').snapshot.state?.points.balance,
    );
    const install = await core.handlers['onboarding:install-guardian'](null, ctx);
    expect(install).toEqual({
      ok: true,
      value: { outcome: harnessFixture('logros').local.installGuardian },
    });
    const permission = await core.handlers['activewin:request-permission'](null, ctx);
    expect(permission).toEqual({ ok: true, value: { outcome: 'granted' } });
  });

  it('never runs the platform loops on the harness clock', async () => {
    const core = harnessCore('nuclear');
    await settle();
    const before = core.getSnapshot();
    expect(before.activeWindow).toEqual(harnessFixture('nuclear').snapshot.activeWindow);
    expect(core.harness?.guardianCalls().some((c) => c.method === 'nuclearHeartbeat')).toBe(false);
  });
});

describe('the in-memory guardian: shop', () => {
  const block = makeBlock(
    { n: 1, services: ['youtube'], mode: 'strict', leftMs: 30 * MIN, elapsedMs: 5 * MIN },
    HARNESS_NOW,
  );

  it('offers what a block covers and the balance pays', () => {
    const shop = rewardsShop({ balance: 200, blocks: [block], allowances: [], lock: null });
    const youtube = shop.offers.find((o) => o.offerId === 'youtube-15');
    expect(youtube).toMatchObject({ available: true, affordable: true, shortBy: 0 });
    expect(shop.offers.find((o) => o.offerId === 'youtube-30')).toMatchObject({
      available: false,
      unavailableReason: 'insufficient_points',
      shortBy: 80,
    });
    expect(shop.offers.find((o) => o.offerId === 'tiktok-15')?.unavailableReason).toBe(
      'not_blocked',
    );
    const locked = rewardsShop({ balance: 999, blocks: [block], allowances: [], lock: 'hardcore' });
    expect(locked.locked).toBe(true);
    expect(locked.offers.every((o) => o.unavailableReason === 'locked')).toBe(true);
  });

  it('checks a redemption in the guardian order', () => {
    const input = { balance: 1000, blocks: [block], allowances: [], lock: null };
    expect(checkRedeem('nope', input)).toMatchObject({ ok: false, code: 'unknown_offer' });
    expect(checkRedeem('youtube-15', { ...input, lock: 'exam' })).toMatchObject({
      code: 'rewards_locked',
    });
    expect(checkRedeem('tiktok-15', input)).toMatchObject({ code: 'service_not_blocked' });
    expect(checkRedeem('youtube-15', { ...input, balance: 100 })).toMatchObject({
      code: 'insufficient_points',
      details: { shortBy: 50 },
    });
    expect(checkRedeem('youtube-15', input)).toMatchObject({ ok: true, extend: null });
  });

  it('a redeemed allowance extends up to 60 min, opens the service and expires', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const fixture = harnessFixture('rewards');
    const mock = new MockGuardian({
      clock,
      emergencyUnitMs: 60_000,
      seed: { state: fixture.snapshot.state, settings: fixture.fake.settings },
    });
    const a = await mock.redeemReward({ offerId: 'youtube-30' }, { idempotencyKey: 'k1' });
    const b = await mock.redeemReward({ offerId: 'youtube-30' }, { idempotencyKey: 'k2' });
    expect(b.allowance.id).toBe(a.allowance.id);
    expect(b.allowance.minutes).toBe(60);
    await expect(
      mock.redeemReward({ offerId: 'youtube-15' }, { idempotencyKey: 'k3' }),
    ).rejects.toMatchObject({
      code: 'allowance_limit_reached',
    });
    const attempt = await mock.reportAttempt({
      layer: 'window',
      target: { type: 'service', value: 'youtube' },
      browser: null,
      incognito: false,
    });
    expect(attempt).toMatchObject({ blocked: false, reason: 'allowance_active' });
    clock.advance(61 * MIN);
    const state = await mock.getState();
    expect(state.notModified ? null : state.state.allowances).toEqual([]);
    const types = mock.allEvents().map((e) => e.type);
    expect(types.filter((t) => t === 'reward_redeemed')).toHaveLength(2);
    expect(types).toContain('reward_ended');
  });
});

describe('the in-memory guardian: settings', () => {
  const base = makeSettings().settings;

  it('applies strengthening at once and delays weakening 24 h', () => {
    const r = applySettingsPut(
      base,
      [],
      {
        ...base,
        dailyGoalMinutes: 90,
        attemptPenalties: false,
        punishment: { level: 'nuclear', minutes: 90 },
        studyWhitelist: { extraDomains: ['wikipedia.org'], extraProcesses: [] },
      },
      HARNESS_NOW,
    );
    expect(r.settings.dailyGoalMinutes).toBe(90);
    expect(r.settings.attemptPenalties).toBe(true);
    expect(r.settings.punishment).toEqual({ level: 'nuclear', minutes: 90 });
    expect(r.settings.studyWhitelist.extraDomains).toEqual([]);
    expect(r.pending).toEqual([
      {
        field: 'attemptPenalties',
        value: false,
        effectiveAt: new Date(HARNESS_NOW + DAY).toISOString(),
      },
      {
        field: 'studyWhitelist.extraDomains',
        value: ['wikipedia.org'],
        effectiveAt: new Date(HARNESS_NOW + DAY).toISOString(),
      },
    ]);
  });

  it('keeps the delay for an identical retry, restarts it when weaker, cancels on the effective value', () => {
    const first = applySettingsPut(base, [], { ...base, dailyGoalMinutes: 45 }, HARNESS_NOW);
    const retry = applySettingsPut(
      first.settings,
      first.pending,
      { ...base, dailyGoalMinutes: 45 },
      HARNESS_NOW + MIN,
    );
    expect(retry.pending[0]?.effectiveAt).toBe(first.pending[0]?.effectiveAt);
    const weaker = applySettingsPut(
      first.settings,
      first.pending,
      { ...base, dailyGoalMinutes: 30 },
      HARNESS_NOW + MIN,
    );
    expect(weaker.pending[0]).toMatchObject({
      value: 30,
      effectiveAt: new Date(HARNESS_NOW + MIN + DAY).toISOString(),
    });
    const cancel = applySettingsPut(weaker.settings, weaker.pending, base, HARNESS_NOW + 2 * MIN);
    expect(cancel.pending).toEqual([]);
  });

  it('applies pending changes when their time comes', () => {
    const first = applySettingsPut(base, [], { ...base, dailyGoalMinutes: 45 }, HARNESS_NOW);
    expect(applyDuePending(first.settings, first.pending, HARNESS_NOW + MIN)).toBeNull();
    const due = applyDuePending(first.settings, first.pending, HARNESS_NOW + DAY);
    expect(due?.settings.dailyGoalMinutes).toBe(45);
    expect(due?.pending).toEqual([]);
  });

  it('whitelist removals apply at once, also to a pending list', () => {
    const withExtras = {
      ...base,
      studyWhitelist: { extraDomains: ['a.org', 'b.org'], extraProcesses: [] },
    };
    const r = applySettingsPut(
      withExtras,
      [],
      { ...withExtras, studyWhitelist: { extraDomains: ['a.org'], extraProcesses: [] } },
      HARNESS_NOW,
    );
    expect(r.settings.studyWhitelist.extraDomains).toEqual(['a.org']);
    expect(r.pending).toEqual([]);
  });
});

describe('Nuclear heartbeat', () => {
  function snapshotWith(
    nuclear: boolean,
    overlay: 'shown' | 'hidden',
    link: 'ok' | 'down' = 'ok',
  ): UiSnapshot {
    const s = harnessFixture('nuclear').snapshot;
    if (!s.state) throw new Error('no state');
    return {
      ...s,
      link: { ...s.link, status: link },
      state: { ...s.state, nuclearActive: nuclear },
      nuclear: { overlay, displays: 2, lastHeartbeatAt: null },
    };
  }

  it('beats every 3 s only while Nuclear is on and the overlay covers the displays', async () => {
    expect(nuclearBeatDisplays(snapshotWith(true, 'shown'))).toBe(2);
    expect(nuclearBeatDisplays(snapshotWith(true, 'hidden'))).toBeNull();
    expect(nuclearBeatDisplays(snapshotWith(false, 'shown'))).toBeNull();
    expect(nuclearBeatDisplays(snapshotWith(true, 'shown', 'down'))).toBeNull();

    const clock = createManualClock(HARNESS_NOW);
    const sent: unknown[] = [];
    const beats: number[] = [];
    let inactive = 0;
    let active = true;
    const hb = new NuclearHeartbeat({
      clock,
      send: async (body) => {
        sent.push(body);
        return {
          nuclearActive: active,
          endsAt: null,
          serverNow: new Date(clock.now()).toISOString(),
        };
      },
      onBeat: (at) => beats.push(at),
      onInactive: () => {
        inactive += 1;
      },
      log: () => undefined,
    });
    hb.sync(snapshotWith(true, 'shown'));
    await run(clock, 0);
    expect(sent).toEqual([{ overlayShown: true, displays: 2 }]);
    await run(clock, 9_000);
    expect(sent).toHaveLength(4);
    expect(beats.at(-1)).toBe(HARNESS_NOW + 9_000);
    active = false;
    await run(clock, 3_000);
    expect(inactive).toBe(1);
    hb.sync(snapshotWith(false, 'hidden'));
    const count = sent.length;
    await run(clock, 30_000);
    expect(sent).toHaveLength(count);
    hb.stop();
  });

  it('the in-memory guardian answers it', async () => {
    const fixture = harnessFixture('nuclear');
    const mock = new MockGuardian({
      clock: createManualClock(HARNESS_NOW),
      seed: { state: fixture.snapshot.state },
    });
    const r = await mock.nuclearHeartbeat({ overlayShown: true, displays: 1 });
    expect(r.nuclearActive).toBe(true);
    expect(r.endsAt).toBe(fixture.snapshot.state?.punishments[0]?.endsAt);
    await expect(mock.nuclearHeartbeat({ overlayShown: true, displays: 0 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
