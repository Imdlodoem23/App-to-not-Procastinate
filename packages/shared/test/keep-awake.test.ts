import { describe, expect, it } from 'vitest';
import type { KeepAwakeConfig } from '../src/domain';
import { EVENT_TYPES, KEEP_AWAKE_ERRORS, KEEP_AWAKE_OFF_REASONS } from '../src/domain';
import type { KeepAwakeRequest, KeepAwakeState } from '../src/guardian-api';
import {
  DEFAULT_KEEP_AWAKE,
  GUARDIAN_CAPABILITIES,
  GUARDIAN_ENDPOINTS,
  GUARDIAN_LIMITS,
  GUARDIAN_PATHS,
  KEEP_AWAKE_PRESET_MINUTES,
  apiContractSnapshot,
  createGuardianClient,
  isKeepAwakeRequest,
  isKeepAwakeResponse,
  isKeepAwakeState,
  isWireEvent,
  keepAwakeConfigSchema,
  keepAwakeRequest,
  keepAwakeRequestIsNoop,
  keepAwakeRequestSchema,
  keepAwakeStateSchema,
  stateResponseSchema,
  validateRequest,
  validateResponse,
  validationErrorCode,
} from '../src/guardian-api';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const EPOCH = 'ep_0123456789abcdefABCD';
const SINCE = '2026-09-29T16:30:00.000Z';
const UNTIL = '2026-09-29T17:30:00.000Z';

function config(overrides: Partial<KeepAwakeConfig> = {}): KeepAwakeConfig {
  return { on: true, durationMinutes: 60, display: true, since: SINCE, until: UNTIL, ...overrides };
}

function state(overrides: Partial<KeepAwakeState> = {}): KeepAwakeState {
  return { ...config(), active: true, error: null, ...overrides };
}

const OFF: KeepAwakeState = { ...DEFAULT_KEEP_AWAKE, active: false, error: null };

function request(overrides: Partial<KeepAwakeRequest> = {}): KeepAwakeRequest {
  return { on: true, durationMinutes: 60, display: true, ...overrides };
}

function issueOf(value: unknown): { path: string; issue: string } | null {
  const r = validateRequest(keepAwakeRequestSchema, value);
  return r.ok ? null : { path: r.issue.path, issue: r.issue.issue };
}

function event(type: string, data: unknown): unknown {
  return {
    v: 1,
    epoch: EPOCH,
    seq: 3,
    at: SINCE,
    wallOffsetMs: 0,
    day: '2026-09-29',
    type,
    points: 0,
    xp: 0,
    txEnd: true,
    req: null,
    data,
  };
}

// ---------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------

describe('keep-awake contract', () => {
  it('adds the capability, the events and the two routes (app token, no idempotency key)', () => {
    expect(GUARDIAN_CAPABILITIES).toContain('keep_awake');
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining(['keep_awake_on', 'keep_awake_updated', 'keep_awake_off']),
    );
    const routes = GUARDIAN_ENDPOINTS.filter((e) => e.path === GUARDIAN_PATHS.keepAwake);
    expect(routes.map((e) => `${e.method} ${e.id}`)).toEqual([
      'GET getKeepAwake',
      'PUT setKeepAwake',
    ]);
    for (const e of routes) {
      expect(e.auth).toBe('app');
      expect(e.idempotencyKey).toBe(false);
      expect(e.longPoll).toBe(false);
      expect(e.testOnly).toBe(false);
    }
    expect(KEEP_AWAKE_ERRORS).toEqual(['unsupported', 'failed']);
    expect(KEEP_AWAKE_OFF_REASONS).toEqual(['user', 'expired']);
  });

  it('offers presets inside the accepted range', () => {
    expect(KEEP_AWAKE_PRESET_MINUTES).toEqual([30, 60, 120, 240]);
    for (const m of KEEP_AWAKE_PRESET_MINUTES) {
      expect(m).toBeGreaterThanOrEqual(GUARDIAN_LIMITS.keepAwakeMinMinutes);
      expect(m).toBeLessThanOrEqual(GUARDIAN_LIMITS.keepAwakeMaxMinutes);
    }
  });

  it('embeds the default (off, until turned off, screen on too) for the guardian', () => {
    expect(DEFAULT_KEEP_AWAKE).toEqual({
      on: false,
      durationMinutes: null,
      display: true,
      since: null,
      until: null,
    });
    expect(validateResponse(keepAwakeConfigSchema, DEFAULT_KEEP_AWAKE).ok).toBe(true);
    const snap = apiContractSnapshot();
    expect(snap.defaultKeepAwake).toEqual(DEFAULT_KEEP_AWAKE);
    expect(snap.limits.keepAwakeMinMinutes).toBe(5);
    expect(snap.limits.keepAwakeMaxMinutes).toBe(1440);
  });
});

// ---------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------

