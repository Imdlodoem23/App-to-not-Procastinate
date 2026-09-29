import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Block, DailyLimit, DailyLimitDefinition, WireEvent } from '../src/domain';
import { BLOCK_KINDS, EVENT_TYPES, LIMIT_MODES, isIdOf } from '../src/domain';
import type { DailyLimitInput, Schema, UsageReportRequest } from '../src/guardian-api';
import {
  ALL_WEEKDAYS,
  GUARDIAN_CAPABILITIES,
  GUARDIAN_ENDPOINTS,
  GUARDIAN_LIMITS,
  GUARDIAN_PATHS,
  blockSchema,
  clampUsageInterval,
  dailyLimitInputSchema,
  deleteDataResponseSchema,
  emptyAllow,
  emptyTargets,
  extRulesResponseSchema,
  isDailyLimit,
  isDailyLimitInput,
  isUsageReportRequest,
  isUsageReportResponse,
  isWireEvent,
  limitDefinitionWeakens,
  limitInputFromLimit,
  limitModeRank,
  limitUsageCredit,
  pendingLimitDelayKept,
  splitLimitChange,
  stateResponseSchema,
  usageReportRequestSchema,
  validateRequest,
  validateResponse,
  validationErrorCode,
} from '../src/guardian-api';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const BODY = '0123456789abcdefABCD';
const LIM = `lim_${BODY}` as const;
const BLK = `blk_${BODY}` as const;
const EPOCH = `ep_${BODY}` as const;
const NOW = '2026-09-27T16:42:00.000Z';
const MIDNIGHT = '2026-09-27T22:00:00.000Z';

function definition(overrides: Partial<DailyLimitDefinition> = {}): DailyLimitDefinition {
  return {
    name: 'YouTube',
    enabled: true,
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    dailyMinutes: 30,
    days: [...ALL_WEEKDAYS],
    mode: 'strict',
    reason: '',
    ...overrides,
  };
}

function input(overrides: Partial<DailyLimitInput> = {}): DailyLimitInput {
  return { ...definition(), acknowledgeNoEmergency: false, ...overrides };
}

function limit(overrides: Partial<DailyLimit> = {}): DailyLimit {
  return {
    ...definition(),
    id: LIM,
    createdAt: NOW,
    updatedAt: NOW,
    day: '2026-09-27',
    appliesToday: true,
    usedTodaySeconds: 720,
    remainingTodaySeconds: 1080,
    reachedAt: null,
    activeBlockId: null,
    pendingChange: null,
    ...overrides,
  };
}

function limitBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: BLK,
    kind: 'limit',
    mode: 'strict',
    status: 'active',
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    reason: '',
    createdAt: NOW,
    startsAt: NOW,
    endsAt: MIDNIGHT,
    originalEndsAt: MIDNIGHT,
    endedAt: null,
    extendedMinutes: 0,
    scheduleId: null,
    punishmentId: null,
    limitId: LIM,
    attemptsCounted: 0,
    emergencyEligible: true,
    pointsDelta: null,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageReportRequest> = {}): UsageReportRequest {
  return {
    intervalMs: 30_000,
    items: [{ type: 'domain', value: 'www.youtube.com', seconds: 30 }],
    ...overrides,
  };
}

function issueOf<T>(schema: Schema<T>, value: unknown): { path: string; issue: string } | null {
  const r = validateRequest(schema, value);
  return r.ok ? null : { path: r.issue.path, issue: r.issue.issue };
}

function event(type: string, data: unknown): unknown {
  return {
    v: 1,
    epoch: EPOCH,
    seq: 7,
    at: NOW,
    wallOffsetMs: 0,
    day: '2026-09-27',
    type,
    points: 0,
    xp: 0,
    txEnd: true,
    req: null,
    data,
  };
}

// ---------------------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------------------

