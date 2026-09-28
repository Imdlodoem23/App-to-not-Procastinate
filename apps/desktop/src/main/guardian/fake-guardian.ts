/**
 * `FakeGuardianClient` for the harness (docs/DESKTOP.md §10): a `MockGuardian` seeded from a
 * fixture (`snapshot.state` and `fixture.fake`) on the frozen clock, wrapped with the
 * fixture's scripted behaviour and a call recorder:
 *
 * - `fake.reachability`: `unreachable` / `not_installed` refuse every call, `timeout` never
 *   answers (the core's 3 s timeout fires on `advance`);
 * - `fake.behaviour.createBlock` / `extendBlock`: `ok`, `timeout`, `unreachable` or a guardian
 *   error code;
 * - `fake.behaviour.latencyMs`: added to every answer (on the frozen clock);
 * - `calls()`: every call with its `Idempotency-Key` (e2e: «Reintentar» reuses the key, an
 *   undone extension never reaches the guardian).
 *
 * The seeded state is served unchanged until something writes, and the poller starts with
 * its ETag, so a screenshot is exactly the fixture.
 */
import {
  GUARDIAN_ERROR_STATUS,
  GuardianApiError,
  type GuardianClient,
  type GuardianErrorCode,
} from '@centrate/shared/guardian-api';
import type { FakeWriteBehaviour, HarnessFixture } from '../../shared/fixtures';
import type { Clock, RecordedGuardianCall } from '../contracts';
import { staticTokenSource, type TokenSource } from './client-json';
import { MockGuardian } from './mock';

export interface FakeGuardian {
  client: GuardianClient;
  mock: MockGuardian;
  tokenSource: TokenSource;
  calls(): RecordedGuardianCall[];
  /** ETag of the seeded state (the poller's first request is then a 304). */
  initialEtag(): string | null;
  dispose(): void;
}

/** Methods whose last argument is `WriteOptions` (`Idempotency-Key`). */
const WRITE_OPTION_INDEX: Partial<Record<keyof GuardianClient, number>> = {
  createBlock: 1,
  extendBlock: 2,
  createSchedule: 1,
  startStudy: 1,
  studyStrike: 2,
  endStudy: 2,
  requestEmergency: 1,
  confirmEmergency: 2,
  redeemReward: 1,
  deleteData: 1,
};

function behaviourError(code: GuardianErrorCode, details?: Record<string, unknown>): GuardianApiError {
  return new GuardianApiError(GUARDIAN_ERROR_STATUS[code], code, `scripted ${code}`, details ?? null);
}

export function createFakeGuardian(fixture: HarnessFixture, clock: Clock): FakeGuardian {
  const fake = fixture.fake;
  const mock = new MockGuardian({
    clock,
    emergencyUnitMs: 60_000,
    seed: {
      state: fixture.snapshot.state,
      health: fake.health,
      settings: fake.settings,
      schedules: fake.schedules,
      pairingCode: fake.pairingCode,
      extensions: fake.extensions,
      emergencyPreview: fake.emergencyPreview,
      rewards: fake.rewards,
    },
  });
  const recorded: RecordedGuardianCall[] = [];
  let disposed = false;

  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  const delay = <T>(run: () => Promise<T>): Promise<T> => {
    const latency = fake.behaviour.latencyMs;
    if (latency <= 0) return run();
    return new Promise<T>((resolve, reject) => {
      clock.setTimeout(() => {
        if (disposed) return;
        run().then(resolve, reject);
      }, latency);
    });
  };

  const scripted = (method: keyof GuardianClient): FakeWriteBehaviour => {
    if (method === 'createBlock') return fake.behaviour.createBlock;
    if (method === 'extendBlock') return fake.behaviour.extendBlock;
    return 'ok';
  };

  const client = new Proxy({} as GuardianClient, {
    get(_target, prop) {
      const method = prop as keyof GuardianClient;
      const impl = mock[method] as unknown;
      if (typeof impl !== 'function') return impl;
      return (...args: unknown[]): Promise<unknown> => {
        const optIndex = WRITE_OPTION_INDEX[method];
        const options =
          optIndex !== undefined ? (args[optIndex] as { idempotencyKey?: string } | undefined) : undefined;
        const bodyArgs = optIndex !== undefined ? args.slice(0, optIndex) : args;
        recorded.push({
          at: clock.now(),
          method,
          idempotencyKey: options?.idempotencyKey ?? null,
          body: structuredClone(
            bodyArgs.length === 0 ? null : bodyArgs.length === 1 ? bodyArgs[0] : bodyArgs,
          ),
        });
        if (disposed) return never();
        if (fake.reachability === 'unreachable' || fake.reachability === 'not_installed') {
          return Promise.reject(new GuardianApiError(0, 'unreachable', 'scripted unreachable'));
        }
        if (fake.reachability === 'timeout') return never();
        const behaviour = scripted(method);
        if (behaviour === 'timeout') return never();
        if (behaviour === 'unreachable') {
          return Promise.reject(new GuardianApiError(0, 'unreachable', 'scripted unreachable'));
        }
        if (behaviour !== 'ok') {
          return delay(() => Promise.reject(behaviourError(behaviour.error, behaviour.details)));
        }
        return delay(() => (impl as (...a: unknown[]) => Promise<unknown>).apply(mock, args));
      };
    },
  });

  return {
    client,
    mock,
    tokenSource: staticTokenSource({ missing: fake.reachability === 'not_installed' }),
    calls: () => recorded.map((c) => ({ ...c, body: structuredClone(c.body) })),
    initialEtag: () => (fixture.snapshot.state ? mock.etag() : null),
    dispose(): void {
      disposed = true;
      mock.close();
    },
  };
}
