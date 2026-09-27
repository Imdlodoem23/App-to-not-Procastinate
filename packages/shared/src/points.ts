/**
 * Points, XP, levels, streak, reward shop and the emergency/study rules the guardian
 * enforces (PROMPT.md §7 and §8). This file is the ONLY place where these values live:
 *
 * - The guardian embeds `rulesSnapshot()` as generated JSON
 *   (`guardian/internal/embedded/rules.json`, never edited by hand) and has a Go port of
 *   the pure functions below.
 * - Parity is checked by `packages/shared/test/fixtures/points-vectors.json`, run by
 *   vitest (`points.test.ts`) and by `go test` in the guardian.
 * - Bump `RULES_VERSION` whenever a value or a rule changes.
 *
 * The ledger is event-sourced: `applyLedgerInput` derives the balance/XP delta of one
 * event from the current `LedgerState`. The guardian records the delta in the event
 * envelope at emission, so history never changes when these values are tuned later.
 *
 * Everything here is pure (no I/O, no clock, no time zones) and has no side effects.
 */
import type {
  BlockKind,
  BlockMode,
  GuardianEvent,
  LocalDay,
  PointsSummary,
  PunishmentLevel,
  StudyOutcome,
  WireEvent,
} from './domain';
import { isKnownEvent } from './domain';

/** Version of the rules below; recorded in `guardian_started` and `/v1/health`. */
export const RULES_VERSION = 1;

// ---------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------

export interface PointRules {
  /** +1 per credited minute of a completed block (PROMPT §7). */
  blockPointsPerMinute: number;
  /** Block kinds that earn points; punishment and recovered blocks earn nothing. */
  earningBlockKinds: readonly BlockKind[];
  /** +2 per focused minute in Study Mode. */
  studyPointsPerFocusMinute: number;
  /** +20 for finishing a block or study session without any attempt (or strike). */
  cleanSessionBonus: number;
  /**
   * Anti-farming (not in PROMPT; recorded in DECISIONS.md): the clean bonus needs at
   * least this many credited block minutes, or planned study minutes. Without it, twelve
   * 5-minute blocks per hour would earn 300 points instead of 80.
   */
  cleanSessionMinMinutes: number;
  /** −10 for the first attempt. */
  attemptBasePenalty: number;
  /** Each repeat within the escalation window doubles the penalty… */
  attemptPenaltyMultiplier: number;
  /** …up to −80 per attempt. */
  attemptPenaltyCap: number;
  /** «si repites en menos de 5 min se duplica»: measured from the previous counted attempt. */
  attemptEscalationWindowMs: number;
  /**
   * Detections of the same target key (several layers at once, reloads, an app that
   * reopens itself) closer than this to the previous detection are one attempt. Sliding:
   * each merged detection restarts the window.
   */
  attemptDedupeWindowMs: number;
  /** −15 per Study Mode strike. */
  strikePenalty: number;
  /** −100 when a punishment starts. */
  punishmentPenalty: number;
  /** Emergency unlock costs max(200, floor(max(0, balance) / 2)) and the streak. */
  emergencyMinPenalty: number;
  emergencyBalanceDivisor: number;
  /** XP only goes up: +1 per focused minute. Block minutes give no XP. */
  xpPerFocusMinute: number;
  /** Level curve: reaching level L needs `levelXpStep × L × (L − 1)` XP (L2 = 60, L3 = 180…). */
  levelXpStep: number;
  /** Daily goal of focused minutes for the streak («por defecto, 60 min concentrado»). */
  dailyGoalDefaultMinutes: number;
  dailyGoalMinMinutes: number;
  dailyGoalMaxMinutes: number;
}

