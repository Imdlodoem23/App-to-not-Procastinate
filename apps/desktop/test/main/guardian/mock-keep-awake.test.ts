import {
  isKeepAwakeResponse,
  isStateResponse,
  isWireEvent,
  type KeepAwakeRequest,
} from '@centrate/shared/guardian-api';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/main/guardian/clock';
import { MockGuardian } from '../../../src/main/guardian/mock';
import { HARNESS_NOW } from '../../../src/shared/fixtures';

const MIN = 60_000;

function setup() {
  const clock = createManualClock(HARNESS_NOW);
  const mock = new MockGuardian({ clock });
  return { clock, mock };
}

function body(patch: Partial<KeepAwakeRequest> = {}): KeepAwakeRequest {
  return { on: true, durationMinutes: 60, display: true, ...patch };
}

async function eventTypes(mock: MockGuardian): Promise<string[]> {
  const page = await mock.getEvents({ after: 0 });
  for (const e of page.events) expect(isWireEvent(e)).toBe(true);
  return page.events.map((e) => e.type).filter((t) => t.startsWith('keep_awake'));
}

describe('MockGuardian keep-awake (stub for §5.11)', () => {
  it('starts off, turns on, is idempotent and expires', async () => {
    const { clock, mock } = setup();
    const off = await mock.getKeepAwake();
    expect(isKeepAwakeResponse(off)).toBe(true);
    expect(off.keepAwake).toMatchObject({ on: false, durationMinutes: null, display: true });

    const on = await mock.setKeepAwake(body());
    expect(isKeepAwakeResponse(on)).toBe(true);
    expect(on.keepAwake).toMatchObject({ on: true, active: true, error: null });
    expect(Date.parse(on.keepAwake.until ?? '')).toBe(HARNESS_NOW + 60 * MIN);

    clock.advance(10 * MIN);
    const again = await mock.setKeepAwake(body());
    expect(again.keepAwake.until).toBe(on.keepAwake.until);

    const r = await mock.getState();
    if (r.notModified) throw new Error('unexpected 304');
    expect(isStateResponse(r.state)).toBe(true);
    expect(r.state.keepAwake?.on).toBe(true);

    clock.advance(51 * MIN);
    expect((await mock.getKeepAwake()).keepAwake).toMatchObject({ on: false, until: null });
    expect(await eventTypes(mock)).toEqual(['keep_awake_on', 'keep_awake_off']);
  });

  it('restarts the countdown on a new duration and turns off on request', async () => {
    const { clock, mock } = setup();
    await mock.setKeepAwake(body({ durationMinutes: 30 }));
    clock.advance(20 * MIN);
    const longer = await mock.setKeepAwake(body({ durationMinutes: 120 }));
    expect(Date.parse(longer.keepAwake.until ?? '')).toBe(HARNESS_NOW + 140 * MIN);
    const forever = await mock.setKeepAwake(body({ durationMinutes: null }));
    expect(forever.keepAwake.until).toBeNull();
    const stopped = await mock.setKeepAwake(body({ on: false, durationMinutes: null }));
    expect(stopped.keepAwake).toMatchObject({ on: false, since: null, active: false });
    expect(await eventTypes(mock)).toEqual([
      'keep_awake_on',
      'keep_awake_updated',
      'keep_awake_updated',
      'keep_awake_off',
    ]);
  });

  it('rejects invalid bodies like the guardian', async () => {
    const { mock } = setup();
    await expect(mock.setKeepAwake(body({ durationMinutes: 2 }))).rejects.toMatchObject({
      code: 'duration_out_of_range',
    });
    await expect(
      mock.setKeepAwake({ ...body(), until: null } as unknown as KeepAwakeRequest),
    ).rejects.toMatchObject({ code: 'unknown_field' });
  });
});
