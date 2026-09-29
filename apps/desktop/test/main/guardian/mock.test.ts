import {
  GuardianApiError,
  emptyAllow,
  emptyTargets,
  isConfirmEmergencyResponse,
  isCreateBlockResponse,
  isDeleteDataResponse,
  isDiagnosticsResponse,
  isEmergencyPreviewResponse,
  isEmergencyResponse,
  isEventsResponse,
  isExtendBlockResponse,
  isHealthResponse,
  isPairingCodeResponse,
  isSettingsResponse,
  isStateResponse,
  isWireEvent,
  type CreateBlockRequest,
} from '@centrate/shared/guardian-api';
import { EMERGENCY_RULES } from '@centrate/shared/points';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { createFakeGuardian } from '../../../src/main/guardian/fake-guardian';
import { MockGuardian, mockGuardianEnabled } from '../../../src/main/guardian/mock';
import { HARNESS_NOW, harnessFixture, listHarnessFixtures } from '../../../src/shared/fixtures';
import { run } from './helpers';

const MIN = 60_000;

function req(patch: Partial<CreateBlockRequest> = {}): CreateBlockRequest {
  return {
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    mode: 'normal',
    durationMinutes: 30,
    endsAt: null,
    reason: 'Quiero aprobar mates',
    acknowledgeLong: false,
    acknowledgeNoEmergency: false,
    ...patch,
  };
}

async function stateOf(mock: MockGuardian) {
  const r = await mock.getState();
  if (r.notModified) throw new Error('unexpected 304');
  return r.state;
}

describe('MockGuardian', () => {
  it('is enabled only by CENTRATE_MOCK_GUARDIAN=1 on an unpackaged app', () => {
    expect(mockGuardianEnabled({ CENTRATE_MOCK_GUARDIAN: '1' }, false)).toBe(true);
    expect(mockGuardianEnabled({ CENTRATE_MOCK_GUARDIAN: '1' }, true)).toBe(false);
    expect(mockGuardianEnabled({}, false)).toBe(false);
  });

  it('answers with the real shapes and a valid event log', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    expect(isHealthResponse(await mock.health())).toBe(true);
    expect(isStateResponse(await stateOf(mock))).toBe(true);
    expect(isDiagnosticsResponse(await mock.diagnostics())).toBe(true);
    const created = await mock.createBlock(req());
    expect(isCreateBlockResponse(created)).toBe(true);
    const extended = await mock.extendBlock(created.block.id, { addMinutes: 15 });
    expect(isExtendBlockResponse(extended)).toBe(true);
    expect(Date.parse(extended.block.endsAt)).toBe(HARNESS_NOW + 45 * MIN);
    expect(isSettingsResponse(await mock.getSettings())).toBe(true);
    expect(isPairingCodeResponse(await mock.createPairingCode())).toBe(true);
    expect(isEmergencyPreviewResponse(await mock.emergencyPreview())).toBe(true);
    const page = await mock.getEvents({});
    expect(isEventsResponse(page)).toBe(true);
    expect(page.reset).toBe(true);
    for (const e of page.events) expect(isWireEvent(e), e.type).toBe(true);
    expect(page.events.map((e) => e.type)).toEqual(['epoch_started', 'block_created', 'block_extended']);
  });

  it('completes blocks at their end with points and a «Hecho» notice', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    await mock.createBlock(req({ durationMinutes: 30 }));
    clock.advance(30 * MIN);
    const state = await stateOf(mock);
    expect(state.blocks).toHaveLength(0);
    expect(state.recent.endedBlocks[0]).toMatchObject({ outcome: 'completed', pointsDelta: 50 });
    expect(state.points.balance).toBe(50);
    const events = (await mock.getEvents({})).events;
    const done = events.find((e) => e.type === 'block_completed');
    expect(done?.points).toBe(50);
    expect(isStateResponse(state)).toBe(true);
  });

  it('validates like the guardian and replays idempotent writes', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    await expect(mock.createBlock(req({ durationMinutes: 3 }))).rejects.toMatchObject({
      code: 'duration_out_of_range',
      status: 422,
    });
    await expect(mock.createBlock(req({ durationMinutes: 300 }))).rejects.toMatchObject({
      code: 'confirmation_required',
      details: { needs: ['long'] },
    });
    const a = await mock.createBlock(req(), { idempotencyKey: 'k1' });
    const b = await mock.createBlock(req(), { idempotencyKey: 'k1' });
    expect(b.block.id).toBe(a.block.id);
    expect((await stateOf(mock)).blocks).toHaveLength(1);
    await expect(mock.createBlock(req({ durationMinutes: 45 }), { idempotencyKey: 'k1' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(mock.extendBlock(a.block.id, { addMinutes: 0 })).rejects.toBeInstanceOf(GuardianApiError);
  });

  it('runs the emergency flow with a shortened countdown', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock, emergencyUnitMs: 1_000 });
    const { block } = await mock.createBlock(req({ mode: 'strict', durationMinutes: 60 }));
    await expect(
      mock.requestEmergency({ blockIds: [block.id], phrase: 'no' }),
    ).rejects.toMatchObject({ code: 'phrase_mismatch' });
    const { emergency } = await mock.requestEmergency({
      blockIds: [block.id],
      phrase: EMERGENCY_RULES.phrases.es,
    });
    expect(isEmergencyResponse({ emergency })).toBe(true);
    expect(emergency.countdownMinutes).toBe(30);
    expect(Date.parse(emergency.readyAt)).toBe(HARNESS_NOW + 30_000);
    await expect(mock.confirmEmergency(emergency.id, { acknowledge: true })).rejects.toMatchObject({
      code: 'emergency_not_ready',
    });
    clock.advance(30_000);
    expect((await stateOf(mock)).emergency?.status).toBe('ready');
    const confirmed = await mock.confirmEmergency(emergency.id, { acknowledge: true });
    expect(isConfirmEmergencyResponse(confirmed)).toBe(true);
    expect(confirmed).toMatchObject({ penaltyApplied: 200, balanceAfter: -200, cancelledBlockIds: [block.id] });
    const state = await stateOf(mock);
    expect(state.blocks).toHaveLength(0);
    expect(state.emergency).toBeNull();
    const types = (await mock.getEvents({})).events.map((e) => e.type);
    expect(types).toContain('emergency_confirmed');
    expect(types).toContain('block_cancelled');
  });

  it('deletes data into a new epoch, keeping active blocks and a negative balance', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    const { block } = await mock.createBlock(req());
    const before = (await stateOf(mock)).epoch;
    await expect(mock.deleteData({ confirm: 'no' })).rejects.toMatchObject({ code: 'confirm_word_mismatch' });
    const r = await mock.deleteData({ confirm: ' borrar ' });
    expect(isDeleteDataResponse(r)).toBe(true);
    expect(r.epoch).not.toBe(before);
    expect(r.keptBlockIds).toEqual([block.id]);
    const page = await mock.getEvents({ epoch: before, after: 3 });
    expect(page.reset).toBe(true);
    expect(page.events.map((e) => e.type)).toEqual(['epoch_started']);
    for (const e of page.events) expect(isWireEvent(e)).toBe(true);
  });

  it('long-polls on the clock and wakes on new events', async () => {
    const clock = createManualClock(HARNESS_NOW);
    const mock = new MockGuardian({ clock });
    const first = await mock.getEvents({});
    let answered = false;
    const poll = mock.getEvents({ epoch: first.epoch, after: first.lastSeq, waitMs: 25_000 }).then((p) => {
      answered = true;
      return p;
    });
    await run(clock, 1_000);
    expect(answered).toBe(false);
    await mock.createBlock(req());
    const page = await poll;
    expect(page.events.map((e) => e.type)).toEqual(['block_created']);
    // An empty long poll answers after waitMs.
    const empty = mock.getEvents({ epoch: first.epoch, after: page.lastSeq, waitMs: 25_000 });
    await run(clock, 25_000);
    expect((await empty).events).toEqual([]);
  });
});

