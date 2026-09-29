import { describe, expect, it } from 'vitest';
import type {
  Block,
  BlockId,
  EmergencyUnlock,
  GuardianSettings,
  PointsSummary,
  StudySession,
  WireEvent,
} from '../src/domain';
import { EVENT_TYPES, isIdOf, isKnownEvent } from '../src/domain';
import { SERVICES } from '../src/catalog';
import { REWARD_OFFERS } from '../src/points';
import type {
  CreateBlockRequest,
  GuardianStateResponse,
  ScheduleInput,
  Schema,
} from '../src/guardian-api';
import {
  DEFAULT_GUARDIAN_PORT,
  GUARDIAN_CAPABILITIES,
  GUARDIAN_ENDPOINTS,
  GUARDIAN_ERROR_CODES,
  GUARDIAN_ERROR_STATUS,
  GUARDIAN_LIMITS,
  GUARDIAN_PATHS,
  GUARDIAN_TEST_CAPABILITY,
  GuardianApiError,
  RESPONSE_LIMITS,
  apiContractSnapshot,
  attemptRequestSchema,
  blockSchema,
  computeRulesSignature,
  createBlockRequestSchema,
  createGuardianClient,
  emergencySchema,
  emptyAllow,
  emptyTargets,
  findAllowDistraction,
  generateRulesKeyPair,
  guardianBaseUrl,
  isAttemptRequest,
  isBlock,
  isConfirmEmergencyRequest,
  isCreateBlockRequest,
  isEmergencyRequest,
  isEmptyRequest,
  isEndStudyRequest,
  isEventsResponse,
  isExtendBlockRequest,
  isHeartbeatRequest,
  isNuclearHeartbeatRequest,
  isPairingClaimRequest,
  isScheduleInput,
  isSettingsRequest,
  isStateResponse,
  isStudySession,
  isTestClockRequest,
  isWireEvent,
  remainingMs,
  scheduleInputSchema,
  scheduleWindowMinutes,
  settingsRequestSchema,
  stateResponseSchema,
  testClockRequestSchema,
  validateRequest,
  validateResponse,
  validationErrorCode,
  verifyRulesSignature,
  wireEventSchema,
} from '../src/guardian-api';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const BODY = '0123456789abcdefABCD';
const BLK = `blk_${BODY}` as const;
const BLK2 = `blk_${BODY}XYZ` as const;
const STU = `stu_${BODY}` as const;
const EMG = `emg_${BODY}` as const;
const EXT = `ext_${BODY}` as const;
const EPOCH = `ep_${BODY}` as const;
const NOW = '2026-09-27T16:42:00.000Z';
const LATER = '2026-09-27T17:42:00.000Z';

function block(overrides: Partial<Block> = {}): Block {
  return {
    id: BLK,
    kind: 'manual',
    mode: 'strict',
    status: 'active',
    targets: { ...emptyTargets(), serviceIds: ['youtube', 'instagram'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    reason: 'Quiero aprobar mates',
    createdAt: NOW,
    startsAt: NOW,
    endsAt: LATER,
    originalEndsAt: LATER,
    endedAt: null,
    extendedMinutes: 0,
    scheduleId: null,
    punishmentId: null,
    attemptsCounted: 0,
    emergencyEligible: true,
    pointsDelta: null,
    ...overrides,
  };
}

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: STU,
    task: 'historia',
    plannedMinutes: 50,
    pomodoro: { workMinutes: 25, breakMinutes: 5 },
    camera: true,
    status: 'active',
    phase: 'work',
    phaseEndsAt: LATER,
    startedAt: NOW,
    plannedEndsAt: LATER,
    endedAt: null,
    activeMinutes: 12,
    focusedMinutes: 10,
    strikes: 1,
    attempts: 0,
    cooldownUntil: null,
    pausesLeft: 2,
    nextPauseAvailableAt: null,
    lastHeartbeatAt: NOW,
    lastHeartbeatSeq: 48,
    warnings: 2,
    policy: { level: 'distractions', minutes: 60 },
    achieved: null,
    ...overrides,
  };
}

function points(): PointsSummary {
  return {
    balance: -140,
    xp: 1260,
    level: 7,
    levelFloorXp: 1260,
    nextLevelXp: 1680,
    streakDays: 5,
    bestStreakDays: 9,
    today: { day: '2026-09-27', focusMinutes: 42, goalMinutes: 60, goalMet: false },
    pendingFocusMinutes: 2,
  };
}

function emergency(): EmergencyUnlock {
  return {
    id: EMG,
    blockIds: [BLK],
    status: 'counting',
    countdownMinutes: 30,
    requestedAt: NOW,
    readyAt: LATER,
    confirmBy: null,
    penaltyPreview: 620,
    streakDaysAtRisk: 5,
    resolvedAt: null,
    cancelReason: null,
  };
}

function state(): GuardianStateResponse {
  return {
    stateVersion: 1843,
    serverNow: NOW,
    epoch: EPOCH,
    lastEventSeq: 1843,
    guardian: { version: '0.1.0', apiVersion: 1, mode: 'normal', problems: [] },
    clock: {
      wallOffsetMs: 0,
      trust: 'verified',
      lastJump: null,
      lastCalibratedAt: NOW,
      bootHoldUntil: null,
    },
    protection: {
      hosts: { ok: true, status: 'ok', entries: 68, lastAppliedAt: NOW },
      processWatcher: { ok: true },
      extensions: [
        {
          id: EXT,
          browser: 'chrome',
          extVersion: '0.3.0',
          connected: true,
          lastSeenAt: NOW,
          incognitoAllowed: false,
          hostPermission: true,
          appliedExtRulesVersion: 57,
          protecting: false,
        },
      ],
      browsersWithoutExtension: ['firefox'],
    },
    blocks: [block()],
    punishments: [],
    nuclearActive: false,
    study: session(),
    emergency: emergency(),
    allowances: [],
    rewardsLock: 'study',
    nextSchedule: null,
    points: points(),
    pendingSettings: [{ field: 'attemptPenalties', value: false, effectiveAt: LATER }],
    recent: {
      endedBlocks: [
        {
          id: BLK2,
          kind: 'manual',
          mode: 'normal',
          outcome: 'completed',
          endedAt: NOW,
          pointsDelta: 80,
        },
      ],
      endedStudy: null,
    },
  };
}