describe('daily limits contract', () => {
  it('adds the limit id, block kind, modes, capability and events', () => {
    expect(isIdOf('limit', LIM)).toBe(true);
    expect(isIdOf('limit', BLK)).toBe(false);
    expect(BLOCK_KINDS).toContain('limit');
    expect(LIMIT_MODES).toEqual(['normal', 'strict', 'hardcore']);
    expect(LIMIT_MODES.map(limitModeRank)).toEqual([0, 1, 2]);
    expect(GUARDIAN_CAPABILITIES).toContain('daily_limits');
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'limit_created',
        'limit_updated',
        'limit_deleted',
        'limit_warning',
        'limit_reached',
        'limit_day_closed',
      ]),
    );
  });

  it('has the limit and usage routes, none of them touching a block', () => {
    const routes = GUARDIAN_ENDPOINTS.filter(
      (e) => e.path.startsWith('/v1/limits') || e.path === '/v1/usage',
    ).map((e) => `${e.id} ${e.method} ${e.path} ${e.auth} ${e.idempotencyKey}`);
    expect(routes).toEqual([
      'listLimits GET /v1/limits app false',
      'createLimit POST /v1/limits app true',
      'updateLimit PUT /v1/limits/{id} app false',
      'deleteLimit DELETE /v1/limits/{id} app false',
      'reportUsage POST /v1/usage app_or_ext false',
    ]);
    expect(GUARDIAN_PATHS.limit(LIM)).toBe(`/v1/limits/${LIM}`);
  });

  it('keeps the limits consistent', () => {
    const L = GUARDIAN_LIMITS;
    expect(L.limitMinMinutes).toBe(5);
    expect(L.limitMaxMinutes).toBe(720);
    expect(L.limitMaxMinutes).toBeLessThanOrEqual(L.blockMaxMinutes);
    expect(L.limitWarningSeconds).toBeLessThanOrEqual(L.limitMinMinutes * 60);
    expect(L.limitWeakeningDelayMs).toBe(L.settingsWeakeningDelayMs);
    expect(L.usageReportIntervalMs).toBeLessThan(L.usageMaxIntervalMs);
    expect(L.usageSlackMs).toBeLessThan(L.usageFastReportIntervalMs);
    expect(L.usageFastReportIntervalMs).toBeLessThan(L.usageReportIntervalMs);
    expect(L.maxLimitCustomHosts).toBeGreaterThanOrEqual(L.maxCustomDomains * 2);
  });
});

// ---------------------------------------------------------------------------------------
// Request validators
// ---------------------------------------------------------------------------------------

describe('dailyLimitInputSchema', () => {
  it('accepts a valid limit', () => {
    expect(isDailyLimitInput(input())).toBe(true);
    expect(
      isDailyLimitInput(
        input({
          name: 'Redes sociales',
          targets: { ...emptyTargets(), categoryIds: ['social'], customDomains: ['example.org'] },
          days: [1, 2, 3, 4, 5],
          mode: 'hardcore',
          acknowledgeNoEmergency: true,
          dailyMinutes: 720,
        }),
      ),
    ).toBe(true);
  });

  it('enforces ranges, modes, days, names and targets', () => {
    const cases: Array<[Partial<DailyLimitInput>, string, string]> = [
      [{ dailyMinutes: 4 }, 'dailyMinutes', 'range'],
      [{ dailyMinutes: 721 }, 'dailyMinutes', 'range'],
      [{ dailyMinutes: 30.5 }, 'dailyMinutes', 'type'],
      [{ mode: 'exam' as never }, 'mode', 'enum'],
      [{ days: [] }, 'days', 'length'],
      [{ days: [1, 1] }, 'days[1]', 'duplicate'],
      [{ days: [0 as never] }, 'days[0]', 'enum'],
      [{ name: '' }, 'name', 'length'],
      [{ name: 'x'.repeat(61) }, 'name', 'length'],
      [{ name: 'a\u0000b' }, 'name', 'pattern'],
      [{ reason: 'x'.repeat(141) }, 'reason', 'length'],
      [{ targets: emptyTargets() }, 'targets', 'rule'],
      [
        { targets: { ...emptyTargets(), customProcesses: ['explorer.exe'] } },
        'targets.customProcesses[0]',
        'protected_process',
      ],
    ];
    for (const [override, path, kind] of cases) {
      expect(issueOf(dailyLimitInputSchema, input(override)), path).toEqual({ path, issue: kind });
    }
  });

  it('rejects unknown fields (no whitelist form) and maps errors like other writes', () => {
    expect(issueOf(dailyLimitInputSchema, { ...input(), whitelistOnly: false })).toEqual({
      path: 'whitelistOnly',
      issue: 'unknown_field',
    });
    const { acknowledgeNoEmergency: _ack, ...noAck } = input();
    expect(issueOf(dailyLimitInputSchema, noAck)).toEqual({
      path: 'acknowledgeNoEmergency',
      issue: 'required',
    });
    const protectedIssue = validateRequest(
      dailyLimitInputSchema,
      input({ targets: { ...emptyTargets(), customProcesses: ['explorer.exe'] } }),
    );
    expect(protectedIssue.ok ? null : validationErrorCode(protectedIssue.issue)).toBe(
      'protected_target',
    );
  });
});

