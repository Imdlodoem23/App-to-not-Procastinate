import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudDayStats,
  CloudFetch,
  OutboxItem,
  OutboxState,
  PostAccountabilityEventRequest,
  PutDaysRequest,
} from '../src/cloud-api';
import {
  CLOUD_OUTBOX,
  CLOUD_TIMEOUTS,
  CloudError,
  approvalOutcome,
  coalesceOutbox,
  createCloudClient,
  createOutbox,
  daysToReupload,
  memoryOutboxStorage,
  newClientRef,
  nextRetryDelay,
  normalizeOutboxState,
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
    const fetch: CloudFetch = () => new Promise(() => undefined);
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
    await vi.advanceTimersByTimeAsync(CLOUD_TIMEOUTS.coachMs);
    await all;
    expect(settled).toHaveLength(3);
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
): PostAccountabilityEventRequest {
  return { clientRef, kind: 'emergency_confirmed', occurredAt, countdownEndsAt: null };
}

const dayItem = (deviceId: string, stats: CloudDayStats): OutboxItem => ({
  type: 'day',
  deviceId,
  stats,
});
const eventItem = (e: PostAccountabilityEventRequest): OutboxItem => ({ type: 'event', event: e });

describe('approvalOutcome', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  const state = (status: 'pending' | 'approved' | 'denied' | 'expired', deadline: string) => ({
    status,
    deadline,
    note: null,
    decidedAt: null,
  });

  it('fails open: only an explicit «no» denies', () => {
    expect(approvalOutcome(null, now)).toBe('approved');
    expect(approvalOutcome(state('approved', '2026-09-28T10:10:00Z'), now)).toBe('approved');
    expect(approvalOutcome(state('expired', '2026-09-28T09:59:00Z'), now)).toBe('approved');
    expect(approvalOutcome(state('pending', '2026-09-28T10:00:00Z'), now)).toBe('approved');
    expect(approvalOutcome(state('pending', 'garbage'), now)).toBe('approved');
    expect(approvalOutcome(state('pending', '2026-09-28T10:00:01Z'), now)).toBe('wait');
    expect(approvalOutcome(state('denied', '2026-09-28T10:10:00Z'), now)).toBe('denied');
  });
});

describe('daysToReupload', () => {
  it('keeps days the server lacks or holds at a lower rev', () => {
    const local = [day('2026-09-25', 5), day('2026-09-26', 7), day('2026-09-27', 9)];
    const server = {
      revs: [
        { day: '2026-09-25', rev: 5 },
        { day: '2026-09-26', rev: 3 },
      ],
    };
    expect(daysToReupload(local, server).map((d) => d.day)).toEqual(['2026-09-26', '2026-09-27']);
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
      failures: -3,
      notBefore: 'soon',
    });
    expect(state).toEqual({
      version: 1,
      items: [eventItem(event('ref-000000000003')), dayItem('dev', day('2026-09-27', 1))],
      failures: 0,
      notBefore: null,
    });
    expect(normalizeOutboxState(null)).toEqual({
      version: 1,
      items: [],
      failures: 0,
      notBefore: null,
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
        else days.set(key, d.rev);
      }
      return { accepted: body.days.length - stale.length, stale };
    }),
    postAccountabilityEvent: vi.fn(async (body: PostAccountabilityEventRequest) => {
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

function setup(initial: OutboxState | null = null) {
  let t = new Date('2026-09-28T10:00:00.000Z').getTime();
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const storage = memoryOutboxStorage(initial);
  const server = fakeServer();
  const outbox = createOutbox({ storage, client: server.api, now: clock.now, random: () => 0 });
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

  it('backs off after failures and waits unless forced', async () => {
    const { outbox, server, clock, storage } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(offline(), offline());

    const first = await outbox.flush();
    expect(first.status).toBe('retry_later');
    expect(first.nextFlushAt?.toISOString()).toBe('2026-09-28T10:00:30.000Z');
    expect(storage.state?.failures).toBe(1);

    expect(await outbox.flush()).toMatchObject({ status: 'waiting', sent: 0, remaining: 1 });
    expect(server.calls).toHaveLength(1);

    const forced = await outbox.flush({ force: true });
    expect(forced.status).toBe('retry_later');
    expect(storage.state?.failures).toBe(2);
    expect(forced.nextFlushAt?.toISOString()).toBe('2026-09-28T10:00:30.000Z');

    clock.advance(30_000);
    expect(await outbox.nextFlushAt()).toBeNull();
    expect(await outbox.flush()).toMatchObject({ status: 'done', sent: 1 });
    expect(storage.state).toMatchObject({ failures: 0, notBefore: null });
  });

  it('waits as long as the server asks', async () => {
    const { outbox, server } = setup();
    await outbox.addDays('dev', [day('2026-09-27', 1)]);
    server.answers.push(
      new CloudError({
        kind: 'http',
        operation: 'putDays',
        status: 429,
        details: { code: 'rate_limited', message: 'x' },
        retryAfterMs: 3_600_000,
      }),
    );
    const result = await outbox.flush();
    expect(result.nextFlushAt?.toISOString()).toBe('2026-09-28T11:00:00.000Z');
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
