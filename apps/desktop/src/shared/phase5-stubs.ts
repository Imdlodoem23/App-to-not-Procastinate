/**
 * Stand-in handlers of the Phase 5 channels (docs/DESKTOP.md §15) so the app builds, runs and
 * screenshots before PLATFORM lands its services:
 *
 * - `phase5InvokeStubs(current, now)`: with a harness fixture, reads answer from
 *   `fixture.fake` / `fixture.local` and writes are simulated (nothing persists); without one
 *   (a real run) every channel answers `not_implemented` (501), except the camera test,
 *   whose honest answer is already `unavailable`. The core spreads it under its own handlers
 *   (`src/main/guardian/core.ts`) and the browser harness under its own
 *   (`src/renderer/src/app/memory-bridge.ts`); PLATFORM overrides channel by channel.
 * - `phase5SendStubs()`: the new send channels, ignored until PLATFORM registers its windows
 *   (`src/main/windows/ipc-window.ts`).
 *
 * Pure module (only types from `fixtures.ts`, so production bundles do not pull the fixtures).
 */
import type { Schedule } from '@centrate/shared/domain';
import type { HarnessFixture } from './fixtures';
import type {
  InvokeReq,
  InvokeRes,
  Phase5InvokeChannel,
  Phase5SendChannel,
  SendPayload,
} from './ipc';
import type { EventLogEntry, EventLogFilter } from './stats';
import { fail, ok, uiError, type UiError } from './ui-state';

/** What a Phase 5 channel answers before PLATFORM implements it. */
export function notImplemented(): UiError {
  return uiError('internal', 'not_implemented', 501);
}

type Stub<C extends Phase5InvokeChannel> = (req: InvokeReq<C>) => InvokeRes<C>;
export type Phase5InvokeStubs = { [C in Phase5InvokeChannel]: Stub<C> };
export type Phase5SendStubs = { [C in Phase5SendChannel]: (payload: SendPayload<C>) => void };

function matchesFilter(entry: EventLogEntry, filter: EventLogFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'blocks':
      return entry.type.startsWith('block_');
    case 'attempts':
      return entry.type === 'attempt';
    case 'points':
      return entry.points !== 0;
    case 'study':
      return /^(?:study_|focus_|strike|punishment_)/.test(entry.type);
  }
}

function fileDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Every Phase 5 invoke channel: answered from the fixture `current()` returns at call time
 * (the harness loads other fixtures in place), or `not_implemented` when it returns `null`.
 */