describe('usageReportRequestSchema', () => {
  it('accepts domain and process items and an empty report', () => {
    expect(isUsageReportRequest(usage())).toBe(true);
    expect(
      isUsageReportRequest(
        usage({ items: [{ type: 'process', value: 'explorer.exe', seconds: 30 }] }),
      ),
    ).toBe(true);
    expect(isUsageReportRequest(usage({ items: [] }))).toBe(true);
    expect(
      isUsageReportRequest(
        usage({ intervalMs: 1_500, items: [{ type: 'domain', value: 'youtube.com', seconds: 2 }] }),
      ),
    ).toBe(true);
  });

  it('never accepts more seconds than the interval or duplicates', () => {
    const cases: Array<[unknown, string, string]> = [
      [usage({ intervalMs: 999 }), 'intervalMs', 'range'],
      [usage({ intervalMs: 120_001 }), 'intervalMs', 'range'],
      [
        usage({ items: [{ type: 'domain', value: 'youtube.com', seconds: 31 }] }),
        'items[0].seconds',
        'rule',
      ],
      [
        usage({ items: [{ type: 'domain', value: 'youtube.com', seconds: 0 }] }),
        'items[0].seconds',
        'range',
      ],
      [
        usage({
          items: [
            { type: 'domain', value: 'youtube.com', seconds: 1 },
            { type: 'domain', value: 'youtube.com', seconds: 2 },
          ],
        }),
        'items[1]',
        'rule',
      ],
      [
        usage({ items: [{ type: 'domain', value: 'https://youtube.com/', seconds: 1 }] }),
        'items[0].value',
        'invalid_domain',
      ],
      [
        usage({ items: [{ type: 'process', value: 'C:\\x\\game.exe', seconds: 1 }] }),
        'items[0].value',
        'invalid_process',
      ],
      [
        usage({ items: [{ type: 'url' as never, value: 'x', seconds: 1 }] }),
        'items[0].type',
        'enum',
      ],
      [{ ...usage(), seq: 1 }, 'seq', 'unknown_field'],
      [
        usage({
          items: Array.from({ length: 33 }, (_, i) => ({
            type: 'domain' as const,
            value: `a${i}.example.org`,
            seconds: 1,
          })),
        }),
        'items',
        'length',
      ],
    ];
    for (const [value, path, kind] of cases) {
      expect(issueOf(usageReportRequestSchema, value), path).toEqual({ path, issue: kind });
    }
  });
});

// ---------------------------------------------------------------------------------------
// Response validators
// ---------------------------------------------------------------------------------------

