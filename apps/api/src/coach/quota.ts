/**
 * Per-user daily AI quotas, the per-user spend cap and the global daily budget, kept in Postgres
 * so they survive the free service's restarts (owner: COACH). docs/API.md §10.2.
 *
 * Reserve, call, settle: before calling the model one transaction reserves a request, the
 * worst-case tokens and the worst-case cost for the user, and the worst-case cost globally.
 * After the call the reservation is replaced by what the call may have billed: the real usage,
 * or an upper bound when the usage never arrived; the request stays counted. When the provider
 * certainly did not run the call (see `CoachBilling`), `release` gives everything back, the
 * request included: an outage or an account problem at Anthropic is not the user's use of the
 * day (the route's rate limit and the one-call-in-flight rule still stop hammering).
 *
 * The global budget holds every call's whole worst case, so the day's spend never passes it.
 * Only settled spend ends the day: a call that would fit once the calls in flight settle gets
 * 429 `rate_limited` (retryable), and 503 `budget` means the day's settled spend leaves no room
 * for this call until 00:00 UTC.
 *
 * The user's caps need room for the call's first hop only; the speculative fallback hop is held
 * (on the user's row and in the global budget) but not checked against the user's caps, since
 * settle books what it really cost. So one day's use never blocks a study plan by its fallback.
 *
 * The limits also hold per mailbox (`ai_identity_daily`, keyed by an HMAC of the normalised
 * address, no foreign key): deleting the account and signing up again with the same address,
 * or a second account on `ana+1@…`, does not reset the day. Each limit is checked against the
 * larger of the account's and the mailbox's use.
 *
 * One call in flight per user and feature: a second one answers 429 `rate_limited` until the
 * first settles, so one account cannot hold many worst-case reservations at once.
 *
 * Only counters are stored: no prompt, answer, model id or request id.
 */
import type { CoachAvailability } from '@centrate/shared/cloud-api';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { normalizeMailbox } from '../auth/email-limits';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily, aiIdentityDaily, aiUsage, user } from '../db/schema';
import { unauthorized } from '../lib/errors';
import {
  budgetMicroUsd,
  globalSpentMicroUsd,
  nextUtcMidnight,
  userBudgetMicroUsd,
  utcDay,
} from './budget';
import type { CoachEndpoint } from './endpoints';
import { ENDPOINTS, largestWorstCase, neverFits } from './endpoints';
import type { CoachFeature, CoachModelAttempt } from './model';

