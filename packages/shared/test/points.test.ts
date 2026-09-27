import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getService } from '../src/catalog';
import { DEFAULT_GUARDIAN_SETTINGS } from '../src/guardian-api';
import type { BlockKind, BlockMode, GuardianEvent, StudyOutcome, WireEvent } from '../src/domain';
import { EVENT_TYPES } from '../src/domain';
import type { LedgerInput, LedgerState, LedgerStep } from '../src/points';
import {
  EMERGENCY_RULES,
  POINT_RULES,
  REWARD_OFFERS,
  RULES_VERSION,
  STUDY_RULES,
  addDays,
  allowanceRefund,
  applyLedgerInput,
  attemptPenalty,
  blockCompletionPoints,
  computeLedger,
  dayNumber,
  emergencyCountdownMinutes,
  emergencyPenalty,
  emergencyPhraseMatches,
  findRewardOffer,
  initialLedgerState,
  isLocalDay,
  ledgerInputFromEvent,
  levelForXp,
  maxEscalationIndex,
  normalizePhrase,
  replayEvents,
  rulesSnapshot,
  studyEndBonus,
  summarizeLedger,
  xpForLevel,
} from '../src/points';

// ---------------------------------------------------------------------------------------
// Shared parity vectors (also run by the Go guardian)
// ---------------------------------------------------------------------------------------

interface FunctionVector {
  name: string;
  fn: string;
  args: unknown[];
  expect: unknown;
}

interface SequenceVector {
  name: string;
  steps: Array<{ input: Record<string, unknown>; expect: Record<string, unknown> }>;
  summary: { today: string; goalMinutes: number };
  expectFinal: Record<string, unknown>;
}

interface VectorFile {
  formatVersion: number;
  rulesVersion: number;
  functions: FunctionVector[];
  sequences: SequenceVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/points-vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  attemptPenalty: (a) => attemptPenalty(a[0] as number),
  emergencyPenalty: (a) => emergencyPenalty(a[0] as number),
  emergencyCountdownMinutes: (a) => emergencyCountdownMinutes(a[0] as BlockMode[]),
  levelForXp: (a) => levelForXp(a[0] as number),
  xpForLevel: (a) => xpForLevel(a[0] as number),
  allowanceRefund: (a) => allowanceRefund(a[0] as number, a[1] as number, a[2] as number),
  blockCompletionPoints: (a) =>
    blockCompletionPoints(a[0] as BlockKind, a[1] as number, a[2] as number).total,
  studyEndBonus: (a) =>
    studyEndBonus(a[0] as StudyOutcome, a[1] as number, a[2] as number, a[3] as number),
  emergencyPhraseMatches: (a) => emergencyPhraseMatches(a[0] as string),
  normalizePhrase: (a) => normalizePhrase(a[0] as string),
  addDays: (a) => addDays(a[0] as string, a[1] as number),
};

/** Vector inputs carry ISO `at` (and `escalation.lastCountedAt`); the ledger takes ms. */
function toLedgerInput(raw: Record<string, unknown>): LedgerInput {
  const { at, escalation, ...rest } = raw;
  const input: Record<string, unknown> = { ...rest, atMs: Date.parse(at as string) };
  if (escalation !== undefined) {
    const e = escalation as { lastCountedAt: string | null; index: number };
    input['escalation'] = {
      lastCountedAtMs: e.lastCountedAt === null ? null : Date.parse(e.lastCountedAt),
      index: e.index,
    };
  }
  return input as unknown as LedgerInput;
}

function actual(step: LedgerStep, key: string): unknown {
  if (key === 'points') return step.points;
  if (key === 'xp') return step.xp;
  if (key === 'balance') return step.state.balance;
  return (step.outcome as Record<string, unknown>)[key];
}