describe('limit responses', () => {
  it('validates a limit with a pending change or a pending deletion', () => {
    expect(isDailyLimit(limit())).toBe(true);
    expect(
      isDailyLimit(
        limit({
          reachedAt: NOW,
          activeBlockId: BLK,
          usedTodaySeconds: 1900,
          remainingTodaySeconds: 0,
          pendingChange: { definition: definition({ dailyMinutes: 60 }), effectiveAt: MIDNIGHT },
        }),
      ),
    ).toBe(true);
    expect(
      isDailyLimit(limit({ pendingChange: { definition: null, effectiveAt: MIDNIGHT } })),
    ).toBe(true);
    expect(isDailyLimit(limit({ remainingTodaySeconds: -1 }))).toBe(false);
    expect(isDailyLimit(limit({ day: '27/09/2026' }))).toBe(false);
    expect(isDailyLimit(limit({ targets: emptyTargets() }))).toBe(false);
  });

  it('reads blocks with and without limitId (events written before daily limits)', () => {
    const r = validateResponse(blockSchema, limitBlock());
    expect(r.ok).toBe(true);
    const { limitId: _limitId, ...legacy } = limitBlock({ kind: 'manual' });
    expect(validateResponse(blockSchema, legacy).ok).toBe(true);
    expect(validateResponse(blockSchema, limitBlock({ limitId: 'sch_x' as never })).ok).toBe(false);
  });

  it('validates the usage response', () => {
    expect(
      isUsageReportResponse({
        day: '2026-09-27',
        limits: [
          {
            limitId: LIM,
            usedTodaySeconds: 1800,
            remainingTodaySeconds: 0,
            appliesToday: true,
            creditedSeconds: 30,
            blockedUntil: MIDNIGHT,
          },
        ],
        serverNow: NOW,
      }),
    ).toBe(true);
  });

  it('keeps the new response fields optional for older guardians (§8.4)', () => {
    const rules = {
      extRulesVersion: 1,
      nonce: 'q3Jd0W3y8kqj3n7mW2Wm8A',
      serverNow: NOW,
      blockDomains: [],
      excludedDomains: [],
      whitelist: null,
      blocks: [],
      allowances: [],
      punishment: null,
      nextChangeAt: null,
      penaltiesEnabled: true,
    };
    expect(validateResponse(extRulesResponseSchema, rules).ok).toBe(true);
    const withLimits = {
      ...rules,
      blocks: [
        {
          id: BLK,
          kind: 'manual',
          mode: 'strict',
          endsAt: MIDNIGHT,
          reason: '',
          serviceIds: ['youtube'],
          domains: ['youtube.com'],
          whitelistOnly: false,
          limitId: LIM,
        },
      ],
      limits: [
        {
          id: LIM,
          name: 'YouTube',
          serviceIds: ['youtube'],
          domains: ['youtube.com', 'youtu.be'],
          excludedDomains: ['accounts.youtube.com'],
          dailyMinutes: 30,
          appliesToday: true,
        },
      ],
    };
    expect(validateResponse(extRulesResponseSchema, withLimits).ok).toBe(true);
    expect(
      validateResponse(extRulesResponseSchema, { ...withLimits, limits: [{ id: LIM }] }).ok,
    ).toBe(false);
    const deleted = {
      epoch: EPOCH,
      carryOverBalance: 0,
      keptBlockIds: [],
      keptPunishmentIds: [],
      keptScheduleIds: [],
    };
    expect(validateResponse(deleteDataResponseSchema, deleted).ok).toBe(true);
    expect(validateResponse(deleteDataResponseSchema, { ...deleted, keptLimitIds: [LIM] }).ok).toBe(
      true,
    );
    // `limits` is optional in /v1/state, but validated when present.
    const state = validateResponse(stateResponseSchema, { limits: [limit()] });
    expect(state.ok ? null : state.issue.path).not.toBe('limits');
    const badState = validateResponse(stateResponseSchema, { limits: [{ id: LIM }] });
    expect(badState.ok).toBe(false);
  });
});