export interface Reservation {
  userId: string;
  /** The mailbox key the call also counts against (`aiIdentityHmac`). */
  identity: string;
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
  /**
   * The global budget has room for this call once other users' calls in flight settle
   * (429 `rate_limited`).
   */
  | { ok: false; reason: 'crowded'; retryAfterMs: number }
  /**
   * Today's settled spend leaves no room for this call until 00:00 UTC, or the call can never
   * fit (503 `budget`).
   */
  | { ok: false; reason: 'budget' };

export interface ReserveInput {
  userId: string;
  feature: CoachFeature;
  now: Date;
  /**
   * Worst case of the whole call, fallback hop included (`worstCaseOf`): held on the user's row
   * and in the global budget until the call settles.
   */
  tokens: number;
  costMicroUsd: number;
  /**
   * Worst case of the first hop alone: what the user's daily token and spend caps must have
   * room for. Defaults to the whole worst case.
   */
  capTokens?: number;
  capMicroUsd?: number;
  /**
   * How long the call may hold the reservation: its deadline plus a margin to settle. Past
   * it, a reservation that never settled (the process died) no longer blocks the user.
   */
  holdMs: number;
}

/**
 * The key of a mailbox's AI use (`ai_identity_daily.identity_hmac`): HMAC-SHA256 with
 * `BETTER_AUTH_SECRET` of `ai:` + the normalised address (`normalizeMailbox`: lower case, no
 * `+tag`, Gmail dots removed), base64url. Never the address itself.
 */
export function aiIdentityHmac(secret: string, email: string): string {
  return createHmac('sha256', secret)
    .update(`ai:${normalizeMailbox(email)}`)
    .digest('base64url');
}

const requestLimit = (config: Config, feature: CoachFeature): number =>
  feature === 'interpret'
    ? config.ai.limits.userDailyInterpretRequests
    : config.ai.limits.userDailyCoachRequests;

const usedTokens = sql<number>`(${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens})`;

type Reader = Pick<Db, 'select'>;

interface UsageRow {
  feature: CoachFeature;
  requests: number;
  usedTokens: number;
  reservedTokens: number;
  costMicroUsd: number;
  reservedMicroUsd: number;
  reservedUntil: Date | null;
}

async function usageRows(db: Reader, userId: string, day: string): Promise<UsageRow[]> {
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

interface IdentityRow {
  feature: CoachFeature;
  requests: number;
  tokens: number;
  costMicroUsd: number;
}

async function identityRows(db: Reader, identity: string, day: string): Promise<IdentityRow[]> {
  const rows = await db
    .select({
      feature: aiIdentityDaily.feature,
      requests: aiIdentityDaily.requests,
      tokens: aiIdentityDaily.tokens,
      costMicroUsd: aiIdentityDaily.costMicroUsd,
    })
    .from(aiIdentityDaily)
    .where(and(eq(aiIdentityDaily.day, day), eq(aiIdentityDaily.identityHmac, identity)));
  return rows.map((r) => ({
    ...r,
    tokens: Number(r.tokens),
    costMicroUsd: Number(r.costMicroUsd),
  }));
}

async function emailOf(db: Reader, userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Today's use of the account and of its mailbox, as reserve and the quota read them. */
interface DayUse {
  rows: UsageRow[];
  /** Requests of `feature`: the larger of the account's and the mailbox's. */
  requests(feature: CoachFeature): number;
  /** Settled tokens and cost: the larger of the account's and the mailbox's. */
  settledTokens: number;
  settledMicroUsd: number;
}

function dayUse(rows: UsageRow[], ids: IdentityRow[]): DayUse {
  const sum = <R>(list: readonly R[], pick: (r: R) => number): number =>
    list.reduce((total, r) => total + pick(r), 0);
  return {
    rows,
    requests: (feature) =>
      Math.max(
        rows.find((r) => r.feature === feature)?.requests ?? 0,
        ids.find((r) => r.feature === feature)?.requests ?? 0,
      ),
    settledTokens: Math.max(
      sum(rows, (r) => r.usedTokens),
      sum(ids, (r) => r.tokens),
    ),
    settledMicroUsd: Math.max(
      sum(rows, (r) => r.costMicroUsd),
      sum(ids, (r) => r.costMicroUsd),
    ),
  };
}

const inFlight = (row: UsageRow, now: Date): boolean =>
  row.reservedUntil !== null && row.reservedUntil.getTime() > now.getTime();

/**
 * Whether a call needing `cap` fits next to what the user already spent and what `held`
 * still holds.
 */
function fitsCaps(
  config: Config,
  use: DayUse,
  held: readonly UsageRow[],
  cap: { tokens: number; microUsd: number },
): boolean {
  const heldTokens = held.reduce((total, r) => total + r.reservedTokens, 0);
  const heldMicroUsd = held.reduce((total, r) => total + r.reservedMicroUsd, 0);
  return (
    use.settledTokens + heldTokens + cap.tokens <= config.ai.limits.userDailyTokens &&
    use.settledMicroUsd + heldMicroUsd + cap.microUsd <= userBudgetMicroUsd(config)
  );
}

const lock = (key: string) => sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

/** Longest wait a `crowded` answer asks for: most calls settle well before their hold ends. */
export const CROWDED_MAX_WAIT_MS = 30_000;

/**
 * How long a `crowded` call should wait: until the first hold of `day` still in flight ends,
 * at most `CROWDED_MAX_WAIT_MS` (and that when only holds of calls whose process died are in
 * the way; the janitor books those within the hour).
 */
async function crowdedWaitMs(db: Reader, day: string, now: Date): Promise<number> {
  const rows = await db
    .select({ until: aiUsage.reservedUntil })
    .from(aiUsage)
    .where(and(eq(aiUsage.day, day), gt(aiUsage.reservedUntil, now)))
    .orderBy(asc(aiUsage.reservedUntil))
    .limit(1);
  const until = rows[0]?.until;
  if (!until) return CROWDED_MAX_WAIT_MS;
  return Math.min(CROWDED_MAX_WAIT_MS, Math.max(1000, until.getTime() - now.getTime()));
}

/**
 * Takes one request, the worst-case tokens and the worst-case cost from the user's daily
 * limits and the worst-case cost from today's global budget, atomically. Advisory locks on the
 * user and on the mailbox serialize the calls of one account and of every account on the same
 * mailbox (the limits span both features, so one row lock is not enough). Checks, in order:
 *
 * 1. A call of this feature still in flight → `busy` (one call at a time per user and feature).
 * 2. Requests, then tokens and spend (settled + held + this call's first hop ≤ limit), each
 *    against the larger of the account's and the mailbox's use → `quota`, unless the call
 *    would fit once the user's other call in flight settles → `busy`.
 * 3. The global budget: spent + held + this whole call ≤ budget. If only amounts held by calls
 *    in flight are in the way (spent + this whole call ≤ budget) → `crowded`, else → `budget`.
 */
export async function reserve(db: Db, config: Config, input: ReserveInput): Promise<ReserveResult> {
  const { now } = input;
  const day = utcDay(now);
  const budget = budgetMicroUsd(config);
  const cap = {
    tokens: input.capTokens ?? input.tokens,
    microUsd: input.capMicroUsd ?? input.costMicroUsd,
  };
  const secret = config.auth?.secret;
  // A call that could never fit is a configuration problem, not a used-up quota (and without
  // accounts there is no coach).
  if (!secret || input.costMicroUsd > budget || cap.microUsd > userBudgetMicroUsd(config)) {
    return { ok: false, reason: 'budget' };
  }
  const maxRequests = requestLimit(config, input.feature);
  const until = new Date(now.getTime() + input.holdMs);

  return db.transaction(async (tx) => {
    // Always the user first, then the mailbox: no two reservations wait on each other.
    await tx.execute(lock(`centrate:ai:${input.userId}`));
    const email = await emailOf(tx, input.userId);
    // The account was deleted while this request was on its way.
    if (email === null) throw unauthorized();
    const identity = aiIdentityHmac(secret, email);
    await tx.execute(lock(`centrate:ai:mailbox:${identity}`));
    const use = dayUse(
      await usageRows(tx, input.userId, day),
      await identityRows(tx, identity, day),
    );
    const { rows } = use;
    const own = rows.find((r) => r.feature === input.feature);
    const retryAfter = (row: UsageRow): number =>
      Math.max(1000, (row.reservedUntil?.getTime() ?? 0) - now.getTime());

    if (own && inFlight(own, now)) {
      return { ok: false, reason: 'busy', retryAfterMs: retryAfter(own) } as const;
    }
    if (use.requests(input.feature) >= maxRequests) {
      return { ok: false, reason: 'quota', resetsAt: nextUtcMidnight(now) } as const;
    }
    if (!fitsCaps(config, use, rows, cap)) {
      // What is held by the user's other call in flight comes back when it settles; what is
      // held by a call whose process died stays taken until the janitor frees it, about an hour
      // after its `reserved_until` at most (jobs/janitor.ts).
      const others = rows.filter((r) => inFlight(r, now));
      const settledOrDead = rows.filter((r) => !inFlight(r, now));
      if (others.length > 0 && fitsCaps(config, use, settledOrDead, cap)) {
        const wait = Math.max(...others.map(retryAfter));
        return { ok: false, reason: 'busy', retryAfterMs: wait } as const;
      }
      return { ok: false, reason: 'quota', resetsAt: nextUtcMidnight(now) } as const;
    }

    // Rows in the order settle and the janitor lock them: the day's budget, the user, the
    // mailbox.
    // Global budget: the conditional upsert only succeeds while spent + held + this ≤ budget
    // (and locks the day's row either way).
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
    if (!global[0]) {
      // Held amounts come back within the calls' deadlines; only settled spend is the day's.
      if ((await globalSpentMicroUsd(tx, day)) + input.costMicroUsd > budget) {
        return { ok: false, reason: 'budget' } as const;
      }
      return {
        ok: false,
        reason: 'crowded',
        retryAfterMs: await crowdedWaitMs(tx, day, now),
      } as const;
    }

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
    await tx
      .insert(aiIdentityDaily)
      .values({ day, identityHmac: identity, feature: input.feature, requests: 1 })
      .onConflictDoUpdate({
        target: [aiIdentityDaily.day, aiIdentityDaily.identityHmac, aiIdentityDaily.feature],
        set: { requests: sql`${aiIdentityDaily.requests} + 1` },
      });
    return {
      ok: true,
      reservation: {
        userId: input.userId,
        identity,
        feature: input.feature,
        day,
        tokens: input.tokens,
        costMicroUsd: input.costMicroUsd,
        until,
      },
    } as const;
  });
}

export interface SettleOptions {
  /** Take the request back too (the provider certainly did not run the call). */
  giveBackRequest?: boolean;
}

/**
 * Replaces the reservation with what the call billed (or may have billed): every attempt's
 * tokens and `costMicroUsd`, on the user's row, the mailbox's row and the global budget. Frees
 * the user's row for the next call only if the row still holds this reservation (a late settle
 * after a newer call started must not free that one).
 */
export async function settle(
  db: Db,
  reservation: Reservation,
  attempts: readonly CoachModelAttempt[],
  costMicroUsd: number,
  options: SettleOptions = {},
): Promise<void> {
  const sum = (pick: (a: CoachModelAttempt) => number): number =>
    attempts.reduce((total, a) => total + pick(a), 0);
  const tokens = sum(
    (a) => a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens,
  );
  const back = options.giveBackRequest ? 1 : 0;
  await db.transaction(async (tx) => {
    // The order a reservation and the janitor lock these rows: budget, user, mailbox.
    await tx
      .update(aiGlobalDaily)
      .set({
        reservedMicroUsd: sql`GREATEST(${aiGlobalDaily.reservedMicroUsd} - ${reservation.costMicroUsd}, 0)`,
        costMicroUsd: sql`${aiGlobalDaily.costMicroUsd} + ${costMicroUsd}`,
        requests: sql`GREATEST(${aiGlobalDaily.requests} - ${back}, 0)`,
      })
      .where(eq(aiGlobalDaily.day, reservation.day));
    await tx
      .update(aiUsage)
      .set({
        requests: sql`GREATEST(${aiUsage.requests} - ${back}, 0)`,
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
    if (tokens > 0 || costMicroUsd > 0 || back > 0) {
      await tx
        .update(aiIdentityDaily)
        .set({
          requests: sql`GREATEST(${aiIdentityDaily.requests} - ${back}, 0)`,
          tokens: sql`${aiIdentityDaily.tokens} + ${tokens}`,
          costMicroUsd: sql`${aiIdentityDaily.costMicroUsd} + ${costMicroUsd}`,
        })
        .where(
          and(
            eq(aiIdentityDaily.day, reservation.day),
            eq(aiIdentityDaily.identityHmac, reservation.identity),
            eq(aiIdentityDaily.feature, reservation.feature),
          ),
        );
    }
  });
}

/**
 * The provider certainly did not run the call (`billing: 'none'`): give the tokens, the cost
 * and the request back. What stops hammering is the route's rate limit, the one call in flight
 * per user and bucket, and the breaker (src/coach/breaker.ts), not the day's requests.
 */
export function release(db: Db, reservation: Reservation): Promise<void> {
  return settle(db, reservation, [], 0, { giveBackRequest: true });
}

function ownRow(r: Reservation) {
  return and(eq(aiUsage.userId, r.userId), eq(aiUsage.day, r.day), eq(aiUsage.feature, r.feature));
}

export interface QuotaLeft {
  interpret: { requestsLeft: number };
  coach: { requestsLeft: number; tokensLeft: number };
  available: CoachAvailability;
  resetsAt: Date;
}

/**
 * What is left today for GET /v1/coach/quota, counting the larger of the account's and the
 * mailbox's use. `available` says, per endpoint, whether its largest request would be
 * admitted once the calls in flight settle: a request left in its bucket, room under the
 * token and spend caps for its first hop, and room in today's settled global spend for its
 * whole worst case. False means 429 `quota_exceeded` or 503 `budget` until `resetsAt` (or, when
 * the endpoint can never run with the server's settings, 503 `budget` every day).
 */
export async function quotaLeft(
  db: Db,
  config: Config,
  userId: string,
  now: Date,
): Promise<QuotaLeft> {
  const day = utcDay(now);
  const secret = config.auth?.secret;
  const email = await emailOf(db, userId);
  const use = dayUse(
    await usageRows(db, userId, day),
    secret && email !== null ? await identityRows(db, aiIdentityHmac(secret, email), day) : [],
  );
  const left = (limit: number, taken: number): number => Math.max(0, limit - taken);
  const L = config.ai.limits;
  const heldTokens = use.rows.reduce((total, r) => total + r.reservedTokens, 0);
  const settledOrDead = use.rows.filter((r) => !inFlight(r, now));
  const globalSpent = await globalSpentMicroUsd(db, day);

  const fits = (endpoint: CoachEndpoint): boolean => {
    const { feature } = ENDPOINTS[endpoint];
    const worst = largestWorstCase(config, endpoint);
    return (
      use.requests(feature) < requestLimit(config, feature) &&
      neverFits(config, endpoint) === null &&
      fitsCaps(config, use, settledOrDead, {
        tokens: worst.capTokens,
        microUsd: worst.capMicroUsd,
      }) &&
      globalSpent + worst.costMicroUsd <= budgetMicroUsd(config)
    );
  };
  return {
    interpret: { requestsLeft: left(L.userDailyInterpretRequests, use.requests('interpret')) },
    coach: {
      requestsLeft: left(L.userDailyCoachRequests, use.requests('coach')),
      tokensLeft: left(L.userDailyTokens, use.settledTokens + heldTokens),
    },
    available: {
      interpret: fits('interpret'),
      splitTask: fits('split-task'),
      studyPlan: fits('study-plan'),
      weeklySummary: fits('weekly-summary'),
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