export const POINT_RULES: Readonly<PointRules> = Object.freeze({
  blockPointsPerMinute: 1,
  earningBlockKinds: Object.freeze(['manual', 'schedule'] as const),
  studyPointsPerFocusMinute: 2,
  cleanSessionBonus: 20,
  cleanSessionMinMinutes: 25,
  attemptBasePenalty: 10,
  attemptPenaltyMultiplier: 2,
  attemptPenaltyCap: 80,
  attemptEscalationWindowMs: 5 * 60_000,
  attemptDedupeWindowMs: 30_000,
  strikePenalty: 15,
  punishmentPenalty: 100,
  emergencyMinPenalty: 200,
  emergencyBalanceDivisor: 2,
  xpPerFocusMinute: 1,
  levelXpStep: 30,
  dailyGoalDefaultMinutes: 60,
  dailyGoalMinMinutes: 15,
  dailyGoalMaxMinutes: 600,
});

export interface EmergencyRules {
  /** Countdown by strictest targeted mode (PROMPT §7). Hardcore and exam have none. */
  countdownMinutes: { normal: number; strict: number };
  /** Once ready, the unlock must be confirmed within this window or it expires. */
  confirmWindowMinutes: number;
  /** Commitment phrase the user types by hand, per UI language. ASCII only. */
  phrases: { es: string; en: string };
}

export const EMERGENCY_RULES: Readonly<EmergencyRules> = Object.freeze({
  countdownMinutes: Object.freeze({ normal: 10, strict: 30 }),
  confirmWindowMinutes: 5,
  phrases: Object.freeze({
    es: 'Acepto romper mi compromiso y perder mis puntos',
    en: 'I accept breaking my commitment and losing my points',
  }),
});

export interface StudyRules {
  plannedMinutes: { min: number; max: number };
  pomodoroWorkMinutes: { min: number; max: number };
  pomodoroBreakMinutes: { min: number; max: number };
  /** App-side attention thresholds (defaults; «tiempos configurables»). */
  doubtAfterMs: number;
  strikeAfterDoubtMs: number;
  noFaceStrikeMs: number;
  /** Guardian-enforced. */
  maxStrikes: number;
  strikeCooldownMs: number;
  heartbeatIntervalMs: number;
  /** Awake time without heartbeats (guardian running) that counts as abandonment. */
  heartbeatTimeoutMs: number;
  /** Grace after a reboot for the app to resume the session. */
  bootGraceMs: number;
  pauseMs: number;
  maxPausesPerWindow: number;
  pauseWindowMs: number;
  /** Accepted focus is logged in chunks of this many whole minutes (and at the end). */
  focusFlushMinutes: number;
  /** `end` within this of the planned end counts as completed. */
  completionGraceMs: number;
  /** «¿Lo has conseguido?» can be answered this long after the session ends. */
  outcomeWindowMs: number;
  punishmentMinutes: { min: number; max: number; default: number };
  defaultPunishmentLevel: PunishmentLevel;
}

export const STUDY_RULES: Readonly<StudyRules> = Object.freeze({
  plannedMinutes: Object.freeze({ min: 5, max: 480 }),
  pomodoroWorkMinutes: Object.freeze({ min: 5, max: 120 }),
  pomodoroBreakMinutes: Object.freeze({ min: 1, max: 60 }),
  doubtAfterMs: 15_000,
  strikeAfterDoubtMs: 30_000,
  noFaceStrikeMs: 60_000,
  maxStrikes: 3,
  strikeCooldownMs: 60_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 120_000,
  bootGraceMs: 600_000,
  pauseMs: 300_000,
  maxPausesPerWindow: 2,
  pauseWindowMs: 3_600_000,
  focusFlushMinutes: 5,
  completionGraceMs: 30_000,
  outcomeWindowMs: 24 * 3_600_000,
  punishmentMinutes: Object.freeze({ min: 15, max: 120, default: 60 }),
  defaultPunishmentLevel: 'distractions' as const,
});

/** One item of the reward shop: `minutes` of `serviceId` for `cost` points. */
export interface RewardOffer {
  /** Stable id; never reuse or delete one (deprecate instead). */
  id: string;
  /** Catalog service id; the guardian opens only that service's catalog domains/apps. */
  serviceId: string;
  minutes: number;
  cost: number;
}