describe('limit events', () => {
  it('validates every limit event', () => {
    const events: Array<[string, unknown]> = [
      ['limit_created', { limit: limit() }],
      ['limit_updated', { limit: limit(), cause: 'pending_applied' }],
      ['limit_deleted', { limitId: LIM, name: 'YouTube' }],
      [
        'limit_warning',
        {
          limitId: LIM,
          name: 'YouTube',
          day: '2026-09-27',
          dailyMinutes: 30,
          usedSeconds: 1500,
          remainingSeconds: 300,
        },
      ],
      [
        'limit_reached',
        {
          limitId: LIM,
          name: 'YouTube',
          day: '2026-09-27',
          dailyMinutes: 30,
          usedSeconds: 1800,
          blockId: BLK,
        },
      ],
      [
        'limit_day_closed',
        {
          limitId: LIM,
          name: 'YouTube',
          day: '2026-09-27',
          dailyMinutes: 30,
          usedSeconds: 1800,
          applied: true,
          reached: true,
        },
      ],
      ['block_created', { block: limitBlock(), source: 'limit' }],
    ];
    for (const [type, data] of events) expect(isWireEvent(event(type, data)), type).toBe(true);
    expect(isWireEvent(event('limit_updated', { limit: limit(), cause: 'admin' }))).toBe(false);
    expect(
      isWireEvent(
        event('limit_warning', {
          limitId: LIM,
          name: 'YouTube',
          day: '2026-09-27',
          dailyMinutes: 30,
          usedSeconds: 1800,
          remainingSeconds: 0,
        }),
      ),
    ).toBe(false);
  });

  it('reads epochs with and without kept limits', () => {
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
    const legacy: WireEvent = event('epoch_started', data(kept)) as WireEvent;
    expect(isWireEvent(legacy)).toBe(true);
    expect(isWireEvent(event('epoch_started', data({ ...kept, limits: [limit()] })))).toBe(true);
    expect(isWireEvent(event('epoch_started', data({ ...kept, limits: [{}] })))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Pure rules and their parity vectors
// ---------------------------------------------------------------------------------------

interface Vector {
  name: string;
  fn: string;
  args: unknown[];
  expect: unknown;
}

const file = JSON.parse(
  readFileSync(new URL('./fixtures/limits-vectors.json', import.meta.url), 'utf8'),
) as { formatVersion: number; vectors: Vector[] };

type CreditInput = Parameters<typeof limitUsageCredit>[0];

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  splitLimitChange: (a) =>
    splitLimitChange(a[0] as DailyLimitDefinition, a[1] as DailyLimitDefinition),
  limitDefinitionWeakens: (a) =>
    limitDefinitionWeakens(a[0] as DailyLimitDefinition, a[1] as DailyLimitDefinition),
  pendingLimitDelayKept: (a) =>
    pendingLimitDelayKept(a[0] as DailyLimitDefinition | null, a[1] as DailyLimitDefinition | null),
  clampUsageInterval: (a) =>
    clampUsageInterval(a[0] as number, a[1] as number | null, a[2] as number),
  limitUsageCredit: (a) => limitUsageCredit(a[0] as CreditInput),
};

describe('daily-limit parity vectors', () => {
  it('have a runner for every function and cover each one', () => {
    expect(file.formatVersion).toBe(1);
    const used = new Set(file.vectors.map((v) => v.fn));
    expect([...used].sort()).toEqual(Object.keys(FUNCTIONS).sort());
    expect(new Set(file.vectors.map((v) => v.name)).size).toBe(file.vectors.length);
  });

  describe.each(file.vectors.map((v) => [v.name, v] as const))('%s', (_, v) => {
    it('returns the expected value', () => {
      expect(FUNCTIONS[v.fn]?.(v.args)).toEqual(v.expect);
    });
  });
});

describe('limit helpers', () => {
  it('never lets a pending change be stricter than what applied', () => {
    const { applied, pending } = splitLimitChange(
      definition(),
      definition({ dailyMinutes: 10, mode: 'normal' }),
    );
    expect(applied.dailyMinutes).toBe(10);
    expect(applied.mode).toBe('strict');
    expect(pending).toEqual(definition({ dailyMinutes: 10, mode: 'normal' }));
    expect(limitDefinitionWeakens(applied, pending as DailyLimitDefinition)).toBe(false);
  });

  it('re-sends the effective definition to cancel a pending change', () => {
    const l = limit({
      mode: 'hardcore',
      pendingChange: { definition: null, effectiveAt: MIDNIGHT },
    });
    const body = limitInputFromLimit(l);
    expect(isDailyLimitInput(body)).toBe(true);
    expect(body.acknowledgeNoEmergency).toBe(true);
    expect(splitLimitChange(l, body).pending).toBeNull();
  });
});
