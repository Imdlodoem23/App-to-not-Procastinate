/**
 * Per-user daily AI quotas, the per-user spend cap and the global daily budget, kept in Postgres
 * so they survive the free service's restarts (owner: COACH). docs/API.md §10.2.
 *
 * Reserve, call, settle: before calling the model one transaction reserves a request, the
 * worst-case tokens and the worst-case cost for the user, and the worst-case cost globally.
 * After the call the reservation is replaced by what the call may have billed: the real usage,
 * an upper bound when the usage never arrived, or nothing when the provider certainly did not
 * run it (see `CoachBilling`). The request stays counted either way.
 *
 * One call in flight per user and feature: a second one answers 429 `rate_limited` until the
 * first settles, so one account cannot hold many worst-case reservations at once.
 *
 * Only counters are stored: no prompt, answer, model id or request id.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily, aiUsage } from '../db/schema';
import { budgetMicroUsd, nextUtcMidnight, userBudgetMicroUsd, utcDay } from './budget';
import type { CoachFeature, CoachModelAttempt } from './model';

export interface Reservation {
  userId: string;
  feature: CoachFeature;
  day: string;
  tokens: number;
  costMicroUsd: number;
  /** Identifies this reservation on its row (`ai_usage.reserved_until`). */
  until: Date;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  /** The daily requests, tokens or spend cap are used up (429 `quota_exceeded`). */
  | { ok: false; reason: 'quota'; resetsAt: Date }
  /** Another call of this user is in flight and must settle first (429 `rate_limited`). */
  | { ok: false; reason: 'busy'; retryAfterMs: number }
  /** The global budget has no room left today, or the call can never fit (503 `budget`). */
  | { ok: false; reason: 'budget' };

export interface ReserveInput {
  userId: string;
  feature: CoachFeature;
  now: Date;
  /** Worst case of this call (`worstCaseAttempts`): tokens and cost. */
  tokens: number;
  costMicroUsd: number;
  /**
   * How long the call may hold the reservation: its deadline plus a margin to settle. Past
   * it, a reservation that never settled (the process died) no longer blocks the user.
   */
  holdMs: number;
}

const requestLimit = (config: Config, feature: CoachFeature): number =>
  feature === 'interpret'
    ? config.ai.limits.userDailyInterpretRequests
    : config.ai.limits.userDailyCoachRequests;

const usedTokens = sql<number>`(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens})`;

interface UsageRow {
  feature: CoachFeature;
  requests: number;
  usedTokens: number;
  reservedTokens: number;
  costMicroUsd: number;
  reservedMicroUsd: number;
  reservedUntil: Date | null;
}