export function phase5InvokeStubs(
  current: () => HarnessFixture | null,
  now: () => number,
): Phase5InvokeStubs {
  let created = 0;
  /** Runs `answer` with the loaded fixture, or answers `not_implemented` in a real run. */
  const harness =
    <C extends Phase5InvokeChannel>(
      answer: (fixture: HarnessFixture, req: InvokeReq<C>) => InvokeRes<C>,
    ): Stub<C> =>
    (req) => {
      const fixture = current();
      return fixture ? answer(fixture, req) : (fail(notImplemented()) as InvokeRes<C>);
    };
  const iso = (): string => new Date(now()).toISOString();
  const findSchedule = (fixture: HarnessFixture, id: string): Schedule | undefined =>
    fixture.fake.schedules.find((s) => s.id === id);

  return {
    'schedules:create': harness((_f, { input }) => {
      created += 1;
      const { acknowledgeNoEmergency: _ack, ...fields } = input;
      return ok({
        ...fields,
        id: `sch_harness${String(created).padStart(10, '0')}`,
        createdAt: iso(),
        updatedAt: iso(),
        nextOccurrence: null,
        activeBlockId: null,
      });
    }),
    'schedules:update': harness((f, { id, input }) => {
      const found = findSchedule(f, id);
      if (!found) return fail(uiError('rejected', 'not_found', 404));
      const { acknowledgeNoEmergency: _ack, ...fields } = input;
      return ok({ ...found, ...fields, updatedAt: iso() });
    }),
    'schedules:delete': harness((f, { id }) =>
      findSchedule(f, id) ? ok(null) : fail(uiError('rejected', 'not_found', 404)),
    ),

    'settings:get': harness((f) => ok(f.fake.settings)),
    'settings:put': harness((f, { settings }) =>
      ok({ settings, pending: f.fake.settings.pending }),
    ),

    'rewards:list': harness((f) => ok(f.fake.rewards)),
    'rewards:redeem': harness((f, { offerId }) => {
      const rewards = f.fake.rewards;
      const offer = rewards.offers.find((o) => o.offerId === offerId);
      if (!offer) return fail(uiError('rejected', 'unknown_offer', 422));
      if (offer.unavailableReason === 'locked') {
        return fail(uiError('rejected', 'rewards_locked', 409, { reason: rewards.lockReason }));
      }
      if (offer.unavailableReason === 'not_blocked') {
        return fail(uiError('rejected', 'service_not_blocked', 409));
      }
      if (!offer.affordable) {
        return fail(
          uiError('rejected', 'insufficient_points', 409, {
            balance: rewards.balance,
            cost: offer.cost,
            shortBy: offer.shortBy,
          }),
        );
      }
      const startedAt = now();
      return ok({
        allowance: {
          id: 'alw_harness0000000001',
          offerId: offer.offerId,
          serviceId: offer.serviceId,
          minutes: offer.minutes,
          cost: offer.cost,
          startedAt: new Date(startedAt).toISOString(),
          endsAt: new Date(startedAt + offer.minutes * 60_000).toISOString(),
          status: 'active',
          endedAt: null,
          refund: 0,
        },
        pointsDelta: -offer.cost,
        balanceAfter: rewards.balance - offer.cost,
      });
    }),

    'points:summary': harness((f) => {
      const points = f.snapshot.state?.points;
      return points ? ok(points) : fail(uiError('unreachable'));
    }),
    'achievements:list': harness((f) => ok(f.local.achievements)),

    'stats:overview': harness((f, { range }) => ok(f.local.stats.overview[range])),
    'stats:heatmap': harness((f, { weeks }) => {
      const heatmap = f.local.stats.heatmap;
      // The period ends on this week's Sunday; cells stop at today.
      const days = Math.round((Date.parse(heatmap.to) - Date.parse(heatmap.from)) / 86_400_000) + 1;
      const cells = heatmap.cells.slice(Math.max(0, days - weeks * 7));
      return ok({ ...heatmap, from: cells[0]?.day ?? heatmap.from, cells });
    }),
    'stats:events': harness((f, { filter, before, limit }) => {
      if (before !== null) return ok({ entries: [], nextBefore: null, total: 0 });
      const matching = f.local.stats.events.entries.filter((e) => matchesFilter(e, filter));
      return ok({ entries: matching.slice(0, limit), nextBefore: null, total: matching.length });
    }),
    'stats:export-csv': harness((f, { kind }) =>
      ok({
        outcome: 'saved',
        rows:
          kind === 'events'
            ? f.local.stats.events.total
            : f.local.stats.heatmap.cells.filter((c) => c.level > 0).length,
        fileName: `centrate-${kind === 'events' ? 'eventos' : 'dias'}-${fileDay(now())}.csv`,
      }),
    ),

    'system:processes': harness((f) => ok(f.local.processes)),
    'activewin:request-permission': harness((f) =>
      ok({ outcome: f.snapshot.app.platform === 'darwin' ? 'opened-settings' : 'granted' }),
    ),

    'updater:check': harness((f) => ok(f.local.updateCheck)),
    'updater:download': harness((f) => {
      const u = f.snapshot.updater;
      return ok(u.version ? { ...u, status: 'ready', percent: 100 } : u);
    }),
    'updater:install': harness((f) => ok(f.snapshot.updater)),

    // The bytes come from resources/sounds/ (Node): PLATFORM reads them, harness or not.
    'sounds:load': () => fail(notImplemented()),

    'onboarding:install-guardian': harness((f) => ok({ outcome: f.local.installGuardian })),
    // Honest in every run until Study Mode ships: there is no camera test yet.
    'onboarding:test-camera': () => ok({ outcome: 'unavailable' }),
  };
}

/** The Phase 5 send channels, dropped until PLATFORM registers its windows. */
export function phase5SendStubs(): Phase5SendStubs {
  const ignore = (): void => undefined;
  return {
    'mini-timer:toggle': ignore,
    'mini-timer:position': ignore,
    'osd:show': ignore,
    'nuclear:emergency-exit': ignore,
  };
}
