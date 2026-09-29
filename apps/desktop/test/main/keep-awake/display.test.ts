import { describe, expect, it } from 'vitest';
import { GUARDIAN_CAPABILITIES } from '@centrate/shared/guardian-api';
import { createManualClock } from '../../../src/main/guardian/clock';
import { DisplayKeeper, type DisplayBlocker } from '../../../src/main/keep-awake/display';
import {
  HARNESS_NOW,
  harnessFixture,
  makeHealth,
  makeKeepAwake,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { keepAwakeOf } from '../../../src/shared/keep-awake';
import type { UiSnapshot } from '../../../src/shared/ui-state';

const MIN = 60_000;

/** A snapshot on the real clock (no harness freeze), so the keeper arms its timer. */
function live(id: HarnessStateId, patch: (s: UiSnapshot) => UiSnapshot = (s) => s): UiSnapshot {
  return patch({ ...harnessFixture(id).snapshot, harness: null });
}

function withKeepAwake(s: UiSnapshot, keepAwake: ReturnType<typeof makeKeepAwake>): UiSnapshot {
  return s.state ? { ...s, state: { ...s.state, keepAwake } } : s;
}

function recorder(): DisplayBlocker & { started: number[]; stopped: number[] } {
  let next = 0;
  const started: number[] = [];
  const stopped: number[] = [];
  return {
    started,
    stopped,
    start: () => {
      next += 1;
      started.push(next);
      return next;
    },
    stop: (id) => {
      stopped.push(id);
    },
  };
}

describe('DisplayKeeper («Mantener también la pantalla encendida»)', () => {
  it('holds the blocker while on with display, once, and releases when off', () => {
    const clock = createManualClock(HARNESS_NOW);
    const blocker = recorder();
    const keeper = new DisplayKeeper({ blocker, clock });
    keeper.sync(live('idle'));
    expect(keeper.held()).toBe(false);
    const on = live('keep-awake');
    keeper.sync(on);
    keeper.sync({ ...on, rev: on.rev + 1 });
    expect(blocker.started).toEqual([1]);
    expect(keeper.held()).toBe(true);
    keeper.sync(live('idle'));
    expect(blocker.stopped).toEqual([1]);
    expect(keeper.held()).toBe(false);
  });

  it('never holds with «pantalla» off or without the capability', () => {
    const clock = createManualClock(HARNESS_NOW);
    const blocker = recorder();
    const keeper = new DisplayKeeper({ blocker, clock });
    keeper.sync(
      withKeepAwake(live('idle'), makeKeepAwake(HARNESS_NOW - MIN, null, { display: false })),
    );
    expect(keeper.held()).toBe(false);
    keeper.sync(
      live('keep-awake', (s) => ({
        ...s,
        health: makeHealth(HARNESS_NOW, {
          capabilities: GUARDIAN_CAPABILITIES.filter((c) => c !== 'keep_awake'),
        }),
      })),
    );
    expect(blocker.started).toEqual([]);
  });

  it('keeps holding while the guardian does not answer, and releases at the end', () => {
    const clock = createManualClock(HARNESS_NOW);
    const blocker = recorder();
    const keeper = new DisplayKeeper({ blocker, clock });
    const until = live('keep-awake-until');
    keeper.sync({ ...until, link: { ...until.link, status: 'down', reason: 'unreachable' } });
    expect(keeper.held()).toBe(true);
    // 90 min left: no new snapshot arrives, the keeper's own timer releases it.
    clock.advance(89 * MIN);
    expect(keeper.held()).toBe(true);
    clock.advance(MIN + 100);
    expect(keeper.held()).toBe(false);
    expect(blocker.stopped).toEqual([1]);
  });

  it('releases while the guardian is frozen (it refuses the change that turns it off)', () => {
    const clock = createManualClock(HARNESS_NOW);
    const blocker = recorder();
    const keeper = new DisplayKeeper({ blocker, clock });
    const on = live('keep-awake-until');
    keeper.sync(on);
    expect(keeper.held()).toBe(true);
    // Frozen: the guardian still serves `on: true` (with `error: failed`) but refuses every PUT.
    const frozenState = live('keep-awake-until', (s) =>
      s.state
        ? {
            ...s,
            state: {
              ...s.state,
              guardian: { ...s.state.guardian, mode: 'frozen' },
              keepAwake: { ...keepAwakeOf(s), active: false, error: 'failed' },
            },
          }
        : s,
    );
    keeper.sync(frozenState);
    expect(keeper.held()).toBe(false);
    expect(blocker.stopped).toEqual([1]);
    // No timer for its end either.
    expect(clock.nextDueAt()).toBeNull();
    // `health.mode` alone says so too.
    const frozenHealth = live('keep-awake', (s) => ({
      ...s,
      health: s.health ? { ...s.health, mode: 'frozen' } : s.health,
    }));
    keeper.sync(frozenHealth);
    expect(keeper.held()).toBe(false);
    // Back to normal: held again.
    keeper.sync(live('keep-awake'));
    expect(keeper.held()).toBe(true);
    expect(blocker.started).toEqual([1, 2]);
  });

  it('releases for good on quit', () => {
    const clock = createManualClock(HARNESS_NOW);
    const blocker = recorder();
    const keeper = new DisplayKeeper({ blocker, clock });
    keeper.sync(live('keep-awake'));
    keeper.dispose();
    expect(keeper.held()).toBe(false);
    keeper.sync(live('keep-awake'));
    expect(keeper.held()).toBe(false);
    expect(blocker.started).toEqual([1]);
  });

  it('survives a blocker that throws', () => {
    const clock = createManualClock(HARNESS_NOW);
    const events: string[] = [];
    const keeper = new DisplayKeeper({
      blocker: {
        start: () => {
          throw new Error('no');
        },
        stop: () => undefined,
      },
      clock,
      log: (event) => events.push(event),
    });
    keeper.sync(live('keep-awake'));
    expect(keeper.held()).toBe(false);
    expect(events).toEqual(['display_blocker_failed']);
  });

  it('follows the harness clock without timers of its own', () => {
    const clock = createManualClock(HARNESS_NOW);
    const keeper = new DisplayKeeper({ blocker: recorder(), clock });
    const frozen = harnessFixture('keep-awake-until').snapshot;
    keeper.sync(frozen);
    expect(keeper.held()).toBe(true);
    expect(clock.nextDueAt()).toBeNull();
    const later = {
      ...frozen,
      harness: { stateId: 'keep-awake-until', frozenNowMs: HARNESS_NOW + 91 * MIN },
    };
    keeper.sync(later);
    expect(keeper.held()).toBe(false);
  });
});
