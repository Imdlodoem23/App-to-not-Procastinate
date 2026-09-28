/**
 * Global daily AI budget (owner: COACH). Health reads it to report `coach: budget`.
 */
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily } from '../db/schema';

/** The UTC day AI quotas and the budget count against. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** True when today's spent plus reserved cost reaches `AI_GLOBAL_DAILY_BUDGET_USD`. */
export async function isGlobalBudgetExhausted(db: Db, config: Config, now: Date): Promise<boolean> {
  const budgetMicroUsd = Math.round(config.ai.limits.globalDailyBudgetUsd * 1_000_000);
  if (budgetMicroUsd <= 0) return true;
  const rows = await db
    .select({ cost: aiGlobalDaily.costMicroUsd, reserved: aiGlobalDaily.reservedMicroUsd })
    .from(aiGlobalDaily)
    .where(eq(aiGlobalDaily.day, utcDay(now)))
    .limit(1);
  const row = rows[0];
  return row ? row.cost + row.reserved >= budgetMicroUsd : false;
}
