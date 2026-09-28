/**
 * The real guardian client of the main process: `createGuardianClient` from
 * `@centrate/shared/guardian-api` with **Node's global fetch** (undici sends no `Origin`
 * header; the guardian rejects app-token requests that carry one, ARCHITECTURE §9.2). Never
 * Electron's `net.fetch`.
 *
 * The base URL follows the port in `client.json` (a new client is built when it changes);
 * the token is read before every request and again after a 401 (`TokenSource`).
 */
import {
  GuardianApiError,
  createGuardianClient,
  guardianBaseUrl,
  type GuardianClient,
} from '@centrate/shared/guardian-api';
import type { Clock, TimerHandle } from '../contracts';
import type { TokenSource } from './client-json';

/** Node's fetch, looked up at call time (tests may stub `globalThis.fetch`). */
const nodeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** A `GuardianClient` whose base URL tracks `source.port()`. */
export function createPortAwareClient(
  source: TokenSource,
  options: { fetch?: typeof fetch; newIdempotencyKey?: () => string } = {},
): GuardianClient {
  let current: { port: number; client: GuardianClient } | null = null;
  const pick = (): GuardianClient => {
    const port = source.port();
    if (current === null || current.port !== port) {
      current = {
        port,
        client: createGuardianClient({
          baseUrl: guardianBaseUrl(port),
          token: () => source.token(),
          fetch: options.fetch ?? nodeFetch,
          ...(options.newIdempotencyKey ? { newIdempotencyKey: options.newIdempotencyKey } : {}),
        }),
      };
    }
    return current.client;
  };
  return new Proxy({} as GuardianClient, {
    get(_target, prop) {
      const client = pick();
      return client[prop as keyof GuardianClient];
    },
  });
}

/**
 * Rejects with the client's own `timeout` error when `promise` has not settled after `ms` on
 * `clock`. The HTTP client already aborts after 3 s; this makes the 3 s rule deterministic on
 * the harness's frozen clock (and bounds fakes that never answer).
 */
export function withTimeout<T>(promise: Promise<T>, clock: Clock, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const handle: TimerHandle = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new GuardianApiError(0, 'timeout', 'guardian did not answer in time'));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(handle);
        reject(error);
      },
    );
  });
}