describe('keepAwakeRequestSchema', () => {
  it('accepts a duration, «Hasta que lo desactive» and turning it off', () => {
    expect(isKeepAwakeRequest(request())).toBe(true);
    expect(isKeepAwakeRequest(request({ durationMinutes: null }))).toBe(true);
    expect(isKeepAwakeRequest(request({ on: false }))).toBe(true);
    expect(isKeepAwakeRequest(request({ on: false, durationMinutes: null, display: false }))).toBe(
      true,
    );
    for (const m of [5, ...KEEP_AWAKE_PRESET_MINUTES, 1440]) {
      expect(isKeepAwakeRequest(request({ durationMinutes: m }))).toBe(true);
    }
  });

  it('rejects out-of-range durations with duration_out_of_range', () => {
    for (const m of [0, 4, 1441]) {
      const problem = validateRequest(keepAwakeRequestSchema, request({ durationMinutes: m }));
      expect(problem.ok).toBe(false);
      if (!problem.ok) {
        expect(problem.issue.path).toBe('durationMinutes');
        expect(validationErrorCode(problem.issue)).toBe('duration_out_of_range');
      }
    }
    expect(issueOf(request({ durationMinutes: 30.5 }))).toEqual({
      path: 'durationMinutes',
      issue: 'type',
    });
  });

  it('requires every field and rejects unknown ones (since and until are the guardian’s)', () => {
    expect(issueOf({ on: true, display: true })).toEqual({
      path: 'durationMinutes',
      issue: 'required',
    });
    expect(issueOf({ durationMinutes: 30, display: true })).toEqual({
      path: 'on',
      issue: 'required',
    });
    expect(issueOf({ ...request(), until: UNTIL })).toEqual({
      path: 'until',
      issue: 'unknown_field',
    });
    expect(issueOf({ ...request(), on: 'yes' })).toEqual({ path: 'on', issue: 'type' });
    const unknown = validateRequest(keepAwakeRequestSchema, { ...request(), minutes: 30 });
    expect(unknown.ok ? null : validationErrorCode(unknown.issue)).toBe('unknown_field');
  });
});

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

describe('keep-awake responses', () => {
  it('validates on, off, indefinite and error states', () => {
    expect(isKeepAwakeState(state())).toBe(true);
    expect(isKeepAwakeState(state({ durationMinutes: null, until: null }))).toBe(true);
    expect(isKeepAwakeState(OFF)).toBe(true);
    expect(isKeepAwakeState({ ...OFF, durationMinutes: 120, display: false })).toBe(true);
    expect(isKeepAwakeState({ ...OFF, error: 'unsupported' })).toBe(true);
    expect(isKeepAwakeState(state({ active: false, error: 'failed' }))).toBe(true);
    expect(isKeepAwakeState(state({ active: false, error: 'unsupported' }))).toBe(true);
    expect(isKeepAwakeResponse({ keepAwake: state() })).toBe(true);
  });

  it('checks the invariants', () => {
    const bad: Array<[Partial<KeepAwakeState>, string]> = [
      [{ on: false }, 'since'],
      [{ on: false, since: null }, 'until'],
      [{ since: null }, 'since'],
      [{ until: null }, 'until'],
      [{ durationMinutes: null }, 'until'],
      [{ until: SINCE }, 'until'],
      [{ error: 'failed' }, 'error'],
      [{ error: 'nope' as never }, 'error'],
      [{ durationMinutes: 2 }, 'durationMinutes'],
    ];
    for (const [overrides, path] of bad) {
      const r = validateResponse(keepAwakeStateSchema, state(overrides));
      expect(r.ok ? null : r.issue.path, JSON.stringify(overrides)).toBe(path);
    }
    const activeOff = validateResponse(keepAwakeStateSchema, { ...OFF, active: true });
    expect(activeOff.ok ? null : activeOff.issue.path).toBe('active');
    const failedOff = validateResponse(keepAwakeStateSchema, { ...OFF, error: 'failed' });
    expect(failedOff.ok ? null : failedOff.issue.path).toBe('error');
  });

  it('keeps /v1/state.keepAwake optional for older guardians, validated when present', () => {
    const absent = validateResponse(stateResponseSchema, {});
    expect(absent.ok ? null : absent.issue.path).not.toBe('keepAwake');
    const present = validateResponse(stateResponseSchema, { keepAwake: state() });
    expect(present.ok ? null : present.issue.path).not.toBe('keepAwake');
    // A full state with an invalid keepAwake is in guardian-api.test.ts.
  });
});

// ---------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------

