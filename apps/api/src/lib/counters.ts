/**
 * Durable fixed-window counters in Postgres (`rate_counters`, owner: CORE). For limits that must
 * survive a restart (the free service restarts after every 15-minute sleep, which resets the
 * in-memory limiter) and are not tied to an account: the global daily cap on sign-in emails
 * and the per-address sign-in email limits. docs/API.md §12.
 *
 * Windows are aligned on the Unix epoch, so a one-day window is a UTC day.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { rateCounters } from '../db/schema';

export interface CounterLimit {
  key: string;
  windowMs: number;
  max: number;
}

export interface CounterResult {
  ok: boolean;
  /** When `ok` is false: milliseconds until the window ends. */
  retryAfterMs: number;
}

const windowStartOf = (nowMs: number, windowMs: number): number =>
  Math.floor(nowMs / windowMs) * windowMs;

/**
 * Takes one unit from the counter unless it has reached `max` in the current window. One
 * statement (insert or conditional increment), so concurrent callers never overshoot.
 */
export async function takeFromCounter(
  db: Db,
  limit: CounterLimit,
  now: Date,
): Promise<CounterResult> {
  const nowMs = now.getTime();
  const start = windowStartOf(nowMs, limit.windowMs);
  const end = start + limit.windowMs;
  if (limit.max <= 0) return { ok: false, retryAfterMs: end - nowMs };
  const rows = await db
    .insert(rateCounters)
    .values({ key: limit.key, windowStart: new Date(start), count: 1, expiresAt: new Date(end) })
    .onConflictDoUpdate({
      target: [rateCounters.key, rateCounters.windowStart],
      set: { count: sql`${rateCounters.count} + 1` },
      setWhere: sql`${rateCounters.count} < ${limit.max}`,
    })
    .returning({ count: rateCounters.count });
  return rows.length > 0 ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: end - nowMs };
}

/** True when the counter has reached `max` in the current window (read only). */
export async function isCounterExhausted(db: Db, limit: CounterLimit, now: Date): Promise<boolean> {
  if (limit.max <= 0) return true;
  const start = windowStartOf(now.getTime(), limit.windowMs);
  const rows = await db
    .select({ count: rateCounters.count })
    .from(rateCounters)
    .where(and(eq(rateCounters.key, limit.key), eq(rateCounters.windowStart, new Date(start))))
    .limit(1);
  return (rows[0]?.count ?? 0) >= limit.max;
}
