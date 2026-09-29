import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountabilityEventInput,
  CloudDayStats,
  CloudFetch,
  OutboxItem,
  OutboxOptions,
  OutboxState,
  PostAccountabilityEventResponse,
  PutDaysRequest,
} from '../src/cloud-api';
import {
  CLOUD_LIMITS,
  CLOUD_OUTBOX,
  CLOUD_TIMEOUTS,
  CloudError,
  addDays,
  approvalOutcome,
  cloudWasReset,
  coalesceOutbox,
  createCloudClient,
  createOutbox,
  daysToReupload,
  memoryOutboxStorage,
  newClientRef,
  nextRetryDelay,
  localDayIn,
  normalizeOutboxState,
  sendAccountabilityEvent,
  syncWindowStart,
} from '../src/cloud-api';

// ---------------------------------------------------------------------------------------
// Fetch stubs
// ---------------------------------------------------------------------------------------

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: Parameters<CloudFetch>[1];
}

function reply(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** A fetch that records every request and answers with `answer`. */
function stubFetch(answer: (seen: Seen) => ReturnType<typeof reply> | Promise<never>) {
  const seen: Seen[] = [];
  const fetch: CloudFetch = async (url, init) => {
    const entry: Seen = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      init,
    };
    seen.push(entry);
    return answer(entry);
  };
  return { fetch, seen };
}

const errorBody = (code: string, extras: Record<string, unknown> = {}) => ({
  error: { code, message: 'x', ...extras },
});

const BASE = 'https://centrate-api.example.com';

function client(fetch: CloudFetch, extra: Partial<Parameters<typeof createCloudClient>[0]> = {}) {
  return createCloudClient({ baseUrl: BASE, getToken: () => 'tok-123', fetch, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<CloudError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudError);
    return error as CloudError;
  }
  throw new Error('expected the call to fail');
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------
// Client: requests
// ---------------------------------------------------------------------------------------

describe('createCloudClient requests', () => {
  it('sends the bearer token, JSON body and safe fetch options', async () => {
    const { fetch, seen } = stubFetch(() => reply(200, { accepted: 1, stale: [] }));
    const body: PutDaysRequest = { deviceId: 'dev-1', days: [day('2026-09-27', 3)] };
    await expect(client(fetch).putDays(body)).resolves.toEqual({ accepted: 1, stale: [] });
    const [req] = seen;
    expect(req?.url).toBe(`${BASE}/v1/sync/days`);
    expect(req?.method).toBe('PUT');
    expect(req?.headers).toMatchObject({
      authorization: 'Bearer tok-123',
      'content-type': 'application/json',
      accept: 'application/json',
    });
    expect(req?.body).toEqual(body);
    expect(req?.init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
  });

  it('encodes path segments and query values', async () => {
    const { fetch, seen } = stubFetch(() => reply(200, { ok: true }));
    const c = client(fetch);
    await c.previewInvite('ABCDE-FGH/J');
    await c.getSyncState('a b&c');
    await c.getStats('2026-07-06', '2026-09-27');
    await c.getRanking(null);
    await c.getRanking('2026-W53');
    expect(seen.map((s) => s.url)).toEqual([
      `${BASE}/v1/friends/invites/ABCDE-FGH%2FJ`,
      `${BASE}/v1/sync/state?deviceId=a+b%26c`,
      `${BASE}/v1/stats?from=2026-07-06&to=2026-09-27`,
      `${BASE}/v1/ranking`,
      `${BASE}/v1/ranking?week=2026-W53`,
    ]);
  });

  it('stamps an accountability event with the app clock at every send, after a wake-up', async () => {
    let t = Date.parse('2026-09-28T10:00:00.000Z');
    const { fetch, seen } = stubFetch(({ url }) => {
      if (!url.endsWith('/health')) return reply(201, { eventId: 'e-1', approval: null });
      t += 45_000; // A cold start: the countdown keeps running meanwhile.
      return reply(200, HEALTH);
    });
    const c = client(fetch, { now: () => new Date(t) });
    const onWaking = vi.fn();
    // Extra fields (an old outbox row) never reach the strict server schema.
    const queued = { ...event('ref-000000000001'), sentAt: 'stale', note: 'x' };
    await c.postAccountabilityEvent(queued, { onWaking });
    t += 90_000;
    await c.postAccountabilityEvent(queued, { onWaking });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/health',
      '/v1/accountability/events',
      '/v1/accountability/events',
    ]);
    expect(onWaking).toHaveBeenCalledTimes(1);
    expect(seen.slice(1).map((s) => s.body)).toEqual([
      { ...event('ref-000000000001'), sentAt: '2026-09-28T10:00:45.000Z' },
      { ...event('ref-000000000001'), sentAt: '2026-09-28T10:02:15.000Z' },
    ]);
  });

  it('stamps every presence heartbeat with the app clock', async () => {
    let t = Date.parse('2026-09-28T10:00:00.000Z');
    const { fetch, seen } = stubFetch(() => reply(200, { expiresAt: '2026-09-28T10:03:00.000Z' }));
    const c = client(fetch, { now: () => new Date(t) });
    const heartbeat = { state: 'focus' as const, endsAt: '2026-09-28T10:50:00.000Z' };
    await c.putPresence(heartbeat);
    t += 60_000;
    // Extra fields never reach the strict server schema.
    await c.putPresence({ ...heartbeat, sentAt: 'stale' } as never);
    expect(seen.map((s) => [s.method, new URL(s.url).pathname, s.body])).toEqual([
      ['PUT', '/v1/presence', { ...heartbeat, sentAt: '2026-09-28T10:00:00.000Z' }],
      ['PUT', '/v1/presence', { ...heartbeat, sentAt: '2026-09-28T10:01:00.000Z' }],
    ]);
  });

  it('gives an event the interactive timeout to wake the server and the background one to send', async () => {
    vi.useFakeTimers();
    let healthAnswers = false;
    const seen: string[] = [];
    const fetch: CloudFetch = (url) => {
      seen.push(new URL(url).pathname);
      return healthAnswers && url.endsWith('/health')
        ? Promise.resolve(reply(200, HEALTH))
        : new Promise(() => undefined);
    };
    const c = client(fetch);

    const waking = failure(c.postAccountabilityEvent(event('ref-000000000001')));
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.backgroundMs);
    expect(seen).toEqual(['/health']); // Still waiting for the cold start.
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.interactiveMs - CLOUD_TIMEOUTS.backgroundMs);
    expect(await waking).toMatchObject({ kind: 'timeout', operation: 'health', retryable: true });
    expect(seen).toEqual(['/health']);

    healthAnswers = true;
    const sending = failure(c.postAccountabilityEvent(event('ref-000000000001')));
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.backgroundMs);
    expect(await sending).toMatchObject({
      kind: 'timeout',
      operation: 'postAccountabilityEvent',
      retryable: true,
    });
    expect(seen).toEqual(['/health', '/health', '/v1/accountability/events']);
  });

  it('never sends the token to public routes', async () => {
    const { fetch, seen } = stubFetch(() => reply(200, { ok: true }));
    await client(fetch).health();
    expect(seen[0]?.url).toBe(`${BASE}/health`);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('sends a body where the server parses one', async () => {
    const { fetch, seen } = stubFetch(({ method }) =>
      method === 'DELETE' ? reply(204) : reply(201, { id: 'x' }),
    );
    const c = client(fetch);
    await c.deleteAccount();
    await c.createInvite();
    await c.acceptInvite('ABCDE-FGHJK');
    await c.logout();
    expect(seen.map((s) => [s.method, s.body])).toEqual([
      ['DELETE', { confirm: 'BORRAR' }],
      ['POST', {}],
      ['POST', {}],
      ['POST', undefined],
    ]);
    expect(seen[3]?.headers['content-type']).toBeUndefined();
  });

  it('normalizes the base URL and rejects bad ones', async () => {
    const { fetch, seen } = stubFetch(() => reply(200, {}));
    await createCloudClient({ baseUrl: `${BASE}/api/`, getToken: () => null, fetch }).health();
    expect(seen[0]?.url).toBe(`${BASE}/api/health`);
    for (const bad of ['not a url', 'ftp://x.example', `${BASE}?a=1`, 'https://u:p@x.example']) {
      expect(() => createCloudClient({ baseUrl: bad, getToken: () => null, fetch })).toThrow(
        TypeError,
      );
    }
  });

  it('removePartner tells an immediate removal from a 24 h one', async () => {
    const link = { id: 'l1', status: 'active', endsAt: '2026-09-29T10:00:00.000Z' };
    const answers = [reply(204), reply(200, link)];
    const { fetch } = stubFetch(() => answers.shift() ?? reply(500));
    const c = client(fetch);
    await expect(c.removePartner('l1')).resolves.toBeNull();
    await expect(c.removePartner('l1')).resolves.toEqual(link);
  });
});