/** «15 min de YouTube por 150 puntos» and friends. */
export const REWARD_OFFERS: readonly RewardOffer[] = Object.freeze(
  [
    { id: 'youtube-15', serviceId: 'youtube', minutes: 15, cost: 150 },
    { id: 'youtube-30', serviceId: 'youtube', minutes: 30, cost: 280 },
    { id: 'tiktok-15', serviceId: 'tiktok', minutes: 15, cost: 150 },
    { id: 'instagram-15', serviceId: 'instagram', minutes: 15, cost: 150 },
    { id: 'twitch-30', serviceId: 'twitch', minutes: 30, cost: 280 },
    { id: 'netflix-45', serviceId: 'netflix', minutes: 45, cost: 400 },
    { id: 'discord-15', serviceId: 'discord', minutes: 15, cost: 120 },
    { id: 'roblox-30', serviceId: 'roblox', minutes: 30, cost: 300 },
  ].map((offer) => Object.freeze(offer)),
);

/** The offer with this id, if any. */
export function findRewardOffer(id: string): RewardOffer | undefined {
  return REWARD_OFFERS.find((offer) => offer.id === id);
}

/**
 * Everything the guardian embeds, as plain JSON (`guardian/internal/embedded/rules.json`).
 */
export function rulesSnapshot(): {
  rulesVersion: number;
  points: PointRules;
  emergency: EmergencyRules;
  study: StudyRules;
  rewardOffers: RewardOffer[];
} {
  return JSON.parse(
    JSON.stringify({
      rulesVersion: RULES_VERSION,
      points: POINT_RULES,
      emergency: EMERGENCY_RULES,
      study: STUDY_RULES,
      rewardOffers: REWARD_OFFERS,
    }),
  ) as ReturnType<typeof rulesSnapshot>;
}

// ---------------------------------------------------------------------------------------
// Pure rule functions
// ---------------------------------------------------------------------------------------

/** Smallest escalation index whose penalty reaches the cap (3 with 10/2/80). */
export function maxEscalationIndex(rules: Readonly<PointRules> = POINT_RULES): number {
  let index = 0;
  let penalty = rules.attemptBasePenalty;
  while (penalty < rules.attemptPenaltyCap && index < 30) {
    penalty *= rules.attemptPenaltyMultiplier;
    index += 1;
  }
  return index;
}

/** Penalty (positive) of an attempt with this escalation index: 10, 20, 40, 80, 80… */
export function attemptPenalty(
  escalationIndex: number,
  rules: Readonly<PointRules> = POINT_RULES,
): number {
  const index = Math.max(0, Math.min(Math.trunc(escalationIndex), maxEscalationIndex(rules)));
  let penalty = rules.attemptBasePenalty;
  for (let i = 0; i < index; i += 1) penalty *= rules.attemptPenaltyMultiplier;
  return Math.min(penalty, rules.attemptPenaltyCap);
}

/** Escalation index of a counted attempt at `atMs` after `previous`. */
export function nextEscalationIndex(
  previous: { lastCountedAtMs: number | null; index: number },
  atMs: number,
  rules: Readonly<PointRules> = POINT_RULES,
): number {
  if (previous.lastCountedAtMs === null) return 0;
  if (atMs - previous.lastCountedAtMs >= rules.attemptEscalationWindowMs) return 0;
  return Math.min(previous.index + 1, maxEscalationIndex(rules));
}

/** Emergency penalty (positive): max(200, floor(max(0, balance) / 2)). */
export function emergencyPenalty(
  balance: number,
  rules: Readonly<PointRules> = POINT_RULES,
): number {
  const half = Math.floor(Math.max(0, balance) / rules.emergencyBalanceDivisor);
  return Math.max(rules.emergencyMinPenalty, half);
}

/** True when an emergency unlock may target a block in this mode. */
export function isEmergencyEligibleMode(mode: BlockMode): boolean {
  return mode === 'normal' || mode === 'strict';
}

/**
 * Countdown for an emergency unlock covering blocks in these modes: 30 min if any is
 * strict (punishment blocks are strict), else 10 min. `null` when the list is empty or
 * contains a hardcore or exam block (no emergency exists for those).
 */