describe('points parity vectors', () => {
  it('match this rules version and have enough coverage', () => {
    expect(vectors.formatVersion).toBe(1);
    expect(vectors.rulesVersion).toBe(RULES_VERSION);
    expect(vectors.sequences.length).toBeGreaterThanOrEqual(15);
    for (const fn of new Set(vectors.functions.map((f) => f.fn))) {
      expect(FUNCTIONS, `runner for ${fn}`).toHaveProperty(fn);
    }
  });

  describe.each(vectors.functions.map((f) => [f.name, f] as const))('function: %s', (_, v) => {
    it('returns the expected value', () => {
      const run = FUNCTIONS[v.fn];
      expect(run).toBeDefined();
      expect(run?.(v.args)).toEqual(v.expect);
    });
  });

  describe.each(vectors.sequences.map((s) => [s.name, s] as const))('sequence: %s', (_, v) => {
    it('produces the expected deltas and final summary', () => {
      let state: LedgerState = initialLedgerState();
      v.steps.forEach((s, i) => {
        const step = applyLedgerInput(state, toLedgerInput(s.input));
        for (const [key, want] of Object.entries(s.expect)) {
          expect(actual(step, key), `step ${i} (${String(s.input['type'])}) ${key}`).toEqual(want);
        }
        state = step.state;
      });
      const summary = summarizeLedger(state, v.summary);
      expect({
        balance: summary.balance,
        xp: summary.xp,
        level: summary.level,
        streakDays: summary.streakDays,
        bestStreakDays: summary.bestStreakDays,
        todayFocusMinutes: summary.today.focusMinutes,
        todayGoalMet: summary.today.goalMet,
      }).toEqual(v.expectFinal);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------

describe('rule values (PROMPT.md §7)', () => {
  it('has the documented values', () => {
    expect(POINT_RULES.blockPointsPerMinute).toBe(1);
    expect(POINT_RULES.studyPointsPerFocusMinute).toBe(2);
    expect(POINT_RULES.cleanSessionBonus).toBe(20);
    expect(POINT_RULES.attemptBasePenalty).toBe(10);
    expect(POINT_RULES.attemptPenaltyCap).toBe(80);
    expect(POINT_RULES.attemptEscalationWindowMs).toBe(300_000);
    expect(POINT_RULES.attemptDedupeWindowMs).toBe(30_000);
    expect(POINT_RULES.strikePenalty).toBe(15);
    expect(POINT_RULES.punishmentPenalty).toBe(100);
    expect(POINT_RULES.emergencyMinPenalty).toBe(200);
    expect(POINT_RULES.dailyGoalDefaultMinutes).toBe(60);
    expect(EMERGENCY_RULES.countdownMinutes).toEqual({ normal: 10, strict: 30 });
    expect(STUDY_RULES.maxStrikes).toBe(3);
    expect(STUDY_RULES.heartbeatTimeoutMs).toBe(120_000);
    expect(STUDY_RULES.punishmentMinutes).toEqual({ min: 15, max: 120, default: 60 });
    expect(maxEscalationIndex()).toBe(3);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(POINT_RULES)).toBe(true);
    expect(Object.isFrozen(EMERGENCY_RULES.phrases)).toBe(true);
    expect(Object.isFrozen(REWARD_OFFERS)).toBe(true);
    expect(Object.isFrozen(REWARD_OFFERS[0])).toBe(true);
  });

  it('offers only catalog services, with unique ids and sane prices', () => {
    expect(findRewardOffer('youtube-15')).toEqual({
      id: 'youtube-15',
      serviceId: 'youtube',
      minutes: 15,
      cost: 150,
    });
    expect(new Set(REWARD_OFFERS.map((o) => o.id)).size).toBe(REWARD_OFFERS.length);
    for (const offer of REWARD_OFFERS) {
      expect(getService(offer.serviceId), offer.id).toBeDefined();
      expect(getService(offer.serviceId)?.categories.length, offer.id).toBeGreaterThan(0);
      expect(offer.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(offer.minutes).toBeGreaterThanOrEqual(5);
      expect(offer.cost).toBeGreaterThan(0);
    }
    expect(findRewardOffer('nope')).toBeUndefined();
  });

  it('snapshots every rule as plain JSON for the guardian', () => {
    const snap = rulesSnapshot();
    expect(snap.rulesVersion).toBe(RULES_VERSION);
    expect(snap.points).toEqual({ ...POINT_RULES, earningBlockKinds: ['manual', 'schedule'] });
    expect(snap.emergency.phrases.es).toBe('Acepto romper mi compromiso y perder mis puntos');
    expect(snap.rewardOffers).toHaveLength(REWARD_OFFERS.length);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(Object.isFrozen(snap.points)).toBe(false);
  });

  it('keeps the commitment phrases ASCII so the Go port normalizes them identically', () => {
    for (const phrase of Object.values(EMERGENCY_RULES.phrases)) {
      expect(phrase).toMatch(/^[\x20-\x7e]+$/);
      expect(emergencyPhraseMatches(phrase)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Days and levels
// ---------------------------------------------------------------------------------------

describe('civil days', () => {
  it('validates real dates only', () => {
    expect(isLocalDay('2026-09-27')).toBe(true);
    expect(isLocalDay('2026-02-29')).toBe(false);
    expect(isLocalDay('2028-02-29')).toBe(true);
    expect(isLocalDay('2026-9-27')).toBe(false);
    expect(isLocalDay(20260927)).toBe(false);
    expect(dayNumber('1970-01-02')).toBe(1);
  });

  it('refuses to add days to an invalid date', () => {
    expect(() => addDays('2026-13-01', 1)).toThrow(RangeError);
  });
});

describe('levels', () => {
  it('are monotonic and consistent with xpForLevel', () => {
    let previous = 1;
    for (let xp = 0; xp <= 20_000; xp += 7) {
      const level = levelForXp(xp);
      expect(level).toBeGreaterThanOrEqual(previous);
      expect(xpForLevel(level)).toBeLessThanOrEqual(xp);
      expect(xpForLevel(level + 1)).toBeGreaterThan(xp);
      previous = level;
    }
  });
});

// ---------------------------------------------------------------------------------------
// Ledger behaviour
// ---------------------------------------------------------------------------------------

const DAY = '2026-09-27';
const at = (hms: string): number => Date.parse(`${DAY}T${hms}Z`);

describe('ledger', () => {
  it('never mutates the input state', () => {
    const state = initialLedgerState();
    const frozen = JSON.stringify(state);
    applyLedgerInput(state, {
      type: 'attempt_detected',
      atMs: at('10:00:00'),
      day: DAY,
      key: 'svc:youtube',
      penalized: true,
    });
    applyLedgerInput(state, { type: 'focus_minutes', atMs: at('10:00:00'), day: DAY, minutes: 5 });
    expect(JSON.stringify(state)).toBe(frozen);
  });

  it('prunes dedupe entries older than the window', () => {
    const { state } = computeLedger([
      { type: 'attempt_detected', atMs: at('10:00:00'), day: DAY, key: 'svc:a', penalized: true },
      { type: 'attempt_detected', atMs: at('10:00:20'), day: DAY, key: 'svc:b', penalized: true },
      { type: 'attempt_detected', atMs: at('10:01:00'), day: DAY, key: 'svc:c', penalized: true },
    ]);
    expect(Object.keys(state.dedupe)).toEqual(['svc:c']);
  });

  it('computeLedger reports every step', () => {
    const { state, steps } = computeLedger([
      { type: 'strike', atMs: at('10:00:00'), day: DAY },
      { type: 'punishment_started', atMs: at('10:00:00'), day: DAY },
    ]);
    expect(steps.map((s) => s.points)).toEqual([-15, -100]);
    expect(state.balance).toBe(-115);
  });

  it('summarizes the level window', () => {
    const { state } = computeLedger([
      { type: 'focus_minutes', atMs: at('10:00:00'), day: DAY, minutes: 90 },
    ]);
    const summary = summarizeLedger(state, { today: DAY, goalMinutes: 60 });
    expect(summary).toMatchObject({
      level: 2,
      levelFloorXp: 60,
      nextLevelXp: 180,
      streakDays: 1,
      today: { day: DAY, focusMinutes: 90, goalMinutes: 60, goalMet: true },
    });
  });
});

// ---------------------------------------------------------------------------------------
// Event mapping and replay
// ---------------------------------------------------------------------------------------

const EPOCH = 'ep_0123456789abcdefABCD';
const BLOCK = 'blk_0123456789abcdefABCD';
const SESSION = 'stu_0123456789abcdefABCD';
const ATTEMPT = 'att_0123456789abcdefABCD';

function envelope(seq: number, points: number, xp = 0, iso = '2026-09-27T10:00:00.000Z') {
  return {
    v: 1 as const,
    epoch: EPOCH as `ep_${string}`,
    seq,
    at: iso,
    wallOffsetMs: 0,
    day: DAY,
    points,
    xp,
    txEnd: true,
    req: null,
  };
}

function keptNothing() {
  return {
    blocks: [],
    punishments: [],
    allowances: [],
    schedules: [],
    settings: structuredClone(DEFAULT_GUARDIAN_SETTINGS),
    pendingSettings: [],
  };
}

const LEDGER_EVENT_TYPES = new Set([
  'epoch_started',
  'day_closed',
  'block_completed',
  'block_reactivated',
  'attempt',
  'focus_minutes',
  'strike',
  'study_ended',
  'punishment_started',
  'emergency_confirmed',
  'reward_redeemed',
  'reward_ended',
  'tamper_detected',
  'ledger_repaired',
]);

describe('ledgerInputFromEvent', () => {
  it('knows which event types affect the ledger', () => {
    for (const type of LEDGER_EVENT_TYPES) expect(EVENT_TYPES).toContain(type);
  });

  it('maps logged events to inputs', () => {
    const attempt: GuardianEvent = {
      ...envelope(2, -10),
      type: 'attempt',
      data: {
        attemptId: ATTEMPT,
        layer: 'extension',
        targetKey: 'svc:youtube',
        targetType: 'service',
        serviceId: 'youtube',
        blockIds: [BLOCK],
        browser: 'chrome',
        incognito: false,
        escalationIndex: 0,
        penalized: true,
      },
    };
    expect(ledgerInputFromEvent(attempt)).toEqual({
      type: 'attempt',
      atMs: at('10:00:00'),
      day: DAY,
      key: 'svc:youtube',
      penalized: true,
    });
    const closed: GuardianEvent = {
      ...envelope(3, 0),
      type: 'day_closed',
      data: { day: '2026-09-26', goalMinutes: 60 },
    };
    expect(ledgerInputFromEvent(closed)).toMatchObject({
      type: 'day_closed',
      closedDay: '2026-09-26',
      goalMinutes: 60,
    });
    const tamper: GuardianEvent = {
      ...envelope(4, -30),
      type: 'tamper_detected',
      data: { kind: 'ledger_rollback', balanceCorrection: -30 },
    };
    expect(ledgerInputFromEvent(tamper)).toMatchObject({
      type: 'balance_correction',
      amount: -30,
    });
    const epoch: GuardianEvent = {
      ...envelope(1, -40),
      type: 'epoch_started',
      data: {
        reason: 'data_deleted',
        previousEpoch: null,
        carryOverBalance: -40,
        escalation: { lastCountedAt: '2026-09-27T09:58:00.000Z', index: 2 },
        kept: keptNothing(),
      },
    };
    expect(ledgerInputFromEvent(epoch)).toMatchObject({
      type: 'epoch_started',
      carryOverBalance: -40,
      escalation: { lastCountedAtMs: at('09:58:00'), index: 2 },
    });
    const paired: GuardianEvent = {
      ...envelope(5, 0),
      type: 'extension_revoked',
      data: { extensionId: 'ext_0123456789abcdefABCD' },
    };
    expect(ledgerInputFromEvent(paired)).toBeNull();
  });
});

describe('replayEvents', () => {
  const events: WireEvent[] = [
    {
      ...envelope(1, 0),
      type: 'epoch_started',
      data: {
        reason: 'install',
        previousEpoch: null,
        carryOverBalance: 0,
        escalation: { lastCountedAt: null, index: 0 },
        kept: keptNothing(),
      },
    },
    {
      ...envelope(2, 100, 50, '2026-09-27T11:00:00.000Z'),
      type: 'focus_minutes',
      data: { sessionId: SESSION, minutes: 50 },
    },
    {
      ...envelope(3, 20, 0, '2026-09-27T11:00:00.000Z'),
      type: 'study_ended',
      data: {
        sessionId: SESSION,
        outcome: 'completed',
        plannedMinutes: 50,
        activeMinutes: 50,
        focusedMinutes: 50,
        strikes: 0,
        attempts: 0,
      },
    },
    // A type from a newer guardian: only its recorded deltas apply.
    {
      ...envelope(4, 7, 0, '2026-09-27T11:05:00.000Z'),
      type: 'future_bonus',
      data: { anything: true },
    },
  ];

  it('rebuilds the ledger from recorded deltas and reports no mismatch', () => {
    const { state, mismatches } = replayEvents(events);
    expect(mismatches).toEqual([]);
    expect(state.balance).toBe(127);
    expect(state.xp).toBe(50);
    expect(state.openDays[DAY]).toBe(50);
  });

  it('keeps recorded deltas authoritative and flags derivation drift', () => {
    const drifted = events.map((e) => (e.seq === 3 ? { ...e, points: 25 } : e));
    const { state, mismatches } = replayEvents(drifted);
    expect(mismatches).toEqual([3]);
    expect(state.balance).toBe(132);
  });
});