// ---------------------------------------------------------------------------------------
// Client: errors
// ---------------------------------------------------------------------------------------

describe('createCloudClient errors', () => {
  it('fails without a request when signed out', async () => {
    const onUnauthorized = vi.fn();
    const { fetch, seen } = stubFetch(() => reply(200, {}));
    const c = createCloudClient({ baseUrl: BASE, getToken: () => null, fetch, onUnauthorized });
    const error = await failure(c.getMe());
    expect(error).toMatchObject({ kind: 'http', status: 401, code: 'unauthorized' });
    expect(error.isUnauthorized).toBe(true);
    expect(error.retryable).toBe(false);
    expect(seen).toHaveLength(0);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports a 401 answer to onUnauthorized', async () => {
    const onUnauthorized = vi.fn(() => {
      throw new Error('handler bug');
    });
    const { fetch } = stubFetch(() => reply(401, errorBody('unauthorized')));
    const error = await failure(client(fetch, { onUnauthorized }).getMe());
    expect(error.isUnauthorized).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  const now = new Date('2026-09-28T10:00:00.000Z');
  it.each([
    ['validation_failed', 400, errorBody('validation_failed'), {}, false, null],
    [
      'consent_required',
      403,
      errorBody('consent_required', { consent: 'syncStats' }),
      {},
      false,
      null,
    ],
    ['not_found', 404, errorBody('not_found'), {}, false, null],
    ['limit_reached', 409, errorBody('limit_reached'), {}, false, null],
    [
      'rate_limited header',
      429,
      errorBody('rate_limited'),
      { 'Retry-After': '120' },
      true,
      120_000,
    ],
    [
      'rate_limited body',
      429,
      errorBody('rate_limited', { retryAfterSeconds: 30 }),
      {},
      true,
      30_000,
    ],
    [
      'rate_limited date',
      429,
      errorBody('rate_limited'),
      { 'retry-after': 'Mon, 28 Sep 2026 10:05:00 GMT' },
      true,
      300_000,
    ],
    [
      'quota_exceeded',
      429,
      errorBody('quota_exceeded', { resetsAt: '2026-09-29T00:00:00.000Z' }),
      {},
      false,
      14 * 3_600_000,
    ],
    ['internal_error', 500, errorBody('internal_error'), {}, true, null],
    ['not_implemented', 501, errorBody('not_implemented'), {}, false, null],
    ['coach_incomplete', 502, errorBody('coach_incomplete'), {}, false, null],
    ['proxy page', 502, '<html>Bad gateway</html>', {}, true, null],
    [
      'feature_disabled',
      503,
      errorBody('feature_disabled', { feature: 'coach', reason: 'missing_key' }),
      {},
      false,
      null,
    ],
    [
      'feature_disabled database_down',
      503,
      errorBody('feature_disabled', { feature: 'sync', reason: 'database_down' }),
      {},
      true,
      null,
    ],
    ['database_unavailable', 503, errorBody('database_unavailable'), {}, true, null],
    ['coach_unavailable', 503, errorBody('coach_unavailable'), {}, true, null],
  ] as const)('%s', async (_name, status, body, headers, retryable, retryAfterMs) => {
    const { fetch } = stubFetch(() => reply(status, body, headers));
    const error = await failure(client(fetch, { now: () => now }).getMe());
    expect(error.kind).toBe('http');
    expect(error.status).toBe(status);
    expect(error.code).toBe(typeof body === 'string' ? null : body.error.code);
    expect(error.retryable).toBe(retryable);
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect(error.operation).toBe('getMe');
  });

  it('keeps the envelope extras and ignores unknown codes', async () => {
    const issues = [{ path: 'body.days.1.day', message: 'bad' }];
    const { fetch } = stubFetch(() => reply(400, errorBody('validation_failed', { issues })));
    const error = await failure(client(fetch).getMe());
    expect(error.details?.issues).toEqual(issues);

    const other = stubFetch(() => reply(418, errorBody('teapot')));
    const unknown = await failure(client(other.fetch).getMe());
    expect(unknown).toMatchObject({ kind: 'http', status: 418, code: null, retryable: false });
  });

  it('never puts the URL or the token in the message', async () => {
    const { fetch } = stubFetch(() => reply(404, errorBody('not_found')));
    const error = await failure(client(fetch).previewInvite('SECRT-CODE1'));
    expect(error.message).not.toContain('SECRT');
    expect(error.message).not.toContain('tok-123');
    expect(error.message).toContain('previewInvite');
  });

  it('maps a network failure to offline', async () => {
    const fetch: CloudFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const error = await failure(client(fetch).getMe());
    expect(error).toMatchObject({ kind: 'offline', status: null, retryable: true });
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('maps a non-JSON success to invalid_response', async () => {
    const portal = stubFetch(() => reply(200, '<html>Wi-Fi login</html>'));
    expect(await failure(client(portal.fetch).getMe())).toMatchObject({
      kind: 'invalid_response',
      retryable: true,
    });
    const empty = stubFetch(() => reply(200));
    expect((await failure(client(empty.fetch).getMe())).kind).toBe('invalid_response');
    const scalar = stubFetch(() => reply(200, '42'));
    expect((await failure(client(scalar.fetch).getMe())).kind).toBe('invalid_response');
  });

  it('times out even when fetch ignores its signal', async () => {
    const fetch: CloudFetch = () => new Promise(() => undefined);
    const error = await failure(client(fetch).getMe({ timeoutMs: 20 }));
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('aborts the request on timeout', async () => {
    let signal: AbortSignal | null = null;
    const fetch: CloudFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    const error = await failure(client(fetch).getMe({ timeoutMs: 20 }));
    expect(error.kind).toBe('timeout');
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('uses the timeout of each call class', async () => {
    vi.useFakeTimers();
    // The server is awake (health answers); every other request hangs.
    const fetch: CloudFetch = (url) =>
      url.endsWith('/health') ? Promise.resolve(reply(200, HEALTH)) : new Promise(() => undefined);
    const c = client(fetch);
    const settled: string[] = [];
    const track = (name: string, p: Promise<unknown>) =>
      p.catch((e: CloudError) => settled.push(`${name}:${e.kind}`));
    const all = Promise.all([
      track('background', c.putPresence({ state: 'focus', endsAt: null })),
      track('interactive', c.getMe()),
      track('coach', c.splitTask({ task: 't', context: null, minutesAvailable: null })),
    ]);
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.backgroundMs);
    expect(settled).toEqual(['background:timeout']);
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.interactiveMs - CLOUD_TIMEOUTS.backgroundMs);
    expect(settled).toEqual(['background:timeout', 'interactive:timeout']);
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.coachMs - CLOUD_TIMEOUTS.interactiveMs - 1);
    expect(settled).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(settled).toEqual(['background:timeout', 'interactive:timeout', 'coach:timeout']);
  });

  it('reports a cancelled call as aborted', async () => {
    const fetch: CloudFetch = () => new Promise(() => undefined);
    const controller = new AbortController();
    const pending = client(fetch).getMe({ signal: controller.signal });
    controller.abort();
    expect(await failure(pending)).toMatchObject({ kind: 'aborted', retryable: false });

    const { fetch: counted, seen } = stubFetch(() => reply(200, {}));
    expect((await failure(client(counted).getMe({ signal: controller.signal }))).kind).toBe(
      'aborted',
    );
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// Client: coach calls (wake-up and retry rules)
// ---------------------------------------------------------------------------------------

const HEALTH = { ok: true, db: 'up', serverEpoch: 'epoch-1' };
const SPLIT_BODY = { task: 'Trabajo de historia', context: null, minutesAvailable: 45 };
const SPLIT_ANSWER = { steps: [], firstStepTip: 'Empieza.' };

/** A server whose /health answers and whose other routes answer with `answer`. */
function coachServer(answer: (seen: Seen) => ReturnType<typeof reply> | Promise<never>) {
  return stubFetch((seen) => (seen.url.endsWith('/health') ? reply(200, HEALTH) : answer(seen)));
}

function fakeClock(start = '2026-09-28T10:00:00.000Z') {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createCloudClient coach calls', () => {
  const paths = (seen: Seen[]) => seen.map((s) => new URL(s.url).pathname);

  it('wakes a server that has not answered lately before a coach call', async () => {
    const clock = fakeClock();
    const { fetch, seen } = coachServer(() => reply(200, SPLIT_ANSWER));
    const c = client(fetch, { now: clock.now });
    const onWaking = vi.fn();

    await expect(c.splitTask(SPLIT_BODY, { onWaking })).resolves.toEqual(SPLIT_ANSWER);
    expect(paths(seen)).toEqual(['/health', '/v1/coach/split-task']);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(onWaking).toHaveBeenCalledTimes(1);

    // Awake: straight to the model.
    clock.advance(CLOUD_TIMEOUTS.awakeMs - 1);
    await c.studyPlan(
      {
        subject: 'Mates',
        examDate: '2026-10-05',
        today: '2026-09-28',
        dailyMinutes: 60,
        topics: [],
        level: null,
        daysOff: [],
      },
      { onWaking },
    );
    expect(paths(seen).slice(2)).toEqual(['/v1/coach/study-plan']);
    expect(onWaking).toHaveBeenCalledTimes(1);

    // Quiet for too long (the free service sleeps after 15 min): wake it again.
    clock.advance(CLOUD_TIMEOUTS.awakeMs);
    await c.interpret({ text: 'x', timeZone: 'Europe/Madrid', now: clock.now().toISOString() });
    await c.weeklySummary({ week: '2026-W39', stats: null });
    expect(paths(seen).slice(3)).toEqual([
      '/health',
      '/v1/coach/interpret',
      '/v1/coach/weekly-summary',
    ]);
  });

  it('counts any answer of ours as awake, not a proxy page', async () => {
    const clock = fakeClock();
    let proxy = true;
    const { fetch, seen } = coachServer((s) => {
      if (s.url.endsWith('/v1/me')) return reply(503, errorBody('database_unavailable'));
      if (proxy && s.url.endsWith('/v1/friends')) return reply(502, '<html>Bad gateway</html>');
      return reply(200, SPLIT_ANSWER);
    });
    const c = client(fetch, { now: clock.now });
    await failure(c.listFriends());
    proxy = false;
    await c.splitTask(SPLIT_BODY);
    expect(paths(seen)).toEqual(['/v1/friends', '/health', '/v1/coach/split-task']);

    clock.advance(CLOUD_TIMEOUTS.awakeMs + 1);
    await failure(c.getMe()); // An error envelope: the service itself answered.
    await c.splitTask(SPLIT_BODY);
    expect(paths(seen).slice(3)).toEqual(['/v1/me', '/v1/coach/split-task']);

    // A clock set back does not keep it awake.
    clock.advance(-60_000);
    await c.splitTask(SPLIT_BODY);
    expect(paths(seen).slice(5)).toEqual(['/health', '/v1/coach/split-task']);
  });

  it('reports a failed wake-up as a retryable health error and sends nothing', async () => {
    const seen: string[] = [];
    const fetch: CloudFetch = async (url) => {
      seen.push(url);
      throw new TypeError('fetch failed');
    };
    const error = await failure(client(fetch).splitTask(SPLIT_BODY));
    expect(error).toMatchObject({ kind: 'offline', operation: 'health', retryable: true });
    expect(seen).toEqual([`${BASE}/health`]);
  });

  it('gives the wake-up the interactive timeout and the model call the coach one', async () => {
    vi.useFakeTimers();
    let healthAnswers = false;
    const seen: string[] = [];
    const fetch: CloudFetch = (url) => {
      seen.push(new URL(url).pathname);
      return healthAnswers && url.endsWith('/health')
        ? Promise.resolve(reply(200, HEALTH))
        : new Promise(() => undefined);
    };
    const c = client(fetch);

    const waking = failure(c.splitTask(SPLIT_BODY, { timeoutMs: 5 }));
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.interactiveMs);
    expect(await waking).toMatchObject({ kind: 'timeout', operation: 'health', retryable: true });
    expect(seen).toEqual(['/health']);

    healthAnswers = true;
    const thinking = failure(c.splitTask(SPLIT_BODY));
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.coachMs);
    // The server may still finish and bill it: never resent automatically.
    expect(await thinking).toMatchObject({
      kind: 'timeout',
      operation: 'splitTask',
      retryable: false,
    });
    expect(seen).toEqual(['/health', '/health', '/v1/coach/split-task']);
  });

  it('passes the caller signal to the wake-up', async () => {
    const controller = new AbortController();
    const fetch: CloudFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    const onWaking = vi.fn();
    const pending = client(fetch).splitTask(SPLIT_BODY, { signal: controller.signal, onWaking });
    controller.abort();
    expect(await failure(pending)).toMatchObject({ kind: 'aborted', operation: 'health' });
    expect(onWaking).toHaveBeenCalledTimes(1);
  });

  it('never fails a call because of the onWaking callback', async () => {
    const { fetch } = coachServer(() => reply(200, SPLIT_ANSWER));
    const onWaking = () => {
      throw new Error('ui bug');
    };
    await expect(client(fetch).splitTask(SPLIT_BODY, { onWaking })).resolves.toEqual(SPLIT_ANSWER);
  });

  it.each([
    ['coach_unavailable', 503, errorBody('coach_unavailable'), false],
    ['coach_incomplete', 502, errorBody('coach_incomplete'), false],
    ['proxy page', 502, '<html>Bad gateway</html>', false],
    ['internal_error', 500, errorBody('internal_error'), false],
    ['database_unavailable', 503, errorBody('database_unavailable'), false],
    ['quota_exceeded', 429, errorBody('quota_exceeded'), false],
    ['rate_limited', 429, errorBody('rate_limited', { retryAfterSeconds: 90 }), true],
    [
      'feature_disabled database_down',
      503,
      errorBody('feature_disabled', { feature: 'coach', reason: 'database_down' }),
      true,
    ],
    [
      'feature_disabled kill_switch',
      503,
      errorBody('feature_disabled', { feature: 'coach', reason: 'kill_switch' }),
      false,
    ],
  ] as const)('coach %s is retryable: %s', async (_name, status, body, retryable) => {
    const { fetch } = coachServer(() => reply(status, body));
    const error = await failure(client(fetch).splitTask(SPLIT_BODY));
    expect(error).toMatchObject({ kind: 'http', status, operation: 'splitTask', retryable });
  });

  it('never marks a lost or garbled coach answer retryable', async () => {
    let calls = 0;
    const offline: CloudFetch = async (url) => {
      calls += 1;
      if (url.endsWith('/health')) return reply(200, HEALTH);
      throw new TypeError('socket hang up');
    };
    expect(await failure(client(offline).interpret(INTERPRET_BODY))).toMatchObject({
      kind: 'offline',
      operation: 'interpret',
      retryable: false,
    });
    expect(calls).toBe(2);
    const portal = coachServer(() => reply(200, '<html>Wi-Fi login</html>'));
    expect(await failure(client(portal.fetch).weeklySummary(WEEKLY_BODY))).toMatchObject({
      kind: 'invalid_response',
      retryable: false,
    });
    // The rest of the client keeps the general rule.
    const quota = coachServer(() => reply(503, errorBody('coach_unavailable')));
    expect((await failure(client(quota.fetch).getCoachQuota())).retryable).toBe(true);
  });
});

const INTERPRET_BODY = { text: 'x', timeZone: 'Europe/Madrid', now: '2026-09-28T10:00:00.000Z' };
const WEEKLY_BODY = { week: '2026-W39', stats: null };

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

function day(date: string, rev: number, focusMinutes = 30): CloudDayStats {
  return {
    day: date,
    rev,
    focusMinutes,
    studyMinutes: 0,
    blocksCompleted: 1,
    studySessions: 0,
    attempts: 0,
    emergencyUnlocks: 0,
    punishments: 0,
    pointsEarned: 10,
    pointsLost: 0,
  };
}

function event(
  clientRef: string,
  occurredAt = '2026-09-28T09:00:00.000Z',
): AccountabilityEventInput {
  return { clientRef, kind: 'emergency_confirmed', occurredAt, countdownEndsAt: null };
}

const dayItem = (deviceId: string, stats: CloudDayStats): OutboxItem => ({
  type: 'day',
  deviceId,
  stats,
});
const eventItem = (e: AccountabilityEventInput): OutboxItem => ({ type: 'event', event: e });

describe('approvalOutcome', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  const state = (status: 'pending' | 'approved' | 'denied' | 'expired', deadline: string) => ({
    status,
    deadline,
    note: null,
    decidedAt: null,
  });

  const ends = '2026-09-28T10:05:00.000Z';

  it('fails open: only an explicit «no» denies', () => {
    expect(approvalOutcome(null, now, ends)).toBe('approved');
    // An approval is not final: another partner's «no» still replaces it until the deadline.
    expect(approvalOutcome(state('approved', '2026-09-28T10:04:30Z'), now, ends)).toBe('wait');
    expect(approvalOutcome(state('approved', '2026-09-28T10:04:30Z'), now, now)).toBe('approved');
    expect(approvalOutcome(state('expired', '2026-09-28T09:59:00Z'), now, ends)).toBe('approved');
    expect(approvalOutcome(state('pending', '2026-09-28T10:04:30Z'), now, ends)).toBe('wait');
    expect(approvalOutcome(state('denied', '2026-09-28T10:10:00Z'), now, ends)).toBe('denied');
    // A pending answer lasts until the local countdown ends, never longer.
    expect(approvalOutcome(state('pending', '2026-09-28T10:04:30Z'), now, now)).toBe('approved');
    expect(approvalOutcome(state('pending', '2026-09-28T10:04:30Z'), now, 'garbage')).toBe(
      'approved',
    );
    expect(approvalOutcome(state('denied', '2026-09-28T10:04:30Z'), now, now)).toBe('denied');
  });

  it('never compares the server deadline with the app clock', () => {
    // App clock 10 minutes fast: the server deadline (its clock) already looks past, but the
    // partner can still answer, so the app keeps waiting (and polling) until its countdown ends.
    const fastNow = new Date('2026-09-28T10:10:00.000Z');
    const fastEnds = new Date('2026-09-28T10:15:00.000Z');
    expect(approvalOutcome(state('pending', '2026-09-28T10:04:30Z'), fastNow, fastEnds)).toBe(
      'wait',
    );
    // App clock 10 minutes slow: the deadline looks far away, yet a stale `pending` (offline)
    // turns into `approved` exactly when the local countdown ends.
    const slowEnds = new Date('2026-09-28T09:55:00.000Z');
    const atEnd = new Date('2026-09-28T09:55:00.000Z');
    expect(approvalOutcome(state('pending', '2026-09-28T10:04:30Z'), atEnd, slowEnds)).toBe(
      'approved',
    );
  });
});

describe('daysToReupload', () => {
  it('keeps days the server lacks or holds at the same or a lower rev', () => {
    const local = [
      day('2026-09-24', 4),
      day('2026-09-25', 5),
      day('2026-09-26', 7),
      day('2026-09-27', 9),
    ];
    const server = {
      revs: [
        { day: '2026-09-24', rev: 6 },
        { day: '2026-09-25', rev: 5 },
        { day: '2026-09-26', rev: 3 },
      ],
    };
    expect(
      daysToReupload(local, server, new Date('2026-09-28T10:00:00.000Z')).map((d) => d.day),
    ).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
  });

  it('resends a same-rev day whose minutes grew after the last upload', () => {
    // A block that crossed midnight: the guardian wrote no new event after 23:50, so the day
    // closed at the same rev with more minutes, and a sign-out emptied the outbox before that
    // snapshot went out. The server lets an equal rev overwrite.
    const server = { revs: [{ day: '2026-09-27', rev: 42 }] };
    const local = [day('2026-09-27', 42, 95)];
    expect(daysToReupload(local, server, new Date('2026-09-28T10:00:00.000Z'))).toEqual(local);
  });

  it('leaves out local days older than the sync window, so years of history take four requests', () => {
    const now = new Date('2026-09-28T10:00:00.000Z');
    // Three years of local history, none of it on the server yet (a new device).
    const local = Array.from({ length: 3 * 365 }, (_, i) =>
      day(addDays('2026-09-28', i - 3 * 365 + 1), i + 1),
    );
    const out = daysToReupload(local, { revs: [] }, now);
    expect(out[0]?.day).toBe(syncWindowStart(now));
    expect(out.at(-1)?.day).toBe('2026-09-28');
    expect(out).toHaveLength(CLOUD_LIMITS.syncPastDays);
    expect(Math.ceil(out.length / CLOUD_LIMITS.syncBatchMax)).toBe(4);
  });
});

describe('syncWindowStart', () => {
  it('is never before the first day the server accepts, in any time zone', () => {
    const zones = ['Etc/GMT+12', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC'];
    const more = ['Europe/Madrid', 'Asia/Kolkata', 'Pacific/Auckland', 'Pacific/Kiritimati'];
    for (const at of [
      '2026-09-28T00:00:00.000Z',
      '2026-09-28T00:30:00.000Z',
      '2026-09-28T11:59:00.000Z',
      '2026-09-28T23:59:59.999Z',
      '2027-01-01T00:00:00.000Z',
    ]) {
      const now = new Date(at);
      const start = syncWindowStart(now);
      for (const zone of [...zones, ...more]) {
        // The server's window starts at `today − syncPastDays` in the profile's zone.
        const serverFirst = addDays(localDayIn(zone, now), -CLOUD_LIMITS.syncPastDays);
        expect(start >= serverFirst, `${at} ${zone}`).toBe(true);
      }
      // One day of margin, no more.
      expect(start).toBe(addDays(now.toISOString().slice(0, 10), 1 - CLOUD_LIMITS.syncPastDays));
    }
  });
});

describe('cloudWasReset', () => {
  const health = (db: 'up' | 'down' | 'unconfigured', serverEpoch: string | null) => ({
    db,
    serverEpoch,
  });

  it('is true only when the database answers with another epoch', () => {
    expect(cloudWasReset('epoch-1', health('up', 'epoch-2'))).toBe(true);
    expect(cloudWasReset('epoch-1', health('up', 'epoch-1'))).toBe(false);
  });

  it('reads a missing epoch as unknown, never as a reset', () => {
    // Database down (free Postgres in its grace period, a brief outage) or unconfigured.
    expect(cloudWasReset('epoch-1', health('down', null))).toBe(false);
    expect(cloudWasReset('epoch-1', health('unconfigured', null))).toBe(false);
    // Up, but the epoch could not be read.
    expect(cloudWasReset('epoch-1', health('up', null))).toBe(false);
    // An epoch next to a database that is not up is not trusted either.
    expect(cloudWasReset('epoch-1', health('down', 'epoch-2'))).toBe(false);
    // Nothing remembered yet: remember it, nothing to drop.
    expect(cloudWasReset(null, health('up', 'epoch-2'))).toBe(false);
    expect(cloudWasReset('', health('up', 'epoch-2'))).toBe(false);
  });
});

describe('newClientRef', () => {
  it('fits the clientRef format and does not repeat', () => {
    const refs = new Set(Array.from({ length: 200 }, newClientRef));
    expect(refs.size).toBe(200);
    for (const ref of refs) expect(ref).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

describe('coalesceOutbox', () => {
  it('keeps the highest rev per device and day, and every distinct event', () => {
    const items: OutboxItem[] = [
      dayItem('b', day('2026-09-27', 4)),
      dayItem('a', day('2026-09-27', 8)),
      eventItem(event('ref-000000000001')),
      dayItem('a', day('2026-09-26', 2)),
      dayItem('a', day('2026-09-27', 6)),
      eventItem(event('ref-000000000002')),
      eventItem(event('ref-000000000001', '2026-09-28T09:30:00.000Z')),
      dayItem('b', day('2026-09-27', 4, 99)),
    ];
    const out = coalesceOutbox(items);
    expect(
      out.map((i) =>
        i.type === 'event' ? i.event.clientRef : `${i.deviceId}:${i.stats.day}:${i.stats.rev}`,
      ),
    ).toEqual([
      'ref-000000000001',
      'ref-000000000002',
      'a:2026-09-26:2',
      'a:2026-09-27:8',
      'b:2026-09-27:4',
    ]);
    // The first copy of a repeated event stays; an equal rev keeps the later totals.
    expect(out[0]).toEqual(eventItem(event('ref-000000000001')));
    expect(out[4]?.type === 'day' && out[4].stats.focusMinutes).toBe(99);
  });
});

describe('nextRetryDelay', () => {
  it('stays between 30 s and 30 min and grows with failures', () => {
    let previousHigh = 0;
    for (let failures = 0; failures <= 60; failures += 1) {
      const low = nextRetryDelay(failures, () => 0);
      const high = nextRetryDelay(failures, () => 1);
      const mid = nextRetryDelay(failures, () => 0.5);
      for (const value of [low, high, mid]) {
        expect(value).toBeGreaterThanOrEqual(CLOUD_OUTBOX.retryMinMs);
        expect(value).toBeLessThanOrEqual(CLOUD_OUTBOX.retryMaxMs);
      }
      expect(low).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(high);
      expect(high).toBeGreaterThanOrEqual(previousHigh);
      previousHigh = high;
    }
    expect(nextRetryDelay(1, () => 1)).toBe(30_000);
    expect(nextRetryDelay(3, () => 0)).toBe(60_000);
    expect(nextRetryDelay(50, () => 1)).toBe(30 * 60_000);
  });

  it('honours a longer Retry-After, capped at 6 hours', () => {
    expect(nextRetryDelay(1, () => 0, 3_600_000)).toBe(3_600_000);
    expect(nextRetryDelay(1, () => 0, 1_000)).toBe(30_000);
    expect(nextRetryDelay(1, () => 0, 86_400_000)).toBe(CLOUD_OUTBOX.retryAfterMaxMs);
  });
});

describe('normalizeOutboxState', () => {
  it('drops malformed items and fields', () => {
    const state = normalizeOutboxState({
      items: [
        dayItem('dev', day('2026-09-27', 1)),
        { type: 'day', deviceId: '', stats: day('2026-09-27', 1) },
        { type: 'day', deviceId: 'dev', stats: { ...day('2026-09-27', 1), day: '2026-02-30' } },
        { type: 'day', deviceId: 'dev', stats: { ...day('2026-09-27', 1), rev: 1.5 } },
        eventItem(event('short')),
        eventItem({ ...event('ref-000000000009'), kind: 'reason_shared' as never }),
        eventItem(event('ref-000000000003')),
        null,
        'x',
      ],
      events: { failures: -3, notBefore: 'soon' },
      days: { failures: 2.5, notBefore: '2026-09-28T10:10:00.000Z' },
    });
    expect(state).toEqual({
      version: 2,
      items: [eventItem(event('ref-000000000003')), dayItem('dev', day('2026-09-27', 1))],
      events: { failures: 0, notBefore: null },
      days: { failures: 0, notBefore: '2026-09-28T10:10:00.000Z' },
    });
    expect(normalizeOutboxState(null)).toEqual({
      version: 2,
      items: [],
      events: { failures: 0, notBefore: null },
      days: { failures: 0, notBefore: null },
    });
  });

  it('keeps the items of a version 1 state and starts both lanes afresh', () => {
    // Version 1 had one backoff for the whole queue (a days 429 held every event).
    const state = normalizeOutboxState({
      version: 1,
      items: [eventItem(event('ref-000000000001')), dayItem('dev', day('2026-09-27', 1))],
      failures: 4,
      notBefore: '2026-09-28T11:00:00.000Z',
    });
    expect(state).toEqual({
      version: 2,
      items: [eventItem(event('ref-000000000001')), dayItem('dev', day('2026-09-27', 1))],
      events: { failures: 0, notBefore: null },
      days: { failures: 0, notBefore: null },
    });
  });
});

// ---------------------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------------------

type Answer = 'ok' | CloudError;

/** A fake server behind the outbox: stores days by rev and events by clientRef. */
function fakeServer() {
  const days = new Map<string, number>();
  const snapshots = new Map<string, CloudDayStats>();
  const events = new Map<string, number>();
  const calls: string[] = [];
  const answers: Answer[] = [];
  let onPut: (() => Promise<void>) | null = null;
  const next = (): Answer => answers.shift() ?? 'ok';
  const api = {
    putDays: vi.fn(async (body: PutDaysRequest) => {
      calls.push(`put:${body.deviceId}:${body.days.length}`);
      if (onPut) await onPut();
      const answer = next();
      if (answer !== 'ok') throw answer;
      const stale: string[] = [];
      for (const d of body.days) {
        const key = `${body.deviceId}:${d.day}`;
        const stored = days.get(key);
        if (stored !== undefined && stored > d.rev) stale.push(d.day);
        else {
          days.set(key, d.rev);
          snapshots.set(key, { ...d });
        }
      }
      return { accepted: body.days.length - stale.length, stale };
    }),
    postAccountabilityEvent: vi.fn(async (body: AccountabilityEventInput) => {
      calls.push(`event:${body.clientRef}`);
      // The server stores the event before the answer is lost (idempotent replay).
      events.set(body.clientRef, (events.get(body.clientRef) ?? 0) + 1);
      const answer = next();
      if (answer !== 'ok') throw answer;
      return { eventId: `id-${body.clientRef}`, approval: null };
    }),
  };
  return {
    api,
    days,
    snapshots,
    events,
    calls,
    answers,
    setOnPut: (fn: (() => Promise<void>) | null) => {
      onPut = fn;
    },
  };
}

const httpError = (status: number, code: string, extras: Record<string, unknown> = {}) =>
  new CloudError({
    kind: 'http',
    operation: 'test',
    status,
    details: { code: code as never, message: 'x', ...extras },
  });
const offline = () => new CloudError({ kind: 'offline', operation: 'test' });

function setup(initial: OutboxState | null = null, extra: Pick<OutboxOptions, 'onEventSent'> = {}) {
  let t = new Date('2026-09-28T10:00:00.000Z').getTime();
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const storage = memoryOutboxStorage(initial);
  const server = fakeServer();
  const outbox = createOutbox({
    storage,
    client: server.api,
    now: clock.now,
    random: () => 0,
    ...extra,
  });
  return { outbox, storage, server, clock };
}

const range = (n: number, rev = 1): CloudDayStats[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    return day(d, rev);
  });

describe('createOutbox', () => {
  it('sends events first, then days in batches of 100 per device', async () => {
    const { outbox, server, storage } = setup();
    await outbox.addDays('dev-a', range(250));
    await outbox.addDays('dev-b', range(3));
    await outbox.addEvent(event('ref-000000000001'));
    expect(await outbox.pending()).toBe(254);

    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 254, dropped: 0, remaining: 0 });
    expect(server.calls).toEqual([
      'event:ref-000000000001',
      'put:dev-a:100',
      'put:dev-a:100',
      'put:dev-a:50',
      'put:dev-b:3',
    ]);
    expect(storage.state?.items).toEqual([]);
    expect(await outbox.flush()).toMatchObject({ status: 'empty', sent: 0 });
  });

  it('collapses repeated uploads of a day to its latest rev', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    await outbox.addDays('dev', [day('2026-09-27', 5), day('2026-09-26', 2)]);
    await outbox.addDays('dev', [day('2026-09-27', 3)]);
    expect(await outbox.pending()).toBe(2);
    await outbox.flush();
    expect(server.api.putDays).toHaveBeenCalledTimes(1);
    expect(server.api.putDays.mock.calls[0]?.[0].days.map((d) => [d.day, d.rev])).toEqual([
      ['2026-09-26', 2],
      ['2026-09-27', 5],
    ]);
  });

  it('keeps a newer rev queued while an older one is in flight', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.setOnPut(async () => {
      server.setOnPut(null);
      await outbox.addDays('dev', [day('2026-09-27', 2)]);
    });
    const result = await outbox.flush();
    // The loop picks up the newer rev in the same flush.
    expect(result).toMatchObject({ status: 'done', sent: 2, remaining: 0 });
    expect(server.days.get('dev:2026-09-27')).toBe(2);
  });

  /** Makes the next putDays wait until `release` (resolves `entered` once it is in flight). */
  function holdNextPut(server: ReturnType<typeof fakeServer>) {
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    server.setOnPut(async () => {
      server.setOnPut(null);
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    return { inFlight, release: () => release() };
  }

  it('sends a same-rev snapshot queued while the older one is in flight', async () => {
    // A running block grows the minutes with no new guardian event: same rev, newer numbers.
    const { outbox, server, storage } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 42, 30)]);
    const put = holdNextPut(server);
    const flushing = outbox.flush();
    await put.inFlight;
    await outbox.addDays('dev', [day('2026-09-27', 42, 35)]);
    expect(await outbox.pending()).toBe(1);
    put.release();

    expect(await flushing).toMatchObject({ status: 'done', sent: 2, remaining: 0 });
    expect(server.calls).toEqual(['put:dev:1', 'put:dev:1']);
    expect(server.snapshots.get('dev:2026-09-27')).toMatchObject({ rev: 42, focusMinutes: 35 });
    expect(storage.state?.items).toEqual([]);
  });

  it('does not resend the snapshot in flight when it is queued again unchanged', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 42, 30)]);
    const put = holdNextPut(server);
    const flushing = outbox.flush();
    await put.inFlight;
    await outbox.addDays('dev', [day('2026-09-27', 42, 30), day('2026-09-26', 7)]);
    put.release();
    expect(await flushing).toMatchObject({ status: 'done', sent: 2, remaining: 0 });
    expect(server.api.putDays.mock.calls.map(([b]) => b.days.map((d) => d.day))).toEqual([
      ['2026-09-27'],
      ['2026-09-26'],
    ]);
  });

  it('drops a same-rev snapshot the server already holds at a higher rev', async () => {
    const { outbox, server } = setup();
    server.days.set('dev:2026-09-27', 50);
    await outbox.addDays('dev', [day('2026-09-27', 42, 30)]);
    const put = holdNextPut(server);
    const flushing = outbox.flush();
    await put.inFlight;
    await outbox.addDays('dev', [day('2026-09-27', 42, 35)]);
    put.release();
    expect(await flushing).toMatchObject({ status: 'done', sent: 1, remaining: 0 });
    expect(server.calls).toEqual(['put:dev:1']);
  });

  it('keeps a same-rev snapshot queued while its rejected twin was in flight', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 42, 1500)]);
    server.answers.push(
      httpError(400, 'validation_failed', {
        issues: [{ path: 'body.days.0.focusMinutes', message: 'too big' }],
      }),
    );
    const put = holdNextPut(server);
    const flushing = outbox.flush();
    await put.inFlight;
    await outbox.addDays('dev', [day('2026-09-27', 42, 35)]);
    put.release();
    expect(await flushing).toMatchObject({ status: 'done', sent: 1, dropped: 1, remaining: 0 });
    expect(server.snapshots.get('dev:2026-09-27')).toMatchObject({ rev: 42, focusMinutes: 35 });
  });

  it('replays an event whose answer was lost without duplicating it', async () => {
    const { outbox, server, clock } = setup();
    await outbox.addEvent(event('ref-000000000001'));
    server.answers.push(offline());
    const first = await outbox.flush();
    expect(first).toMatchObject({ status: 'retry_later', sent: 0, remaining: 1 });
    expect(first.error?.kind).toBe('offline');

    clock.advance(CLOUD_OUTBOX.retryMinMs);
    const second = await outbox.flush();
    expect(second).toMatchObject({ status: 'done', sent: 1, remaining: 0 });
    // Two requests with the same clientRef; the server dedupes on it.
    expect(server.calls).toEqual(['event:ref-000000000001', 'event:ref-000000000001']);
    expect(server.events.size).toBe(1);
  });

  it('hands the server answer of every sent event to onEventSent', async () => {
    const answers: Array<[string, PostAccountabilityEventResponse, number]> = [];
    const { outbox, server, clock, storage } = setup(null, {
      onEventSent: (e, response) => {
        answers.push([e.clientRef, response, storage.state?.items.length ?? -1]);
      },
    });
    await outbox.addEvent(event('ref-000000000001'));
    await outbox.addEvent(event('ref-000000000002'));
    server.answers.push('ok', offline());
    expect(await outbox.flush()).toMatchObject({ status: 'retry_later', sent: 1 });
    // Reported once the event left the queue; nothing for the one that failed.
    expect(answers).toEqual([
      ['ref-000000000001', { eventId: 'id-ref-000000000001', approval: null }, 1],
    ]);

    clock.advance(CLOUD_OUTBOX.retryMinMs);
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1 });
    expect(answers.map(([ref]) => ref)).toEqual(['ref-000000000001', 'ref-000000000002']);
  });

  it('keeps flushing when onEventSent throws or rejects', async () => {
    let calls = 0;
    const { outbox, server } = setup(null, {
      onEventSent: (e) => {
        calls += 1;
        if (e.clientRef.endsWith('1')) throw new Error('ui bug');
        return Promise.reject(new Error('async ui bug'));
      },
    });
    await outbox.addEvent(event('ref-000000000001'));
    await outbox.addEvent(event('ref-000000000002'));
    await outbox.addDays('dev', range(1));
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 3, remaining: 0 });
    expect(calls).toBe(2);
    expect(server.calls).toHaveLength(3);
  });

  it('backs off after failures and waits unless forced', async () => {
    const { outbox, server, clock, storage } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(offline(), offline());

    const first = await outbox.flush();
    expect(first.status).toBe('retry_later');
    expect(first.nextFlushAt?.toISOString()).toBe('2026-09-28T10:00:30.000Z');
    expect(storage.state?.days.failures).toBe(1);

    expect(await outbox.flush()).toMatchObject({ status: 'waiting', sent: 0, remaining: 1 });
    expect(server.calls).toHaveLength(1);

    const forced = await outbox.flush({ force: true });
    expect(forced.status).toBe('retry_later');
    expect(storage.state?.days.failures).toBe(2);
    expect(forced.nextFlushAt?.toISOString()).toBe('2026-09-28T10:00:30.000Z');

    clock.advance(30_000);
    expect(await outbox.nextFlushAt()).toBeNull();
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1, nextFlushAt: null });
    // The backoff is over; the next day totals keep the pace from this send.
    expect(storage.state?.days).toEqual({ failures: 0, notBefore: '2026-09-28T10:10:30.000Z' });
    expect(storage.state?.events).toEqual({ failures: 0, notBefore: null });
  });

  const rateLimited = (retryAfterMs: number) =>
    new CloudError({
      kind: 'http',
      operation: 'putDays',
      status: 429,
      details: { code: 'rate_limited', message: 'x' },
      retryAfterMs,
    });

  it('waits as long as the server asks', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(rateLimited(3_600_000));
    const result = await outbox.flush();
    expect(result.nextFlushAt?.toISOString()).toBe('2026-09-28T11:00:00.000Z');
  });

  it('never holds an event behind a 429 on day totals', async () => {
    // The hourly limit of PUT /v1/sync/days is shared by all of the user's computers.
    const { outbox, server, clock, storage } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(rateLimited(50 * 60_000));
    expect(await outbox.flush()).toMatchObject({ status: 'retry_later', sent: 0, remaining: 1 });

    // An event queued during the wait goes out at once; the day keeps waiting.
    clock.advance(60_000);
    await outbox.addEvent(event('ref-000000000001'));
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 1, remaining: 1, error: null });
    expect(result.nextFlushAt?.toISOString()).toBe('2026-09-28T10:50:00.000Z');
    expect(server.calls).toEqual(['put:dev:1', 'event:ref-000000000001']);
    expect(storage.state?.events).toEqual({ failures: 0, notBefore: null });

    // A 5xx on the days in the same flush does not hold the event either.
    clock.advance(50 * 60_000);
    await outbox.addEvent(event('ref-000000000002', '2026-09-28T10:51:00.000Z'));
    server.answers.push('ok', httpError(503, 'database_unavailable'));
    expect(await outbox.flush()).toMatchObject({ status: 'retry_later', sent: 1, remaining: 1 });
    expect(server.calls.slice(2)).toEqual(['event:ref-000000000002', 'put:dev:1']);
  });

  it('sends day totals after an event fails, and the event waits alone', async () => {
    const { outbox, server, storage } = setup();
    await outbox.addEvent(event('ref-000000000001'));
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(offline(), 'ok');
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'retry_later', sent: 1, remaining: 1 });
    expect(result.error?.kind).toBe('offline');
    expect(result.nextFlushAt?.toISOString()).toBe('2026-09-28T10:00:30.000Z');
    expect(server.calls).toEqual(['event:ref-000000000001', 'put:dev:1']);
    expect(storage.state?.events.failures).toBe(1);
    expect(storage.state?.days.failures).toBe(0);
  });

  it('sends day totals at most once per interval unless forced', async () => {
    const { outbox, server, clock } = setup();
    // A busy computer: a new snapshot and a flush every minute for an hour.
    for (let minute = 0; minute < 60; minute += 1) {
      await outbox.addDays('dev', [day('2026-09-28', minute + 1)]);
      const result = await outbox.flush();
      expect(['done', 'waiting']).toContain(result.status);
      if (result.status === 'waiting') expect(result.nextFlushAt).not.toBeNull();
      clock.advance(60_000);
    }
    const puts = server.api.putDays.mock.calls.length;
    expect(puts).toBe(60 / (CLOUD_OUTBOX.dayIntervalMs / 60_000));
    // Each round carries the latest snapshot.
    expect(server.days.get('dev:2026-09-28')).toBe(51);

    // At 11:00 the snapshot queued at 10:59 goes out.
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1, remaining: 0 });
    expect(server.days.get('dev:2026-09-28')).toBe(60);

    // An event still goes out at once while the days rest.
    await outbox.addDays('dev', [day('2026-09-28', 61)]);
    await outbox.addEvent(event('ref-000000000001', '2026-09-28T10:59:00.000Z'));
    const mixed = await outbox.flush();
    expect(mixed).toMatchObject({ status: 'done', sent: 1, remaining: 1 });
    expect(mixed.nextFlushAt?.toISOString()).toBe('2026-09-28T11:10:00.000Z');

    // «Sincronizar ahora» does not wait.
    expect(await outbox.flush({ force: true })).toMatchObject({ status: 'done', sent: 1 });
    expect(server.days.get('dev:2026-09-28')).toBe(61);
    expect(server.api.putDays).toHaveBeenCalledTimes(puts + 2);
  });

  it('drops days before the sync window without a request', async () => {
    const { outbox, server, clock } = setup();
    const first = syncWindowStart(clock.now());
    expect(first).toBe('2025-08-25');
    await outbox.addDays('dev', [day(addDays(first, -1), 1), day(first, 1), day('2026-09-28', 1)]);
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 2, dropped: 1, remaining: 0 });
    expect(server.api.putDays.mock.calls.map(([b]) => b.days.map((d) => d.day))).toEqual([
      [first, '2026-09-28'],
    ]);
  });

  it('empties the queue on 401 (signed out elsewhere)', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', range(3));
    await outbox.addEvent(event('ref-000000000001'));
    server.answers.push(httpError(401, 'unauthorized'));
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'signed_out', remaining: 0 });
    expect(await outbox.pending()).toBe(0);
  });

  it('drops what the server will never accept and sends the rest', async () => {
    const { outbox, server } = setup();
    await outbox.addEvent(event('ref-000000000001'));
    await outbox.addEvent(event('ref-000000000002'));
    await outbox.addDays('dev-a', range(3));
    await outbox.addDays('dev-b', range(2));
    server.answers.push(
      httpError(400, 'validation_failed'), // the first event
      'ok', // the second event
      httpError(400, 'validation_failed', {
        issues: [{ path: 'body.days.1.day', message: 'out of range' }],
      }),
      'ok', // dev-a without the rejected day
      httpError(403, 'consent_required', { consent: 'syncStats' }), // dev-b
    );
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 3, dropped: 4, remaining: 0 });
    expect(server.calls).toEqual([
      'event:ref-000000000001',
      'event:ref-000000000002',
      'put:dev-a:3',
      'put:dev-a:2',
      'put:dev-b:2',
    ]);
    expect([...server.days.keys()]).toEqual(['dev-a:2026-01-01', 'dev-a:2026-01-03']);
  });

  it('keeps items while the server lacks the feature', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', range(2));
    server.answers.push(
      httpError(503, 'feature_disabled', { feature: 'sync', reason: 'missing_key' }),
    );
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'retry_later', dropped: 0, remaining: 2 });
  });

  it('drops events too old for the server without a request', async () => {
    const { outbox, server } = setup();
    await outbox.addEvent(event('ref-000000000001', '2026-09-20T09:00:00.000Z'));
    await outbox.addEvent(event('ref-000000000002', '2026-09-22T09:00:00.000Z'));
    const result = await outbox.flush();
    expect(result).toMatchObject({ status: 'done', sent: 1, dropped: 1 });
    expect(server.calls).toEqual(['event:ref-000000000002']);
  });

  it('runs one flush at a time', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', range(2));
    const [a, b] = await Promise.all([outbox.flush(), outbox.flush()]);
    expect(a).toBe(b);
    expect(server.calls).toEqual(['put:dev:2']);
  });

  it('keeps an event without a send time (the client stamps it when sending)', async () => {
    const { outbox, storage, server } = setup();
    await outbox.addEvent({ ...event('ref-000000000001'), sentAt: 'old' } as never);
    expect(storage.state?.items).toEqual([eventItem(event('ref-000000000001'))]);
    await outbox.flush();
    expect(server.api.postAccountabilityEvent).toHaveBeenCalledWith(event('ref-000000000001'));
  });

  it('survives a restart through its storage', async () => {
    const { outbox, storage } = setup();
    await outbox.addDays('dev', range(2));
    await outbox.addEvent(event('ref-000000000001'));
    const restarted = setup(storage.state);
    expect(await restarted.outbox.pending()).toBe(3);
    await restarted.outbox.flush();
    expect(restarted.server.calls).toEqual(['event:ref-000000000001', 'put:dev:2']);
  });

  it('rejects malformed input and clears on demand', async () => {
    const { outbox } = setup();
    await expect(outbox.addEvent(event('bad ref!'))).rejects.toThrow(RangeError);
    await expect(outbox.addDays('', range(1))).rejects.toThrow(RangeError);
    await expect(
      outbox.addDays('dev', [{ ...day('2026-09-27', 1), day: '27/09' }]),
    ).rejects.toThrow(RangeError);
    await outbox.addDays('dev', range(2));
    await outbox.clear();
    expect(await outbox.pending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Sending an event now
// ---------------------------------------------------------------------------------------

describe('sendAccountabilityEvent', () => {
  const request = (clientRef = 'ref-000000000001'): AccountabilityEventInput => ({
    clientRef,
    kind: 'emergency_requested',
    occurredAt: '2026-09-28T10:00:00.000Z',
    countdownEndsAt: '2026-09-28T10:10:00.000Z',
  });
  const pending: PostAccountabilityEventResponse = {
    eventId: 'ev-1',
    approval: {
      status: 'pending',
      deadline: '2026-09-28T10:09:30.000Z',
      note: null,
      decidedAt: null,
    },
  };

  it('returns the answer at once and queues nothing', async () => {
    const client = { postAccountabilityEvent: vi.fn(async () => pending) };
    const outbox = { addEvent: vi.fn(async () => undefined) };
    const onWaking = vi.fn();
    const result = await sendAccountabilityEvent(client, outbox, request(), { onWaking });
    expect(result).toEqual({ status: 'sent', response: pending, error: null });
    expect(client.postAccountabilityEvent).toHaveBeenCalledWith(request(), { onWaking });
    expect(outbox.addEvent).not.toHaveBeenCalled();
  });

  it('queues it when it cannot go out now, and the outbox recovers the answer', async () => {
    // The first POST reaches the server, which stores the event, but the answer is lost.
    const stored = new Map<string, PostAccountabilityEventResponse>();
    let lose = true;
    const client = {
      putDays: vi.fn(async () => ({ accepted: 0, stale: [] })),
      postAccountabilityEvent: vi.fn(async (e: AccountabilityEventInput) => {
        if (!stored.has(e.clientRef)) stored.set(e.clientRef, pending);
        if (lose) {
          lose = false;
          throw new CloudError({ kind: 'timeout', operation: 'postAccountabilityEvent' });
        }
        return stored.get(e.clientRef) ?? pending;
      }),
    };
    const onEventSent = vi.fn();
    const outbox = createOutbox({
      storage: memoryOutboxStorage(),
      client,
      onEventSent,
      now: () => new Date('2026-09-28T10:01:00.000Z'),
    });

    const result = await sendAccountabilityEvent(client, outbox, {
      ...request(),
      sentAt: 'stale',
    } as AccountabilityEventInput);
    expect(result).toMatchObject({ status: 'queued', response: null, error: { kind: 'timeout' } });
    expect(await outbox.pending()).toBe(1);

    // The replay of the same clientRef answers the stored event: the eventId is not lost.
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1 });
    expect(client.postAccountabilityEvent.mock.calls.map(([e]) => e)).toEqual([
      { ...request(), sentAt: 'stale' },
      request(),
    ]);
    expect(onEventSent).toHaveBeenCalledWith(request(), pending);
  });

  it.each([
    ['offline', new CloudError({ kind: 'offline', operation: 'health' })],
    ['aborted', new CloudError({ kind: 'aborted', operation: 'postAccountabilityEvent' })],
    ['server error', httpError(503, 'database_unavailable')],
    [
      'feature off',
      httpError(503, 'feature_disabled', { feature: 'social', reason: 'missing_key' }),
    ],
  ])('queues it after %s', async (_name, error) => {
    const client = { postAccountabilityEvent: vi.fn(async () => Promise.reject(error)) };
    const outbox = { addEvent: vi.fn(async () => undefined) };
    const result = await sendAccountabilityEvent(client, outbox, request());
    expect(result).toEqual({ status: 'queued', response: null, error });
    expect(outbox.addEvent).toHaveBeenCalledWith(request());
  });

  it('drops what the server refuses for good and never queues after a 401', async () => {
    const outbox = { addEvent: vi.fn(async () => undefined) };
    const refused = httpError(400, 'validation_failed');
    const dropped = await sendAccountabilityEvent(
      { postAccountabilityEvent: async () => Promise.reject(refused) },
      outbox,
      request(),
    );
    expect(dropped).toEqual({ status: 'dropped', response: null, error: refused });
    const unauthorized = httpError(401, 'unauthorized');
    const signedOut = await sendAccountabilityEvent(
      { postAccountabilityEvent: async () => Promise.reject(unauthorized) },
      outbox,
      request(),
    );
    expect(signedOut).toEqual({ status: 'signed_out', response: null, error: unauthorized });
    expect(outbox.addEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed event before sending anything', async () => {
    const client = { postAccountabilityEvent: vi.fn(async () => pending) };
    const outbox = { addEvent: vi.fn(async () => undefined) };
    await expect(sendAccountabilityEvent(client, outbox, request('bad ref!'))).rejects.toThrow(
      RangeError,
    );
    expect(client.postAccountabilityEvent).not.toHaveBeenCalled();
  });

  it('lets errors that are not CloudErrors through', async () => {
    const bug = new TypeError('bug');
    const outbox = { addEvent: vi.fn(async () => undefined) };
    await expect(
      sendAccountabilityEvent(
        { postAccountabilityEvent: async () => Promise.reject(bug) },
        outbox,
        request(),
      ),
    ).rejects.toBe(bug);
    expect(outbox.addEvent).not.toHaveBeenCalled();
  });
});