export function emergencyCountdownMinutes(
  modes: readonly BlockMode[],
  rules: Readonly<EmergencyRules> = EMERGENCY_RULES,
): number | null {
  if (modes.length === 0 || !modes.every(isEmergencyEligibleMode)) return null;
  return modes.includes('strict') ? rules.countdownMinutes.strict : rules.countdownMinutes.normal;
}

/**
 * Normalizes a typed commitment phrase for comparison: trims, collapses runs of ASCII
 * whitespace and no-break spaces to one space, lowercases ASCII letters only and drops
 * one trailing `.`. Deliberately ASCII-only so the Go port matches byte for byte.
 */
export function normalizePhrase(text: string): string {
  let out = text.replace(/[ \t\n\r\f\v\u00a0]+/g, ' ');
  if (out.startsWith(' ')) out = out.slice(1);
  if (out.endsWith(' ')) out = out.slice(0, -1);
  out = out.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (out.endsWith('.')) {
    out = out.slice(0, -1);
    if (out.endsWith(' ')) out = out.slice(0, -1);
  }
  return out;
}

/** True when `typed` matches any language's emergency phrase. */
export function emergencyPhraseMatches(
  typed: string,
  rules: Readonly<EmergencyRules> = EMERGENCY_RULES,
): boolean {
  if (typeof typed !== 'string' || typed.length > 400) return false;
  const normalized = normalizePhrase(typed);
  return Object.values(rules.phrases).some((phrase) => normalizePhrase(phrase) === normalized);
}

/** Points of a completed block: minutes × 1 plus the clean bonus when eligible. */
export function blockCompletionPoints(
  kind: BlockKind,
  creditedMinutes: number,
  attemptsCounted: number,
  rules: Readonly<PointRules> = POINT_RULES,
): { minutePoints: number; cleanBonus: number; total: number } {
  if (!rules.earningBlockKinds.includes(kind) || creditedMinutes <= 0) {
    return { minutePoints: 0, cleanBonus: 0, total: 0 };
  }
  const minutePoints = Math.floor(creditedMinutes) * rules.blockPointsPerMinute;
  const cleanBonus =
    attemptsCounted === 0 && creditedMinutes >= rules.cleanSessionMinMinutes
      ? rules.cleanSessionBonus
      : 0;
  return { minutePoints, cleanBonus, total: minutePoints + cleanBonus };
}

/** Clean bonus of a study session: completed, no strikes, no attempts, long enough. */
export function studyEndBonus(
  outcome: StudyOutcome,
  strikes: number,
  attempts: number,
  plannedMinutes: number,
  rules: Readonly<PointRules> = POINT_RULES,
): number {
  return outcome === 'completed' &&
    strikes === 0 &&
    attempts === 0 &&
    plannedMinutes >= rules.cleanSessionMinMinutes
    ? rules.cleanSessionBonus
    : 0;
}

/**
 * Refund (positive) of a revoked allowance: floor(cost × remaining / total), with
 * `remainingMs` clamped to [0, totalMs]. Integer math; 0 when `totalMs` ≤ 0.
 */
export function allowanceRefund(cost: number, totalMs: number, remainingMs: number): number {
  if (totalMs <= 0 || cost <= 0) return 0;
  const remaining = Math.max(0, Math.min(remainingMs, totalMs));
  return Math.floor((cost * remaining) / totalMs);
}

/** XP needed to reach `level` (level 1 starts at 0). */
export function xpForLevel(level: number, rules: Readonly<PointRules> = POINT_RULES): number {
  const l = Math.trunc(level);
  if (l <= 1) return 0;
  return rules.levelXpStep * l * (l - 1);
}

/** Level for this much XP (≥ 1). */
export function levelForXp(xp: number, rules: Readonly<PointRules> = POINT_RULES): number {
  if (xp <= 0) return 1;
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / rules.levelXpStep)) / 2));
  while (xpForLevel(level + 1, rules) <= xp) level += 1;
  while (level > 1 && xpForLevel(level, rules) > xp) level -= 1;
  return level;
}