function createBlock(overrides: Partial<CreateBlockRequest> = {}): CreateBlockRequest {
  return {
    targets: { ...emptyTargets(), serviceIds: ['youtube'], categoryIds: ['social'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    mode: 'normal',
    durationMinutes: 60,
    endsAt: null,
    reason: 'Quiero aprobar mates',
    acknowledgeLong: false,
    acknowledgeNoEmergency: false,
    ...overrides,
  };
}

function scheduleInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: 'Tardes de deberes',
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: '16:00',
    end: '19:00',
    timezone: 'Europe/Madrid',
    targets: { ...emptyTargets(), categoryIds: ['social'] },
    whitelistOnly: false,
    allow: emptyAllow(),
    mode: 'normal',
    reason: '',
    acknowledgeNoEmergency: false,
    ...overrides,
  };
}

function settings(overrides: Partial<GuardianSettings> = {}): GuardianSettings {
  return {
    timezone: 'Europe/Madrid',
    dailyGoalMinutes: 60,
    attemptPenalties: true,
    punishment: { level: 'distractions', minutes: 60 },
    closeBrowsersWithoutExtension: false,
    serverTimeCheck: true,
    studyWhitelist: { extraDomains: ['aulavirtual.example.edu'], extraProcesses: [] },
    ...overrides,
  };
}

function issueOf<T>(schema: Schema<T>, value: unknown): { path: string; issue: string } | null {
  const r = validateRequest(schema, value);
  return r.ok ? null : { path: r.issue.path, issue: r.issue.issue };
}

// ---------------------------------------------------------------------------------------
// Constants and route table
// ---------------------------------------------------------------------------------------