describe('keep-awake events', () => {
  it('validates the three events with the whole configuration (trusted times)', () => {
    expect(isWireEvent(event('keep_awake_on', { keepAwake: config() }))).toBe(true);
    expect(
      isWireEvent(
        event('keep_awake_on', { keepAwake: config({ durationMinutes: null, until: null }) }),
      ),
    ).toBe(true);
    expect(
      isWireEvent(event('keep_awake_updated', { keepAwake: config({ display: false }) })),
    ).toBe(true);
    expect(
      isWireEvent(
        event('keep_awake_updated', { keepAwake: { ...DEFAULT_KEEP_AWAKE, display: false } }),
      ),
    ).toBe(true);
    for (const reason of KEEP_AWAKE_OFF_REASONS) {
      expect(
        isWireEvent(
          event('keep_awake_off', {
            keepAwake: { ...DEFAULT_KEEP_AWAKE, durationMinutes: 60 },
            reason,
          }),
        ),
      ).toBe(true);
    }
  });

  it('rejects inconsistent events', () => {
    expect(isWireEvent(event('keep_awake_on', { keepAwake: DEFAULT_KEEP_AWAKE }))).toBe(false);
    expect(isWireEvent(event('keep_awake_off', { keepAwake: config(), reason: 'user' }))).toBe(
      false,
    );
    expect(
      isWireEvent(event('keep_awake_off', { keepAwake: DEFAULT_KEEP_AWAKE, reason: 'reboot' })),
    ).toBe(false);
    expect(isWireEvent(event('keep_awake_off', { keepAwake: DEFAULT_KEEP_AWAKE }))).toBe(false);
    expect(isWireEvent(event('keep_awake_on', { keepAwake: { ...config(), active: true } }))).toBe(
      true,
    ); // open mode: unknown fields are ignored
  });

  it('reads epochs with and without a kept keep-awake configuration', () => {
    const kept = {
      blocks: [],
      punishments: [],
      allowances: [],
      schedules: [],
      settings: {
        timezone: 'Europe/Madrid',
        dailyGoalMinutes: 60,
        attemptPenalties: true,
        punishment: { level: 'distractions', minutes: 60 },
        closeBrowsersWithoutExtension: false,
        serverTimeCheck: true,
        studyWhitelist: { extraDomains: [], extraProcesses: [] },
      },
      pendingSettings: [],
      materializedOccurrences: [],
    };
    const data = (k: unknown): unknown => ({
      reason: 'data_deleted',
      previousEpoch: null,
      carryOverBalance: 0,
      escalation: { lastCountedAt: null, index: 0 },
      kept: k,
    });
    expect(isWireEvent(event('epoch_started', data(kept)))).toBe(true);
    expect(isWireEvent(event('epoch_started', data({ ...kept, keepAwake: config() })))).toBe(true);
    expect(isWireEvent(event('epoch_started', data({ ...kept, keepAwake: { on: true } })))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------------------
// Helpers and client
// ---------------------------------------------------------------------------------------

describe('keep-awake helpers', () => {
  it('builds full PUT bodies from the current configuration', () => {
    const current = state();
    expect(keepAwakeRequest(current, { on: false })).toEqual({
      on: false,
      durationMinutes: 60,
      display: true,
    });
    expect(keepAwakeRequest(OFF, { on: true, durationMinutes: 30 })).toEqual({
      on: true,
      durationMinutes: 30,
      display: true,
    });
    expect(keepAwakeRequest(current, { durationMinutes: null })).toEqual({
      on: true,
      durationMinutes: null,
      display: true,
    });
    expect(keepAwakeRequest(current, { display: false }).display).toBe(false);
  });

  it('tells when a PUT changes nothing (a retry never restarts the countdown)', () => {
    expect(keepAwakeRequestIsNoop(state(), request())).toBe(true);
    expect(keepAwakeRequestIsNoop(state(), request({ durationMinutes: 120 }))).toBe(false);
    expect(keepAwakeRequestIsNoop(state(), request({ display: false }))).toBe(false);
    expect(keepAwakeRequestIsNoop(OFF, request({ on: false, durationMinutes: null }))).toBe(true);
  });
});

describe('keep-awake client', () => {
  it('GETs and PUTs /v1/keep-awake with the app token and validates the answer', async () => {
    const calls: Array<{ method: string; url: string; body: string | null; auth: string | null }> =
      [];
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
        auth: headers.get('Authorization'),
      });
      const payload =
        init?.method === 'PUT' ? { keepAwake: state({ durationMinutes: 30 }) } : { keepAwake: OFF };
      if (init?.method === 'PUT') {
        payload.keepAwake.until = '2026-09-29T17:00:00.000Z';
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const client = createGuardianClient({ token: 'cta_x', fetch: fetchImpl });
    expect((await client.getKeepAwake()).keepAwake).toEqual(OFF);
    const put = await client.setKeepAwake(request({ durationMinutes: 30 }));
    expect(put.keepAwake.on).toBe(true);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/keep-awake',
      'PUT /v1/keep-awake',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer cta_x')).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? 'null')).toEqual({
      on: true,
      durationMinutes: 30,
      display: true,
    });
  });

  it('refuses an invalid answer', async () => {
    const client = createGuardianClient({
      token: 'cta_x',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ keepAwake: { ...OFF, active: true } }), { status: 200 }),
        ),
    });
    await expect(client.getKeepAwake()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
