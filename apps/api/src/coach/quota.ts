/**
 * Per-user daily AI quotas and the global daily budget, kept in Postgres so they survive the
 * free service's restarts (owner: COACH). docs/API.md §10.2.
 *
 * Reserve, call, settle: before calling the model one transaction reserves a request and the
 * worst-case tokens for the user, and the worst-case cost globally. After the call the
 * reservation is replaced by the real usage. A provider error releases the tokens and the cost
 * but keeps the request counted (it may have been billed, and it stops hammering).
 *
 * Only counters are stored: no prompt, answer, model id or request id.
 */
import { and, eq, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily, aiUsage } from '../db/schema';
import { budgetMicroUsd, nextUtcMidnight, utcDay } from './budget';
import type { CoachFeature, CoachModelAttempt } from './model';

export interface Reservation {
  userId: string;
  feature: CoachFeature;
  day: string;
  tokens: number;
  costMicroUsd: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: 'quota'; resetsAt: Date }
  | { ok: false; reason: 'budget' };

export interface ReserveInput {
  userId: string;
  feature: CoachFeature;
  now: Date;
  /** Worst case of this call: estimated input plus `max_tokens`. */
  tokens: number;
  costMicroUsd: number;
}

const requestLimit = (config: Config, feature: CoachFeature): number =>
  feature === 'interpret'
    ? config.ai.limits.userDailyInterpretRequests
    : config.ai.limits.userDailyCoachRequests;

const usedTokens = sql<number>`(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens})`;

/**
 * Takes one request and the worst-case tokens from the user's quota and the worst-case cost
 * from today's global budget, atomically. The per-user advisory lock serializes a user's
 * parallel calls (the token limit spans both features, so one row lock is not enough).
 */
export async function reserve(db: Db, config: Config, input: ReserveInput): Promise<ReserveResult> {
  const day = utcDay(input.now);
  const budget = budgetMicroUsd(config);
  if (input.costMicroUsd > budget) return { ok: false, reason: 'budget' };
  const maxRequests = requestLimit(config, input.feature);
  const maxTokens = config.ai.limits.userDailyTokens;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`centrate:ai:${input.userId}`}))`);
    const rows = await tx
      .select({
        feature: aiUsage.feature,
        requests: aiUsage.requests,
        used: usedTokens,
        reserved: aiUsage.reservedTokens,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, input.userId), eq(aiUsage.day, day)));
    const requests = rows.find((r) => r.feature === input.feature)?.requests ?? 0;
    const tokensTaken = rows.reduce((sum, r) => sum + Number(r.used) + Number(r.reserved), 0);
    if (requests >= maxRequests || tokensTaken + input.tokens > maxTokens) {
      return { ok: false, reason: 'quota', resetsAt: nextUtcMidnight(input.now) } as const;
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
      })
      .onConflictDoUpdate({
        target: [aiUsage.userId, aiUsage.day, aiUsage.feature],
        set: {
          requests: sql`${aiUsage.requests} + 1`,
          reservedTokens: sql`${aiUsage.reservedTokens} + ${input.tokens}`,
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
      },
    } as const;
  });
}

/** Replaces the reservation with what the call really used (all attempts). */
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

/** No answer came back: give the tokens and the cost back, keep the request counted. */
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

/** What is left today for GET /v1/coach/quota. */
export async function quotaLeft(
  db: Db,
  config: Config,
  userId: string,
  now: Date,
): Promise<QuotaLeft> {
  const rows = await db
    .select({
      feature: aiUsage.feature,
      requests: aiUsage.requests,
      used: usedTokens,
      reserved: aiUsage.reservedTokens,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, utcDay(now))));
  const requests = (feature: CoachFeature): number =>
    rows.find((r) => r.feature === feature)?.requests ?? 0;
  const tokens = rows.reduce((sum, r) => sum + Number(r.used) + Number(r.reserved), 0);
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