// ---------------------------------------------------------------------------------------
// Civil days (pure, time-zone free: the guardian stamps each event with its local day)
// ---------------------------------------------------------------------------------------

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 of a `YYYY-MM-DD` string; NaN when it is not a real date. */
export function dayNumber(day: LocalDay): number {
  const m = DAY_RE.exec(day);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return Number.NaN;
  }
  return Math.round(ms / MS_PER_DAY);
}

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isLocalDay(value: unknown): value is LocalDay {
  return typeof value === 'string' && Number.isFinite(dayNumber(value));
}

/** `day` plus `n` days. */
export function addDays(day: LocalDay, n: number): LocalDay {
  const base = dayNumber(day);
  if (!Number.isFinite(base)) throw new RangeError('addDays: invalid day');
  return new Date((base + Math.trunc(n)) * MS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------

/**
 * Everything the ledger needs to derive the next delta. The guardian persists it in
 * `state.json` (it is rebuildable from the log). JSON-friendly: times are epoch ms.
 */
export interface LedgerState {
  balance: number;
  xp: number;
  /** Consecutive met days up to and including `lastClosedDay`. */
  streak: number;
  bestStreak: number;
  lastClosedDay: LocalDay | null;
  /** Focused minutes of days not closed yet (normally just today). */
  openDays: Record<LocalDay, number>;
  /** Day on which an emergency unlock voided the streak: it can no longer count. */
  voidedDay: LocalDay | null;
  escalation: { lastCountedAtMs: number | null; index: number };
  /** Last detection time per target key, pruned to the dedupe window. */
  dedupe: Record<string, number>;
}

interface LedgerInputBase {
  /** Trusted time, epoch ms. */
  atMs: number;
  /** Local day at emission (envelope `day`). */
  day: LocalDay;
}

/**
 * One fact the ledger understands. All but `attempt_detected` map 1:1 to logged events
 * (see `ledgerInputFromEvent`). `attempt_detected` is a raw detection from any layer: the
 * guardian feeds every detection through it and logs an `attempt` event only when the
 * outcome says `counted`.
 */
export type LedgerInput =
  | (LedgerInputBase & { type: 'attempt_detected'; key: string; penalized: boolean })
  | (LedgerInputBase & { type: 'attempt'; key: string; penalized: boolean })
  | (LedgerInputBase & {
      type: 'block_completed';
      kind: BlockKind;
      creditedMinutes: number;
      attemptsCounted: number;
    })
  | (LedgerInputBase & { type: 'block_reactivated'; revertPoints: number })
  | (LedgerInputBase & { type: 'focus_minutes'; minutes: number })
  | (LedgerInputBase & { type: 'strike' })
  | (LedgerInputBase & {
      type: 'study_ended';
      outcome: StudyOutcome;
      strikes: number;
      attempts: number;
      plannedMinutes: number;
    })
  | (LedgerInputBase & { type: 'punishment_started' })
  | (LedgerInputBase & { type: 'emergency_confirmed'; goalMinutes: number })
  | (LedgerInputBase & { type: 'reward_redeemed'; cost: number })
  | (LedgerInputBase & {
      type: 'reward_ended';
      reason: 'expired' | 'revoked';
      cost: number;
      totalMs: number;
      remainingMs: number;
    })
  | (LedgerInputBase & { type: 'day_closed'; closedDay: LocalDay; goalMinutes: number })
  | (LedgerInputBase & { type: 'balance_correction'; amount: number })
  | (LedgerInputBase & {
      type: 'epoch_started';
      carryOverBalance: number;
      escalation: { lastCountedAtMs: number | null; index: number };
    });

export type LedgerInputType = LedgerInput['type'];

/** Side information about what an input did (only the relevant fields are set). */
export interface LedgerOutcome {
  /** Attempts: counted as a new attempt. */
  counted?: boolean;
  /** Attempts: merged into the previous detection of the same key (no points). */
  merged?: boolean;
  escalationIndex?: number | null;
  /** Attempts, emergencies: the (positive) penalty charged. */
  penalty?: number;
  cleanBonus?: number;
  /** `day_closed`: whether the goal was met; `null` for an already-closed day. */
  met?: boolean | null;
  streakDaysLost?: number;
  refund?: number;
}

export interface LedgerStep {
  state: LedgerState;
  /** Balance delta. */
  points: number;
  /** XP delta. */
  xp: number;
  outcome: LedgerOutcome;
}

export function initialLedgerState(): LedgerState {
  return {
    balance: 0,
    xp: 0,
    streak: 0,
    bestStreak: 0,
    lastClosedDay: null,
    openDays: {},
    voidedDay: null,
    escalation: { lastCountedAtMs: null, index: 0 },
    dedupe: {},
  };
}

/** −n without producing −0 (JSON and Go have no negative zero). */
function neg(n: number): number {
  return n === 0 ? 0 : -n;
}

function cloneState(state: LedgerState): LedgerState {
  return {
    ...state,
    openDays: { ...state.openDays },
    escalation: { ...state.escalation },
    dedupe: { ...state.dedupe },
  };
}

function pruneDedupe(state: LedgerState, atMs: number, rules: Readonly<PointRules>): void {
  for (const [key, last] of Object.entries(state.dedupe)) {
    if (atMs - last >= rules.attemptDedupeWindowMs) delete state.dedupe[key];
  }
}

function isDayOpen(state: LedgerState, day: LocalDay): boolean {
  return state.lastClosedDay === null || dayNumber(day) > dayNumber(state.lastClosedDay);
}

function todayMet(state: LedgerState, today: LocalDay, goalMinutes: number): boolean {
  return (
    isDayOpen(state, today) &&
    state.voidedDay !== today &&
    (state.openDays[today] ?? 0) >= goalMinutes
  );
}

/**
 * Streak as shown on `today`: the closed streak if it reaches yesterday (or today), plus
 * one when today's goal is already met.
 */
export function streakAsOf(state: LedgerState, today: LocalDay, goalMinutes: number): number {
  let closed = 0;
  if (state.lastClosedDay !== null && dayNumber(today) - dayNumber(state.lastClosedDay) <= 1) {
    closed = state.streak;
  }
  return closed + (todayMet(state, today, goalMinutes) ? 1 : 0);
}

/**
 * Applies one input and returns the new state (the input state is not modified), the
 * balance and XP deltas and what happened.
 */
export function applyLedgerInput(
  state: LedgerState,
  input: LedgerInput,
  rules: Readonly<PointRules> = POINT_RULES,
): LedgerStep {
  const next = cloneState(state);
  const outcome: LedgerOutcome = {};
  let points = 0;
  let xp = 0;

  const countAttempt = (key: string, penalized: boolean): void => {
    const index = nextEscalationIndex(next.escalation, input.atMs, rules);
    const penalty = penalized ? attemptPenalty(index, rules) : 0;
    next.escalation = { lastCountedAtMs: input.atMs, index };
    next.dedupe[key] = input.atMs;
    points = neg(penalty);
    outcome.counted = true;
    outcome.merged = false;
    outcome.escalationIndex = index;
    outcome.penalty = penalty;
  };

  switch (input.type) {
    case 'attempt_detected': {
      pruneDedupe(next, input.atMs, rules);
      const last = next.dedupe[input.key];
      if (last !== undefined && input.atMs - last < rules.attemptDedupeWindowMs) {
        next.dedupe[input.key] = Math.max(last, input.atMs);
        outcome.counted = false;
        outcome.merged = true;
        outcome.escalationIndex = null;
        outcome.penalty = 0;
      } else {
        countAttempt(input.key, input.penalized);
      }
      break;
    }
    case 'attempt': {
      pruneDedupe(next, input.atMs, rules);
      countAttempt(input.key, input.penalized);
      break;
    }
    case 'block_completed': {
      const r = blockCompletionPoints(
        input.kind,
        input.creditedMinutes,
        input.attemptsCounted,
        rules,
      );
      points = r.total;
      outcome.cleanBonus = r.cleanBonus;
      break;
    }
    case 'block_reactivated':
      points = neg(Math.max(0, input.revertPoints));
      break;
    case 'focus_minutes': {
      const minutes = Math.max(0, Math.floor(input.minutes));
      points = minutes * rules.studyPointsPerFocusMinute;
      xp = minutes * rules.xpPerFocusMinute;
      if (isDayOpen(next, input.day)) {
        next.openDays[input.day] = (next.openDays[input.day] ?? 0) + minutes;
      }
      break;
    }
    case 'strike':
      points = neg(rules.strikePenalty);
      outcome.penalty = rules.strikePenalty;
      break;
    case 'study_ended': {
      const bonus = studyEndBonus(
        input.outcome,
        input.strikes,
        input.attempts,
        input.plannedMinutes,
        rules,
      );
      points = bonus;
      outcome.cleanBonus = bonus;
      break;
    }
    case 'punishment_started':
      points = neg(rules.punishmentPenalty);
      outcome.penalty = rules.punishmentPenalty;
      break;
    case 'emergency_confirmed': {
      const penalty = emergencyPenalty(next.balance, rules);
      outcome.penalty = penalty;
      outcome.streakDaysLost = streakAsOf(next, input.day, input.goalMinutes);
      points = neg(penalty);
      next.streak = 0;
      next.voidedDay = input.day;
      break;
    }
    case 'reward_redeemed':
      points = neg(Math.max(0, input.cost));
      break;
    case 'reward_ended': {
      const refund =
        input.reason === 'revoked'
          ? allowanceRefund(input.cost, input.totalMs, input.remainingMs)
          : 0;
      points = refund;
      outcome.refund = refund;
      break;
    }
    case 'day_closed': {
      if (!isDayOpen(next, input.closedDay)) {
        outcome.met = null;
        break;
      }
      const consecutive =
        next.lastClosedDay === null ||
        dayNumber(input.closedDay) === dayNumber(next.lastClosedDay) + 1;
      const met =
        next.voidedDay !== input.closedDay &&
        (next.openDays[input.closedDay] ?? 0) >= input.goalMinutes;
      next.streak = met ? (consecutive ? next.streak + 1 : 1) : 0;
      next.bestStreak = Math.max(next.bestStreak, next.streak);
      next.lastClosedDay = input.closedDay;
      const closedNumber = dayNumber(input.closedDay);
      for (const day of Object.keys(next.openDays)) {
        if (dayNumber(day) <= closedNumber) delete next.openDays[day];
      }
      if (next.voidedDay !== null && dayNumber(next.voidedDay) <= closedNumber) {
        next.voidedDay = null;
      }
      outcome.met = met;
      break;
    }
    case 'balance_correction':
      points = Math.trunc(input.amount);
      break;
    case 'epoch_started': {
      // Starts a new epoch: the ledger resets and only a negative balance and the attempt
      // escalation carry over. Its delta is relative to an empty epoch.
      const fresh = initialLedgerState();
      fresh.balance = Math.min(0, input.carryOverBalance);
      fresh.escalation = { ...input.escalation };
      return { state: fresh, points: fresh.balance, xp: 0, outcome };
    }
  }

  next.balance += points;
  next.xp += xp;
  return { state: next, points, xp, outcome };
}

/** Folds `inputs` from `initial` (default: a fresh ledger), keeping every step's deltas. */
export function computeLedger(
  inputs: readonly LedgerInput[],
  rules: Readonly<PointRules> = POINT_RULES,
  initial: LedgerState = initialLedgerState(),
): { state: LedgerState; steps: Array<Omit<LedgerStep, 'state'>> } {
  let state = initial;
  const steps: Array<Omit<LedgerStep, 'state'>> = [];
  for (const input of inputs) {
    const step = applyLedgerInput(state, input, rules);
    state = step.state;
    steps.push({ points: step.points, xp: step.xp, outcome: step.outcome });
  }
  return { state, steps };
}

/** The ledger input of a logged event, or `null` for events without points/streak effect. */
export function ledgerInputFromEvent(event: GuardianEvent): LedgerInput | null {
  const base = { atMs: Date.parse(event.at), day: event.day };
  switch (event.type) {
    case 'attempt':
      return {
        ...base,
        type: 'attempt',
        key: event.data.targetKey,
        penalized: event.data.penalized,
      };
    case 'block_completed':
      return {
        ...base,
        type: 'block_completed',
        kind: event.data.kind,
        creditedMinutes: event.data.creditedMinutes,
        attemptsCounted: event.data.attemptsCounted,
      };
    case 'block_reactivated':
      return { ...base, type: 'block_reactivated', revertPoints: event.data.revertPoints };
    case 'focus_minutes':
      return { ...base, type: 'focus_minutes', minutes: event.data.minutes };
    case 'strike':
      return { ...base, type: 'strike' };
    case 'study_ended':
      return {
        ...base,
        type: 'study_ended',
        outcome: event.data.outcome,
        strikes: event.data.strikes,
        attempts: event.data.attempts,
        plannedMinutes: event.data.plannedMinutes,
      };
    case 'punishment_started':
      return { ...base, type: 'punishment_started' };
    case 'emergency_confirmed':
      return { ...base, type: 'emergency_confirmed', goalMinutes: event.data.goalMinutes };
    case 'reward_redeemed':
      return { ...base, type: 'reward_redeemed', cost: event.data.cost };
    case 'reward_ended':
      return {
        ...base,
        type: 'reward_ended',
        reason: event.data.reason,
        cost: event.data.cost,
        totalMs: event.data.totalMs,
        remainingMs: event.data.remainingMs,
      };
    case 'day_closed':
      return {
        ...base,
        type: 'day_closed',
        closedDay: event.data.day,
        goalMinutes: event.data.goalMinutes,
      };
    case 'tamper_detected':
    case 'ledger_repaired':
      return { ...base, type: 'balance_correction', amount: event.data.balanceCorrection };
    case 'epoch_started': {
      const last = event.data.escalation.lastCountedAt;
      return {
        ...base,
        type: 'epoch_started',
        carryOverBalance: event.data.carryOverBalance,
        escalation: {
          lastCountedAtMs: last === null ? null : Date.parse(last),
          index: event.data.escalation.index,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Replays logged events. Recorded envelope deltas are authoritative for the balance and
 * XP (history never changes when rules are tuned); the derivation rebuilds everything else
 * (escalation, dedupe, streak) and `mismatches` lists the `seq` of known events whose
 * derived delta differs from the recorded one (expected only across `RULES_VERSION`s).
 * Unknown event types apply their recorded deltas only.
 */
export function replayEvents(
  events: readonly WireEvent[],
  rules: Readonly<PointRules> = POINT_RULES,
  initial: LedgerState = initialLedgerState(),
): { state: LedgerState; mismatches: number[] } {
  let state = initial;
  const mismatches: number[] = [];
  for (const event of events) {
    const input = isKnownEvent(event) ? ledgerInputFromEvent(event) : null;
    if (input === null) {
      state = { ...state, balance: state.balance + event.points, xp: state.xp + event.xp };
      continue;
    }
    const before = state;
    const step = applyLedgerInput(before, input, rules);
    if (step.points !== event.points || step.xp !== event.xp) mismatches.push(event.seq);
    const fresh = input.type === 'epoch_started';
    state = {
      ...step.state,
      balance: (fresh ? 0 : before.balance) + event.points,
      xp: (fresh ? 0 : before.xp) + event.xp,
    };
  }
  return { state, mismatches };
}

/** The Progress summary on `today` with the daily goal currently in force. */
export function summarizeLedger(
  state: LedgerState,
  options: { today: LocalDay; goalMinutes: number },
  rules: Readonly<PointRules> = POINT_RULES,
): PointsSummary {
  const level = levelForXp(state.xp, rules);
  const streakDays = streakAsOf(state, options.today, options.goalMinutes);
  const focusMinutes = isDayOpen(state, options.today) ? (state.openDays[options.today] ?? 0) : 0;
  return {
    balance: state.balance,
    xp: state.xp,
    level,
    levelFloorXp: xpForLevel(level, rules),
    nextLevelXp: xpForLevel(level + 1, rules),
    streakDays,
    bestStreakDays: Math.max(state.bestStreak, streakDays),
    today: {
      day: options.today,
      focusMinutes,
      goalMinutes: options.goalMinutes,
      goalMet: todayMet(state, options.today, options.goalMinutes),
    },
  };
}