describe('FakeGuardianClient (harness)', () => {
  it('serves every fixture state unchanged, with its ETag', async () => {
    for (const fixture of listHarnessFixtures()) {
      if (!fixture.snapshot.state || fixture.fake.reachability !== 'ok') continue;
      const clock = createManualClock(fixture.nowMs);
      const fake = createFakeGuardian({ ...fixture, fake: { ...fixture.fake, behaviour: { ...fixture.fake.behaviour, latencyMs: 0 } } }, clock);
      const r = await fake.client.getState();
      if (r.notModified) throw new Error('304 without an etag');
      expect(r.state, fixture.id).toEqual(fixture.snapshot.state);
      expect((await fake.client.getState({ etag: fake.initialEtag() })).notModified).toBe(true);
      expect(await fake.client.emergencyPreview()).toEqual(fixture.fake.emergencyPreview);
      fake.dispose();
    }
  });

  it('scripts reachability and write behaviours and records keys', async () => {
    const timeout = harnessFixture('guardian-timeout');
    const clock = createManualClock(timeout.nowMs);
    const fake = createFakeGuardian(timeout, clock);
    let settled = false;
    const create = timeout.snapshot.ops.create;
    if (!create) throw new Error('fixture without a create');
    void fake.client.createBlock(create.request, { idempotencyKey: create.intentId }).finally(() => {
      settled = true;
    });
    await run(clock, 10_000);
    expect(settled).toBe(false);
    expect(fake.calls()).toMatchObject([{ method: 'createBlock', idempotencyKey: create.intentId }]);

    const broken = harnessFixture('protection-broken');
    const fake2 = createFakeGuardian(broken, createManualClock(broken.nowMs));
    await expect(fake2.client.getState()).rejects.toMatchObject({ code: 'unreachable', status: 0 });
    expect(createFakeGuardian(harnessFixture('not-installed'), clock).tokenSource.missing()).toBe(true);
  });
});