describe('constants', () => {
  it('uses the fixed loopback port', () => {
    expect(DEFAULT_GUARDIAN_PORT).toBe(47600);
    expect(guardianBaseUrl()).toBe('http://127.0.0.1:47600');
    expect(guardianBaseUrl(47601)).toBe('http://127.0.0.1:47601');
  });

  it('states one rule for block length', () => {
    expect(GUARDIAN_LIMITS.blockMinMinutes).toBe(5);
    expect(GUARDIAN_LIMITS.blockMaxMinutes).toBe(24 * 60);
    expect(GUARDIAN_LIMITS.longBlockConfirmMinutes).toBe(4 * 60);
    expect(GUARDIAN_LIMITS.statePollIntervalMs).toBe(2000);
  });

  it('maps every error code to a valid HTTP status', () => {
    for (const code of GUARDIAN_ERROR_CODES) {
      const status = GUARDIAN_ERROR_STATUS[code];
      expect(status >= 400 && status < 600, code).toBe(true);
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('keeps everything the guardian may emit below the response validator caps', () => {
    const L = GUARDIAN_LIMITS;
    const catalogDomains = SERVICES.reduce((n, service) => n + service.domains.length, 0);
    // The hosts section (and every domain list) holds the custom budgets plus the catalog.
    expect(
      L.maxActiveCustomHosts + L.maxScheduleCustomHosts + L.maxLimitCustomHosts + catalogDomains,
    ).toBeLessThan(L.hostsMaxDomains);
    expect(L.hostsMaxDomains).toBeLessThan(RESPONSE_LIMITS.domains);
    // One block's custom domains (each expands to at most 2 hosts) always fit the budget.
    expect(L.maxCustomDomains * 2).toBeLessThanOrEqual(L.maxActiveCustomHosts);
    // Active blocks: user blocks + one occurrence per schedule + the limit blocks of the
    // day + stacked punishments.
    expect(
      L.maxActiveBlocks +
        L.maxSchedules +
        L.maxLimits * L.limitMaxBlocksPerDay +
        RESPONSE_LIMITS.punishments,
    ).toBeLessThanOrEqual(RESPONSE_LIMITS.blocks);
    expect(L.maxLimits).toBeLessThanOrEqual(RESPONSE_LIMITS.limits);
    expect(L.unverifiedCompletionsMax + 1).toBeLessThanOrEqual(L.maxBatchEvents);
    expect(L.maxBatchEvents).toBeLessThanOrEqual(L.eventsPageMax);
    expect(L.allowanceMaxMinutes).toBeGreaterThanOrEqual(
      Math.max(...REWARD_OFFERS.map((offer) => offer.minutes)),
    );
    expect(L.allowanceMaxMinutes).toBeLessThanOrEqual(1440);
    expect(GUARDIAN_CAPABILITIES as readonly string[]).not.toContain(GUARDIAN_TEST_CAPABILITY);
  });

  it('snapshots the contract as plain JSON', () => {
    const snap = apiContractSnapshot();
    expect(snap.defaultPort).toBe(47600);
    expect(snap.endpoints).toHaveLength(GUARDIAN_ENDPOINTS.length);
    expect(snap.errors.validation_failed).toBe(422);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});

describe('route table', () => {
  it('has unique ids and unique method + path pairs', () => {
    const ids = GUARDIAN_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = GUARDIAN_ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('has no operation that ends, shortens or edits a block', () => {
    const blockRoutes = GUARDIAN_ENDPOINTS.filter((e) => e.path.startsWith('/v1/blocks'))
      .map((e) => `${e.method} ${e.path}`)
      .sort();
    expect(blockRoutes).toEqual([
      'GET /v1/blocks',
      'GET /v1/blocks/{id}',
      'POST /v1/blocks',
      'POST /v1/blocks/{id}/extend',
    ]);
    for (const e of GUARDIAN_ENDPOINTS) {
      expect(e.path).not.toMatch(/shorten|unblock|finish|terminate|stop|end-now|reset/);
      if (e.path.startsWith('/v1/blocks')) expect(['GET', 'POST']).toContain(e.method);
    }
  });

  it('matches GUARDIAN_PATHS', () => {
    const templates = new Set(GUARDIAN_ENDPOINTS.map((e) => e.path));
    for (const [name, value] of Object.entries(GUARDIAN_PATHS)) {
      const path = typeof value === 'string' ? value : value(BLK as never).replace(BLK, '{id}');
      expect(templates.has(path), name).toBe(true);
    }
  });

  it('encodes id segments', () => {
    expect(GUARDIAN_PATHS.blockExtend('blk_a/b' as BlockId)).toBe('/v1/blocks/blk_a%2Fb/extend');
  });

  it('has 45 routes; only the test clock is test-only', () => {
    expect(GUARDIAN_ENDPOINTS).toHaveLength(45);
    expect(GUARDIAN_ENDPOINTS.filter((e) => e.testOnly).map((e) => e.id)).toEqual(['testClock']);
    expect(GUARDIAN_ENDPOINTS.map((e) => e.id)).toEqual(
      expect.arrayContaining(['getStudySession', 'nuclearHeartbeat']),
    );
  });

  it('is fully covered by the client', () => {
    const client = createGuardianClient({ fetch: () => Promise.reject(new Error('unused')) });
    const endpointIds = GUARDIAN_ENDPOINTS.filter((e) => !e.testOnly)
      .map((e) => e.id)
      .sort();
    expect(Object.keys(client).sort()).toEqual(endpointIds);
  });
});

// ---------------------------------------------------------------------------------------
// Request validators (strict)
// ---------------------------------------------------------------------------------------

describe('request validators', () => {
  it('accepts a valid block request', () => {
    expect(isCreateBlockRequest(createBlock())).toBe(true);
    expect(isCreateBlockRequest(createBlock({ durationMinutes: null, endsAt: LATER }))).toBe(true);
    expect(
      isCreateBlockRequest(
        createBlock({
          mode: 'exam',
          whitelistOnly: true,
          targets: emptyTargets(),
          allow: { customDomains: ['aulavirtual.example.edu'], customProcesses: ['GeoGebra.exe'] },
          acknowledgeNoEmergency: true,
        }),
      ),
    ).toBe(true);
  });

  it('rejects unknown fields, also nested ones', () => {
    expect(issueOf(createBlockRequestSchema, { ...createBlock(), shorten: true })).toEqual({
      path: 'shorten',
      issue: 'unknown_field',
    });
    const nested = createBlock();
    (nested.targets as unknown as Record<string, unknown>)['wildcards'] = ['*'];
    expect(issueOf(createBlockRequestSchema, nested)).toEqual({
      path: 'targets.wildcards',
      issue: 'unknown_field',
    });
  });

  it('rejects missing fields and wrong types', () => {
    const { reason: _reason, ...noReason } = createBlock();
    expect(issueOf(createBlockRequestSchema, noReason)).toEqual({
      path: 'reason',
      issue: 'required',
    });
    expect(issueOf(createBlockRequestSchema, createBlock({ durationMinutes: 60.5 }))).toEqual({
      path: 'durationMinutes',
      issue: 'type',
    });
    expect(issueOf(createBlockRequestSchema, null)).toEqual({ path: '$', issue: 'type' });
    expect(issueOf(createBlockRequestSchema, [])).toEqual({ path: '$', issue: 'type' });
  });

  it('enforces the block rules', () => {
    const cases: Array<[Partial<CreateBlockRequest>, string]> = [
      [{ durationMinutes: 4 }, 'durationMinutes'],
      [{ durationMinutes: 1441 }, 'durationMinutes'],
      [{ durationMinutes: 60, endsAt: LATER }, 'durationMinutes'],
      [{ durationMinutes: null, endsAt: null }, 'durationMinutes'],
      [{ endsAt: '2026-09-27T17:42:00+02:00', durationMinutes: null }, 'endsAt'],
      [{ mode: 'exam' }, 'whitelistOnly'],
      [{ whitelistOnly: true }, 'targets'],
      [{ targets: emptyTargets() }, 'targets'],
      [{ allow: { customDomains: ['wikipedia.org'], customProcesses: [] } }, 'allow'],
      [{ reason: 'a\u0000b' }, 'reason'],
      [{ reason: 'x'.repeat(141) }, 'reason'],
      [{ reason: 'hola\u202eadios' }, 'reason'],
    ];
    for (const [override, path] of cases) {
      expect(issueOf(createBlockRequestSchema, createBlock(override))?.path, path).toBe(path);
    }
  });

  it('validates targets against the catalog helpers', () => {
    const bad = (targets: Partial<CreateBlockRequest['targets']>) =>
      issueOf(
        createBlockRequestSchema,
        createBlock({ targets: { ...emptyTargets(), ...targets } }),
      );
    expect(bad({ customDomains: ['https://example.org/x'] })).toEqual({
      path: 'targets.customDomains[0]',
      issue: 'invalid_domain',
    });
    expect(bad({ customDomains: ['Example.org'] })?.issue).toBe('invalid_domain');
    expect(bad({ customDomains: ['example.org', 'example.org'] })?.issue).toBe('duplicate');
    expect(bad({ customProcesses: ['explorer.exe'] })?.issue).toBe('protected_process');
    expect(bad({ customProcesses: ['C:\\x\\game.exe'] })?.issue).toBe('invalid_process');
    expect(bad({ categoryIds: ['cooking' as never] })?.issue).toBe('enum');
    expect(bad({ serviceIds: ['YouTube'] })?.issue).toBe('pattern');
    expect(bad({ appIds: ['popular-pc-games'] })).toBeNull();
  });

  it('only extends by a positive number of minutes', () => {
    expect(isExtendBlockRequest({ addMinutes: 30 })).toBe(true);
    expect(isExtendBlockRequest({ addMinutes: 0 })).toBe(false);
    expect(isExtendBlockRequest({ addMinutes: -15 })).toBe(false);
    expect(isExtendBlockRequest({ addMinutes: 1441 })).toBe(false);
    expect(isExtendBlockRequest({ addMinutes: 30, endsAt: NOW })).toBe(false);
  });

  it('validates schedules', () => {
    expect(isScheduleInput(scheduleInput())).toBe(true);
    expect(isScheduleInput(scheduleInput({ start: '22:00', end: '07:00' }))).toBe(true);
    expect(scheduleWindowMinutes('22:00', '07:00')).toBe(540);
    expect(scheduleWindowMinutes('16:00', '19:00')).toBe(180);
    expect(issueOf(scheduleInputSchema, scheduleInput({ end: '16:00' }))?.path).toBe('end');
    expect(issueOf(scheduleInputSchema, scheduleInput({ end: '16:04' }))?.path).toBe('end');
    expect(isScheduleInput(scheduleInput({ timezone: 'Local' }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ timezone: 'UTC' }))).toBe(true);
    expect(isScheduleInput(scheduleInput({ timezone: 'America/Argentina/Buenos_Aires' }))).toBe(
      true,
    );
    expect(isScheduleInput(scheduleInput({ timezone: '../../etc/passwd' }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ days: [] }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ days: [1, 1] }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ days: [0 as never] }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ start: '24:00' }))).toBe(false);
    expect(isScheduleInput(scheduleInput({ name: '' }))).toBe(false);
  });

  it('keeps attempt layers and target types consistent', () => {
    expect(
      isAttemptRequest({
        layer: 'extension',
        target: { type: 'domain', value: 'www.youtube.com' },
        browser: 'chrome',
        incognito: false,
      }),
    ).toBe(true);
    expect(
      isAttemptRequest({
        layer: 'window',
        target: { type: 'service', value: 'youtube' },
        browser: null,
        incognito: false,
      }),
    ).toBe(true);
    expect(
      issueOf(attemptRequestSchema, {
        layer: 'extension',
        target: { type: 'service', value: 'youtube' },
        browser: 'chrome',
        incognito: false,
      })?.issue,
    ).toBe('rule');
    expect(
      isAttemptRequest({
        layer: 'process',
        target: { type: 'domain', value: 'youtube.com' },
        browser: null,
        incognito: false,
      }),
    ).toBe(false);
    expect(
      isAttemptRequest({
        layer: 'extension',
        target: { type: 'url', value: 'https://youtube.com/watch' },
        browser: 'chrome',
        incognito: false,
      }),
    ).toBe(false);
  });

  it('validates study heartbeats', () => {
    const hb = {
      seq: 212,
      state: 'focused',
      focusScore: 84,
      focusedMsSinceLast: 15_000,
      warningsSinceLast: 1,
      cameraOn: true,
    };
    expect(isHeartbeatRequest(hb)).toBe(true);
    expect(isHeartbeatRequest({ ...hb, focusScore: null })).toBe(true);
    expect(isHeartbeatRequest({ ...hb, seq: 0 })).toBe(false);
    expect(isHeartbeatRequest({ ...hb, focusScore: 101 })).toBe(false);
    expect(isHeartbeatRequest({ ...hb, focusedMsSinceLast: 600_001 })).toBe(false);
    expect(isHeartbeatRequest({ ...hb, state: 'studying' })).toBe(false);
    expect(isHeartbeatRequest({ ...hb, warningsSinceLast: 101 })).toBe(false);
    expect(
      isEndStudyRequest({ reason: 'user', focusedMsSinceLast: 9_000, warningsSinceLast: 0 }),
    ).toBe(true);
    expect(isEndStudyRequest({ reason: 'user' })).toBe(false);
    expect(isNuclearHeartbeatRequest({ overlayShown: true, displays: 2 })).toBe(true);
    expect(isNuclearHeartbeatRequest({ overlayShown: true, displays: 0 })).toBe(false);
  });

  it('validates emergency requests', () => {
    const req = {
      blockIds: [BLK],
      phrase: 'Acepto romper mi compromiso y perder mis puntos',
    };
    expect(isEmergencyRequest(req)).toBe(true);
    expect(isEmergencyRequest({ ...req, blockIds: [] })).toBe(false);
    expect(isEmergencyRequest({ ...req, blockIds: [BLK, BLK] })).toBe(false);
    expect(isEmergencyRequest({ ...req, blockIds: ['sch_0123456789abcdefABCD'] })).toBe(false);
    // Either language's phrase is accepted, so the request carries no language.
    expect(isEmergencyRequest({ ...req, language: 'es' })).toBe(false);
    expect(isConfirmEmergencyRequest({ acknowledge: true })).toBe(true);
    expect(isConfirmEmergencyRequest({ acknowledge: 'true' })).toBe(false);
    expect(isConfirmEmergencyRequest({})).toBe(false);
  });

  it('validates settings', () => {
    expect(isSettingsRequest(settings())).toBe(true);
    expect(isSettingsRequest(settings({ timezone: null }))).toBe(true);
    expect(isSettingsRequest(settings({ dailyGoalMinutes: 10 }))).toBe(false);
    expect(isSettingsRequest(settings({ punishment: { level: 'nuclear', minutes: 121 } }))).toBe(
      false,
    );
    expect(
      issueOf(
        settingsRequestSchema,
        settings({ studyWhitelist: { extraDomains: [], extraProcesses: ['svchost.exe'] } }),
      ),
    ).toEqual({ path: 'studyWhitelist.extraProcesses[0]', issue: 'protected_process' });
    expect(issueOf(settingsRequestSchema, settings({ timezone: 'Local' }))).toEqual({
      path: 'timezone',
      issue: 'pattern',
    });
    expect(
      issueOf(testClockRequestSchema, { advanceMs: 1, suspendMs: 1, jumpMs: null, reboot: false }),
    ).toEqual({ path: '$', issue: 'rule' });
  });

  it('maps request issues to the documented error codes', () => {
    const code = (schema: Schema<unknown>, value: unknown): string | null => {
      const r = validateRequest(schema, value);
      return r.ok ? null : validationErrorCode(r.issue);
    };
    const block = createBlockRequestSchema as Schema<unknown>;
    expect(code(block, { ...createBlock(), shorten: true })).toBe('unknown_field');
    expect(code(block, createBlock({ durationMinutes: 4 }))).toBe('duration_out_of_range');
    expect(code(block, createBlock({ durationMinutes: 60.5 }))).toBe('validation_failed');
    expect(
      code(
        block,
        createBlock({ targets: { ...emptyTargets(), customProcesses: ['explorer.exe'] } }),
      ),
    ).toBe('protected_target');
    expect(code(block, createBlock({ reason: 'x'.repeat(141) }))).toBe('validation_failed');
    expect(code(settingsRequestSchema as Schema<unknown>, settings({ timezone: 'Local' }))).toBe(
      'invalid_timezone',
    );
    expect(
      code(scheduleInputSchema as Schema<unknown>, scheduleInput({ timezone: '../../etc/passwd' })),
    ).toBe('invalid_timezone');
    expect(GUARDIAN_ERROR_STATUS.unknown_field).toBe(400);
    expect(GUARDIAN_ERROR_STATUS.too_many_targets).toBe(422);
    expect(GUARDIAN_ERROR_STATUS.allowance_limit_reached).toBe(409);
  });

  it('refuses distractions in whitelist allowances and study whitelist extras', () => {
    expect(
      findAllowDistraction(
        { domains: ['aulavirtual.example.edu'], processes: ['GeoGebra.exe'] },
        { domains: 'allow.customDomains', processes: 'allow.customProcesses' },
      ),
    ).toBeNull();
    expect(
      findAllowDistraction(
        { domains: ['youtube.com'], processes: [] },
        { domains: 'studyWhitelist.extraDomains', processes: 'studyWhitelist.extraProcesses' },
      ),
    ).toEqual({
      path: 'studyWhitelist.extraDomains[0]',
      reason: 'service_domain',
      serviceId: 'youtube',
      appId: null,
    });
    expect(
      findAllowDistraction(
        { domains: [], processes: ['steam.exe'] },
        { domains: 'studyWhitelist.extraDomains', processes: 'studyWhitelist.extraProcesses' },
      )?.appId,
    ).toBe('steam');
  });

  it('validates pairing, empty bodies and the test clock', () => {
    const claim = {
      code: '048392',
      browser: 'firefox',
      browserVersion: '141.0',
      extVersion: '0.3.0',
    };
    expect(isPairingClaimRequest(claim)).toBe(true);
    expect(isPairingClaimRequest({ ...claim, code: '48392' })).toBe(false);
    expect(isPairingClaimRequest({ ...claim, code: '04839a' })).toBe(false);
    expect(isEmptyRequest({})).toBe(true);
    expect(isEmptyRequest({ force: true })).toBe(false);
    expect(
      isTestClockRequest({ advanceMs: 1000, suspendMs: null, jumpMs: null, reboot: false }),
    ).toBe(true);
    expect(isTestClockRequest({ advanceMs: 1000, suspendMs: null, jumpMs: 5, reboot: false })).toBe(
      false,
    );
    expect(
      isTestClockRequest({ advanceMs: null, suspendMs: null, jumpMs: null, reboot: false }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Response validators (open)
// ---------------------------------------------------------------------------------------

describe('response validators', () => {
  it('accepts a full state response', () => {
    const r = validateResponse(stateResponseSchema, state());
    expect(r).toEqual({ ok: true, value: state() });
    expect(isStateResponse(state())).toBe(true);
  });

  it('ignores unknown response fields but checks known ones', () => {
    expect(isBlock({ ...block(), futureField: { anything: 1 } })).toBe(true);
    expect(isStateResponse({ ...state(), newSection: [] })).toBe(true);
    expect(isBlock(block({ endsAt: 'mañana' }))).toBe(false);
    expect(isBlock(block({ status: 'paused' as never }))).toBe(false);
    expect(isBlock(block({ id: 'blk_short' as BlockId }))).toBe(false);
    expect(isBlock(block({ pointsDelta: 80 }))).toBe(true);
    const bad = state();
    (bad.blocks[0] as unknown as Record<string, unknown>)['mode'] = 'ultra';
    const r = validateResponse(stateResponseSchema, bad);
    expect(r.ok ? null : r.issue).toMatchObject({ path: 'blocks[0].mode', issue: 'enum' });
  });

  it('requires millisecond UTC timestamps', () => {
    expect(isBlock(block({ endsAt: '2026-09-27T17:42:00.000Z' }))).toBe(true);
    expect(isBlock(block({ endsAt: '2026-09-27T17:42:00Z' }))).toBe(false);
    expect(isBlock(block({ endsAt: '2026-09-27T17:42:00.000000001Z' }))).toBe(false);
    expect(isBlock(block({ endsAt: '2026-09-27T19:42:00.000+02:00' }))).toBe(false);
  });

  it('accepts a recovered block carrying the whole hosts section', () => {
    const domains = Array.from({ length: 600 }, (_, i) => `d${i}.example.org`);
    const recovered = block({
      kind: 'recovered',
      reason: '',
      targets: { ...emptyTargets(), customDomains: domains },
    });
    expect(validateResponse(blockSchema, recovered).ok).toBe(true);
    const epochStarted = {
      v: 1,
      epoch: EPOCH,
      seq: 1,
      at: NOW,
      wallOffsetMs: 0,
      day: '2026-09-27',
      points: 0,
      xp: 0,
      txEnd: true,
      req: null,
      type: 'epoch_started',
      data: {
        reason: 'log_unreadable',
        previousEpoch: null,
        carryOverBalance: 0,
        escalation: { lastCountedAt: null, index: 0 },
        kept: {
          blocks: [recovered],
          punishments: [],
          allowances: [],
          schedules: [],
          settings: settings(),
          pendingSettings: [],
          materializedOccurrences: [],
        },
      },
    };
    expect(validateResponse(wireEventSchema, epochStarted)).toMatchObject({ ok: true });
  });

  it('keys pending settings by path; punishment changes never wait', () => {
    const withPending = (pendingSettings: unknown) => ({ ...state(), pendingSettings });
    expect(
      isStateResponse(
        withPending([
          { field: 'studyWhitelist.extraDomains', value: ['a.example.edu'], effectiveAt: LATER },
          { field: 'dailyGoalMinutes', value: 30, effectiveAt: LATER },
        ]),
      ),
    ).toBe(true);
    expect(
      isStateResponse(
        withPending([
          {
            field: 'punishment',
            value: { level: 'distractions', minutes: 15 },
            effectiveAt: LATER,
          },
        ]),
      ),
    ).toBe(false);
  });

  it('accepts the last ended study session in the state', () => {
    const ended = session({ status: 'punished', phase: 'ended', endedAt: LATER });
    const summary = {
      outcome: 'punished' as const,
      activeMinutes: 30,
      workMinutes: 25,
      focusedMinutes: 20,
      focusPct: 80,
      strikes: 3,
      warnings: 4,
      attempts: 1,
      pointsTotal: -115,
      cleanBonus: 0,
    };
    const s = state();
    s.recent.endedStudy = { session: ended, summary };
    expect(isStateResponse(s)).toBe(true);
    s.recent.endedStudy = { session: ended, summary: { ...summary, outcome: 'gave_up' as never } };
    expect(isStateResponse(s)).toBe(false);
  });

  it('allows only the documented emergency status and cancel reason pairs', () => {
    const e = emergency();
    expect(validateResponse(emergencySchema, e).ok).toBe(true);
    const pair = (status: string, cancelReason: string | null) =>
      validateResponse(emergencySchema, { ...e, status, cancelReason }).ok;
    expect(pair('expired', 'expired')).toBe(true);
    expect(pair('cancelled', 'user')).toBe(true);
    expect(pair('cancelled', 'expired')).toBe(false);
    expect(pair('expired', null)).toBe(false);
    expect(pair('counting', 'user')).toBe(false);
  });

  it('checks study sessions and nested pomodoro limits', () => {
    expect(isStudySession(session())).toBe(true);
    expect(isStudySession(session({ pomodoro: { workMinutes: 4, breakMinutes: 5 } }))).toBe(false);
    expect(isStudySession(session({ phase: 'nap' as never }))).toBe(false);
  });

  it('validates event lines and tolerates unknown types', () => {
    const base = {
      v: 1,
      epoch: EPOCH,
      seq: 7,
      at: NOW,
      wallOffsetMs: 0,
      day: '2026-09-27',
      points: -20,
      xp: 0,
      txEnd: true,
      req: 'a1b2c3',
    };
    const attempt = {
      ...base,
      type: 'attempt',
      data: {
        attemptId: `att_${BODY}`,
        layer: 'extension',
        targetKey: 'svc:youtube',
        targetType: 'service',
        serviceId: 'youtube',
        blockIds: [BLK],
        browser: 'chrome',
        incognito: false,
        escalationIndex: 1,
        penalized: true,
      },
    };
    expect(isWireEvent(attempt)).toBe(true);
    expect(isWireEvent({ ...attempt, data: { ...attempt.data, targetKey: 'youtube' } })).toBe(
      false,
    );
    expect(
      isWireEvent({ ...attempt, data: { ...attempt.data, targetKey: 'proc:my game.exe' } }),
    ).toBe(true);
    expect(isWireEvent({ ...attempt, data: { ...attempt.data, targetKey: 'proc:a\u0007' } })).toBe(
      false,
    );
    expect(isWireEvent({ ...attempt, day: '2026-02-30' })).toBe(false);
    expect(isWireEvent({ ...attempt, v: 2 })).toBe(false);
    expect(isWireEvent({ ...attempt, xp: -1 })).toBe(false);
    const future = { ...base, type: 'pet_grew', data: { stage: 3 } };
    expect(isWireEvent(future)).toBe(true);
    expect(isWireEvent({ ...future, data: null })).toBe(false);
    expect(isWireEvent({ ...future, type: 'Bad Type' })).toBe(false);
    expect(isKnownEvent(attempt as WireEvent)).toBe(true);
    expect(isKnownEvent(future as WireEvent)).toBe(false);
    expect(
      isEventsResponse({
        epoch: EPOCH,
        reset: false,
        events: [attempt, future],
        lastSeq: 8,
        hasMore: false,
      }),
    ).toBe(true);
  });

  it('has a data schema for every known event type', () => {
    for (const type of EVENT_TYPES) {
      const r = validateResponse(wireEventSchema, {
        v: 1,
        epoch: EPOCH,
        seq: 1,
        at: NOW,
        wallOffsetMs: 0,
        day: '2026-09-27',
        points: 0,
        xp: 0,
        txEnd: true,
        req: null,
        type,
        data: 'not an object',
      });
      expect(r.ok, type).toBe(false);
      expect(r.ok ? null : r.issue.path, type).toBe('data');
    }
  });
});

describe('ids', () => {
  it('checks prefixes and bodies', () => {
    expect(isIdOf('block', BLK)).toBe(true);
    expect(isIdOf('schedule', BLK)).toBe(false);
    expect(isIdOf('block', 'blk_0123456789abcde')).toBe(false);
    expect(isIdOf('block', `blk_${'a'.repeat(41)}`)).toBe(false);
    expect(isIdOf('block', 'blk_0123456789abcdef-ABC')).toBe(false);
  });
});

describe('helpers', () => {
  it('computes the countdown from the machine clock', () => {
    expect(remainingMs(LATER, Date.parse(NOW))).toBe(3_600_000);
    expect(remainingMs(NOW, Date.parse(LATER))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}

function fakeFetch(handler: (req: Captured) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const f: typeof fetch = async (input, init) => {
    const req: Captured = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch: f, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('createGuardianClient', () => {
  it('sends auth, JSON and an idempotency key on writes', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, { block: block(), stateVersion: 9 }));
    const client = createGuardianClient({
      baseUrl: 'http://127.0.0.1:47600/',
      token: 'cta_secret',
      fetch,
      newIdempotencyKey: () => 'key-1',
    });
    const res = await client.createBlock(createBlock());
    expect(res.block.id).toBe(BLK);
    const call = calls[0];
    expect(call?.url.toString()).toBe('http://127.0.0.1:47600/v1/blocks');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('Authorization')).toBe('Bearer cta_secret');
    expect(call?.headers.get('Content-Type')).toBe('application/json');
    expect(call?.headers.get('Idempotency-Key')).toBe('key-1');
    expect(JSON.parse(call?.body ?? 'null')).toEqual(createBlock());

    await client.extendBlock(BLK, { addMinutes: 30 }, { idempotencyKey: 'undo-window-1' });
    expect(calls[1]?.url.pathname).toBe(`/v1/blocks/${BLK}/extend`);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe('undo-window-1');
  });

  it('builds query strings and omits auth for the pairing claim', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.url.pathname === '/v1/pairing/claim') {
        return json(201, {
          extensionId: EXT,
          token: 'cte_abcdefghijklmnopqrstuvwxyz',
          guardianVersion: '0.1.0',
          boundOrigin: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah',
          rulesPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(88),
        });
      }
      return json(200, { epoch: EPOCH, reset: true, events: [], lastSeq: 0, hasMore: false });
    });
    const client = createGuardianClient({ token: 'cta_x', fetch });
    await client.getEvents({ epoch: EPOCH, after: 12, waitMs: 25_000 });
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      epoch: EPOCH,
      after: '12',
      waitMs: '25000',
    });
    await client.claimPairing({
      code: '048392',
      browser: 'chrome',
      browserVersion: '141.0',
      extVersion: '0.3.0',
    });
    expect(calls[1]?.headers.get('Authorization')).toBeNull();
    expect(calls[1]?.headers.get('Idempotency-Key')).toBeNull();
  });

  it('handles 304 on the state poll', async () => {
    const { fetch, calls } = fakeFetch((req) =>
      req.headers.get('If-None-Match') === '"s-1843"'
        ? new Response(null, { status: 304, headers: { ETag: '"s-1843"' } })
        : json(200, state(), { ETag: '"s-1843"' }),
    );
    const client = createGuardianClient({ token: 'cta_x', fetch });
    const first = await client.getState();
    expect(first.notModified).toBe(false);
    expect(first.etag).toBe('"s-1843"');
    const second = await client.getState({ etag: first.etag });
    expect(second).toEqual({ notModified: true, etag: '"s-1843"' });
    expect(calls).toHaveLength(2);
  });

  it('throws GuardianApiError with the guardian error body', async () => {
    const { fetch } = fakeFetch(() =>
      json(409, {
        error: {
          code: 'insufficient_points',
          message: 'balance too low',
          details: { shortBy: 40 },
        },
      }),
    );
    const client = createGuardianClient({ token: 'cta_x', fetch });
    const err = await client.redeemReward({ offerId: 'youtube-15' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'insufficient_points',
      details: { shortBy: 40 },
    });
  });

  it('rejects malformed responses', async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { block: { ...block(), endsAt: 42 }, stateVersion: 1 }),
    );
    const client = createGuardianClient({ token: 'cta_x', fetch });
    await expect(client.createBlock(createBlock())).rejects.toMatchObject({
      code: 'invalid_response',
      details: { path: 'block.endsAt', issue: 'type' },
    });
    const html = fakeFetch(() => new Response('<html>', { status: 502 }));
    await expect(createGuardianClient({ fetch: html.fetch }).health()).rejects.toMatchObject({
      status: 502,
      code: 'http_502',
    });
  });

  it('reports unreachable and timeouts', async () => {
    const down = createGuardianClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.health()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
    const hang = createGuardianClient({
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(hang.health()).rejects.toMatchObject({ status: 0, code: 'timeout' });
  });

  it('re-reads a rotated token once after a 401', async () => {
    let current = 'cta_old';
    const { fetch, calls } = fakeFetch((req) =>
      req.headers.get('Authorization') === 'Bearer cta_new'
        ? json(200, { points: points() })
        : json(401, { error: { code: 'unauthorized', message: 'bad token', details: null } }),
    );
    const client = createGuardianClient({
      fetch,
      token: () => {
        const t = current;
        current = 'cta_new';
        return t;
      },
    });
    const res = await client.getPoints();
    expect(res.points.balance).toBe(-140);
    expect(calls.map((c) => c.headers.get('Authorization'))).toEqual([
      'Bearer cta_old',
      'Bearer cta_new',
    ]);
  });

  it('keeps syncing when one event of a page is malformed', async () => {
    const line = (seq: number, type: string, data: unknown, points = 0) => ({
      v: 1,
      epoch: EPOCH,
      seq,
      at: NOW,
      wallOffsetMs: 0,
      day: '2026-09-27',
      points,
      xp: 0,
      txEnd: true,
      req: null,
      type,
      data,
    });
    const page = {
      epoch: EPOCH,
      reset: false,
      events: [
        line(1, 'day_closed', { day: '2026-09-26', goalMinutes: 60 }),
        line(2, 'attempt', { attemptId: 'nope' }, -10),
        line(3, 'pet_grew', { stage: 2 }),
      ],
      lastSeq: 3,
      hasMore: false,
    };
    const { fetch } = fakeFetch(() => json(200, page));
    const client = createGuardianClient({ token: 'cta_x', fetch });
    const res = await client.getEvents({ epoch: EPOCH, after: 0 });
    expect(res.lastSeq).toBe(3);
    expect(res.events.map((e) => isKnownEvent(e))).toEqual([true, false, false]);
    expect(res.events[1]).toMatchObject({
      seq: 2,
      points: -10,
      malformed: { path: 'data.attemptId', issue: 'pattern' },
    });
    expect(res.events[2]).not.toHaveProperty('malformed');
    // A broken envelope still fails: its points could not be applied.
    const broken = fakeFetch(() =>
      json(200, { ...page, events: [{ ...line(1, 'day_closed', {}), points: 1.5 }] }),
    );
    await expect(
      createGuardianClient({ token: 'cta_x', fetch: broken.fetch }).getEvents(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reaches the study history, Nuclear heartbeat and block cursor routes', async () => {
    const { fetch, calls } = fakeFetch((req) => {
      if (req.url.pathname === '/v1/nuclear/heartbeat') {
        return json(200, { nuclearActive: true, endsAt: LATER, serverNow: NOW });
      }
      if (req.url.pathname === '/v1/blocks') {
        return json(200, { blocks: [], nextCursor: 'MTc1OTAwMDAwMDAwMF9ibGs' });
      }
      return json(200, {
        session: session({ status: 'completed', phase: 'ended' }),
        summary: null,
      });
    });
    const client = createGuardianClient({ token: 'cta_x', fetch });
    await client.getStudySession(STU);
    expect(calls[0]?.url.pathname).toBe(`/v1/study/sessions/${STU}`);
    const nuclear = await client.nuclearHeartbeat({ overlayShown: true, displays: 2 });
    expect(nuclear.nuclearActive).toBe(true);
    const page = await client.listBlocks({ status: 'ended', cursor: 'abc_-1', limit: 10 });
    expect(page.nextCursor).toBe('MTc1OTAwMDAwMDAwMF9ibGs');
    expect(Object.fromEntries(calls[2]?.url.searchParams ?? [])).toEqual({
      status: 'ended',
      cursor: 'abc_-1',
      limit: '10',
    });
  });

  it('returns nothing for 204 deletes', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = createGuardianClient({ token: 'cta_x', fetch });
    await expect(client.deleteSchedule(`sch_${BODY}`)).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('verifies the extension rules signature, nonce and version', async () => {
    const token = 'cte_extension_token_value';
    const { privateKey, publicKey } = await generateRulesKeyPair();
    const other = await generateRulesKeyPair();
    const rules = (nonce: string, extRulesVersion = 57) => ({
      extRulesVersion,
      nonce,
      serverNow: NOW,
      blockDomains: ['youtube.com', 'www.youtube.com'],
      excludedDomains: ['accounts.youtube.com'],
      whitelist: null,
      blocks: [
        {
          id: BLK,
          kind: 'manual',
          mode: 'strict',
          endsAt: LATER,
          reason: 'Quiero aprobar mates',
          serviceIds: ['youtube'],
          domains: ['youtube.com', 'www.youtube.com'],
          whitelistOnly: false,
        },
      ],
      allowances: [],
      punishment: null,
      nextChangeAt: LATER,
      penaltiesEnabled: true,
    });
    const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
    const body = JSON.stringify(rules(nonce));
    const signature = await computeRulesSignature(body, privateKey);
    expect(signature).toMatch(/^v1=[A-Za-z0-9_-]{86}$/);
    expect(await verifyRulesSignature(body, signature, publicKey)).toBe(true);
    expect(await verifyRulesSignature(`${body} `, signature, publicKey)).toBe(false);
    expect(await verifyRulesSignature(body, signature, other.publicKey)).toBe(false);
    expect(await verifyRulesSignature(body, null, publicKey)).toBe(false);
    expect(await verifyRulesSignature(body, 'v1=***', publicKey)).toBe(false);
    expect(await verifyRulesSignature(body, signature, 'not-a-key')).toBe(false);

    // A server that echoes the nonce and signs with the guardian key.
    const guardian = fakeFetch(async (req) => {
      const echoed = JSON.stringify(rules(req.url.searchParams.get('nonce') ?? ''));
      return new Response(echoed, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Centrate-Signature': await computeRulesSignature(echoed, privateKey),
        },
      });
    });
    const ext = createGuardianClient({ token, fetch: guardian.fetch, rulesPublicKey: publicKey });
    const ok = await ext.getExtRules({ waitVersion: 56, waitMs: 25_000 });
    expect(ok.notModified).toBe(false);
    expect(ok.notModified ? null : ok.rules.extRulesVersion).toBe(57);
    expect(guardian.calls[0]?.url.searchParams.get('waitVersion')).toBe('56');
    expect(guardian.calls[0]?.url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(ext.getExtRules({ waitVersion: 58 })).rejects.toMatchObject({
      code: 'stale_rules',
    });

    // Valid signature but an old nonce: a replayed body.
    const replay = fakeFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Centrate-Signature': signature },
        }),
    );
    await expect(
      createGuardianClient({ token, fetch: replay.fetch, rulesPublicKey: publicKey }).getExtRules(),
    ).rejects.toMatchObject({ code: 'invalid_signature' });

    // Knowing the token is not enough: an unsigned body, or no pinned key.
    const forged = fakeFetch(() => json(200, { ...rules(nonce), blockDomains: [] }));
    await expect(
      createGuardianClient({ token, fetch: forged.fetch, rulesPublicKey: publicKey }).getExtRules({
        nonce,
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(
      createGuardianClient({ token, fetch: replay.fetch }).getExtRules({ nonce }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });
});