async function usageRows(db: Pick<Db, 'select'>, userId: string, day: string): Promise<UsageRow[]> {
  const rows = await db
    .select({
      feature: aiUsage.feature,
      requests: aiUsage.requests,
      usedTokens: usedTokens,
      reservedTokens: aiUsage.reservedTokens,
      costMicroUsd: aiUsage.costMicroUsd,
      reservedMicroUsd: aiUsage.reservedMicroUsd,
      reservedUntil: aiUsage.reservedUntil,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
  // bigint sums can come back as strings.
  return rows.map((r) => ({
    ...r,
    usedTokens: Number(r.usedTokens),
    reservedTokens: Number(r.reservedTokens),
    costMicroUsd: Number(r.costMicroUsd),
    reservedMicroUsd: Number(r.reservedMicroUsd),
  }));
}

const inFlight = (row: UsageRow, now: Date): boolean =>
  row.reservedUntil !== null && row.reservedUntil.getTime() > now.getTime();

const sumOf = (rows: readonly UsageRow[], pick: (r: UsageRow) => number): number =>
  rows.reduce((total, r) => total + pick(r), 0);

/**
 * Takes one request, the worst-case tokens and the worst-case cost from the user's daily
 * limits and the worst-case cost from today's global budget, atomically. The per-user advisory
 * lock serializes a user's parallel calls (the limits span both features, so one row lock is
 * not enough). Checks, in order:
 *
 * 1. A call of this feature still in flight → `busy` (one call at a time per user and feature).
 * 2. Requests, then tokens and spend (settled + held + this call ≤ limit) → `quota`, unless the
 *    call would fit once the user's other call in flight settles → `busy`.
 * 3. The global budget (spent + held + this call ≤ budget) → `budget`.
 */
export async function reserve(db: Db, config: Config, input: ReserveInput): Promise<ReserveResult> {
  const { now } = input;
  const day = utcDay(now);
  const budget = budgetMicroUsd(config);
  const userBudget = userBudgetMicroUsd(config);
  // A call that could never fit is a configuration problem, not a used-up quota.
  if (input.costMicroUsd > budget || input.costMicroUsd > userBudget) {
    return { ok: false, reason: 'budget' };
  }
  const maxRequests = requestLimit(config, input.feature);
  const maxTokens = config.ai.limits.userDailyTokens;
  const until = new Date(now.getTime() + input.holdMs);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`centrate:ai:${input.userId}`}))`);
    const rows = await usageRows(tx, input.userId, day);
    const own = rows.find((r) => r.feature === input.feature);
    const retryAfter = (row: UsageRow): number =>
      Math.max(1000, (row.reservedUntil?.getTime() ?? 0) - now.getTime());

    if (own && inFlight(own, now)) {
      return { ok: false, reason: 'busy', retryAfterMs: retryAfter(own) } as const;
    }
    if ((own?.requests ?? 0) >= maxRequests) {
      return { ok: false, reason: 'quota', resetsAt: nextUtcMidnight(now) } as const;
    }
    const fits = (held: readonly UsageRow[]): boolean =>
      sumOf(rows, (r) => r.usedTokens) + sumOf(held, (r) => r.reservedTokens) + input.tokens <=
        maxTokens &&
      sumOf(rows, (r) => r.costMicroUsd) +
        sumOf(held, (r) => r.reservedMicroUsd) +
        input.costMicroUsd <=
        userBudget;
    if (!fits(rows)) {
      // What is held by the user's other call in flight comes back when it settles; what is
      // held by a call whose process died stays taken until the janitor frees it, about an hour
      // after its `reserved_until` at most (jobs/janitor.ts).
      const others = rows.filter((r) => inFlight(r, now));
      if (others.length > 0 && fits(rows.filter((r) => !inFlight(r, now)))) {
        const wait = Math.max(...others.map(retryAfter));
        return { ok: false, reason: 'busy', retryAfterMs: wait } as const;
      }
      return { ok: false, reason: 'quota', resetsAt: nextUtcMidnight(now) } as const;
    }

    // Global budget: the conditional upsert only succeeds while spent + held + this ≤ budget.
    const global = await tx
      .insert(aiGlobalDaily)
      .values({ day, requests: 1, costMicroUsd: 0, reservedMicroUsd: input.costMicroUsd })
      .onConflictDoUpdate({
        target: aiGlobalDaily.day,
        set: {
          requests: sql`${aiGlobalDaily.requests} + 1`,
          reservedMicroUsd: sql`${aiGlobalDaily.reservedMicroUsd} + ${input.costMicroUsd}`,
        },
        setWhere: sql`${aiGlobalDaily.costMicroUsd} + ${aiGlobalDaily.reservedMicroUsd} + ${input.costMicroUsd} <= ${budget}`,
      })
      .returning({ day: aiGlobalDaily.day });
    if (!global[0]) return { ok: false, reason: 'budget' } as const;

    await tx
      .insert(aiUsage)
      .values({
        userId: input.userId,
        day,
        feature: input.feature,
        requests: 1,
        reservedTokens: input.tokens,
        reservedMicroUsd: input.costMicroUsd,
        reservedUntil: until,
      })
      .onConflictDoUpdate({
        target: [aiUsage.userId, aiUsage.day, aiUsage.feature],
        set: {
          requests: sql`${aiUsage.requests} + 1`,
          reservedTokens: sql`${aiUsage.reservedTokens} + ${input.tokens}`,
          reservedMicroUsd: sql`${aiUsage.reservedMicroUsd} + ${input.costMicroUsd}`,
          reservedUntil: until,
        },
      });
    return {
      ok: true,
      reservation: {
        userId: input.userId,
        feature: input.feature,
        day,
        tokens: input.tokens,
        costMicroUsd: input.costMicroUsd,
        until,
      },
    } as const;
  });
}

/**
 * Replaces the reservation with what the call billed (or may have billed): every attempt's
 * tokens and `costMicroUsd`. Frees the row for the next call only if the row still holds this
 * reservation (a late settle after a newer call started must not free that one).
 */
export async function settle(
  db: Db,
  reservation: Reservation,
  attempts: readonly CoachModelAttempt[],
  costMicroUsd: number,
): Promise<void> {
  const sum = (pick: (a: CoachModelAttempt) => number): number =>
    attempts.reduce((total, a) => total + pick(a), 0);
  await db.transaction(async (tx) => {
    await tx
      .update(aiUsage)
      .set({
        reservedTokens: sql`GREATEST(${aiUsage.reservedTokens} - ${reservation.tokens}, 0)`,
        reservedMicroUsd: sql`GREATEST(${aiUsage.reservedMicroUsd} - ${reservation.costMicroUsd}, 0)`,
        reservedUntil: sql`CASE WHEN ${aiUsage.reservedUntil} = ${reservation.until} THEN NULL ELSE ${aiUsage.reservedUntil} END`,
        inputTokens: sql`${aiUsage.inputTokens} + ${sum((a) => a.inputTokens)}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${sum((a) => a.outputTokens)}`,
        cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${sum((a) => a.cacheReadTokens)}`,
        cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${sum((a) => a.cacheWriteTokens)}`,
        costMicroUsd: sql`${aiUsage.costMicroUsd} + ${costMicroUsd}`,
      })
      .where(ownRow(reservation));
    await tx
      .update(aiGlobalDaily)
      .set({
        reservedMicroUsd: sql`GREATEST(${aiGlobalDaily.reservedMicroUsd} - ${reservation.costMicroUsd}, 0)`,
        costMicroUsd: sql`${aiGlobalDaily.costMicroUsd} + ${costMicroUsd}`,
      })
      .where(eq(aiGlobalDaily.day, reservation.day));
  });
}

/**
 * The provider certainly did not bill the call: give the tokens and the cost back, keep the
 * request counted (it still stops hammering).
 */
export function release(db: Db, reservation: Reservation): Promise<void> {
  return settle(db, reservation, [], 0);
}

function ownRow(r: Reservation) {
  return and(eq(aiUsage.userId, r.userId), eq(aiUsage.day, r.day), eq(aiUsage.feature, r.feature));
}

export interface QuotaLeft {
  interpret: { requestsLeft: number };
  coach: { requestsLeft: number; tokensLeft: number };
  resetsAt: Date;
}

/**
 * What is left today for GET /v1/coach/quota. The spend cap is not reported as such: a call
 * whose worst case no longer fits answers 429 `quota_exceeded` even with requests left.
 */
export async function quotaLeft(
  db: Db,
  config: Config,
  userId: string,
  now: Date,
): Promise<QuotaLeft> {
  const rows = await usageRows(db, userId, utcDay(now));
  const requests = (feature: CoachFeature): number =>
    rows.find((r) => r.feature === feature)?.requests ?? 0;
  const tokens = sumOf(rows, (r) => r.usedTokens + r.reservedTokens);
  const left = (limit: number, taken: number): number => Math.max(0, limit - taken);
  const L = config.ai.limits;
  return {
    interpret: { requestsLeft: left(L.userDailyInterpretRequests, requests('interpret')) },
    coach: {
      requestsLeft: left(L.userDailyCoachRequests, requests('coach')),
      tokensLeft: left(L.userDailyTokens, tokens),
    },
    resetsAt: nextUtcMidnight(now),
  };
}

/**
 * `metadata.user_id` for Anthropic: lets them spot abuse per end user without learning who
 * it is. First 32 hex chars of HMAC-SHA256(BETTER_AUTH_SECRET, `anthropic:<userId>`).
 */
export function anthropicUserHash(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(`anthropic:${userId}`).digest('hex').slice(0, 32);
}
