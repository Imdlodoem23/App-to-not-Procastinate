/**
 * Prices, the global daily AI budget and the database kill switch (owner: COACH). Health reads
 * `readAiRuntime` to report `coach: budget` or `coach: kill_switch`. docs/API.md §10.2.
 */
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily, meta } from '../db/schema';
import type { CoachModelAttempt } from './model';

/** The UTC day AI quotas and the budget count against. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Next 00:00 UTC: when the daily quotas and the budget start over. */
export function nextUtcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
}

/**
 * Micro-US dollars per token (= US dollars per million tokens), claude-api skill 2026-09.
 * Cache writes cost 1.25× input (5-minute TTL), cache reads 0.1× input.
 */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> =
  Object.freeze({
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-fable-5-1': { input: 10, output: 50 },
  });

/** An id we do not know (a new fallback model, a typo in AI_MODEL_*) is billed at the
 * most expensive rate we list: overestimating keeps the budget honest. */
const UNKNOWN_PRICE = Object.values(MODEL_PRICES).reduce((a, b) =>
  a.input + a.output >= b.input + b.output ? a : b,
);

export function priceOf(model: string): { input: number; output: number } {
  return MODEL_PRICES[model] ?? UNKNOWN_PRICE;
}

/** What the attempts cost, in micro-USD, rounded up. */
export function costMicroUsd(attempts: readonly CoachModelAttempt[]): number {
  let total = 0;
  for (const a of attempts) {
    const p = priceOf(a.model);
    total +=
      a.inputTokens * p.input +
      a.cacheWriteTokens * p.input * 1.25 +
      a.cacheReadTokens * p.input * 0.1 +
      a.outputTokens * p.output;
  }
  return Math.ceil(total);
}

/** Upper bound of one call: every input token written to the cache, every output token used. */
export function worstCaseCostMicroUsd(
  model: string,
  inputTokens: number,
  maxTokens: number,
): number {
  const p = priceOf(model);
  return Math.ceil(inputTokens * p.input * 1.25 + maxTokens * p.output);
}

export const budgetMicroUsd = (config: Config): number =>
  Math.round(config.ai.limits.globalDailyBudgetUsd * 1_000_000);

/** True when today's spent plus reserved cost reaches `AI_GLOBAL_DAILY_BUDGET_USD`. */
export async function isGlobalBudgetExhausted(db: Db, config: Config, now: Date): Promise<boolean> {
  const budget = budgetMicroUsd(config);
  if (budget <= 0) return true;
  const rows = await db
    .select({ cost: aiGlobalDaily.costMicroUsd, reserved: aiGlobalDaily.reservedMicroUsd })
    .from(aiGlobalDaily)
    .where(eq(aiGlobalDaily.day, utcDay(now)))
    .limit(1);
  const row = rows[0];
  return row ? row.cost + row.reserved >= budget : false;
}

/**
 * Runtime kill switch in Postgres: `meta` row `ai_kill_switch` = `on` turns the coach off at
 * once, without a redeploy (`AI_ENABLED=false` does the same through the environment):
 *
 *   INSERT INTO meta (key, value) VALUES ('ai_kill_switch', 'on')
 *     ON CONFLICT (key) DO UPDATE SET value = excluded.value;
 *
 * Delete the row (or set any other value) to turn it back on.
 */
export const AI_KILL_SWITCH_KEY = 'ai_kill_switch';

export async function isAiKillSwitchOn(db: Db): Promise<boolean> {
  const rows = await db
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, AI_KILL_SWITCH_KEY))
    .limit(1);
  return rows[0]?.value === 'on';
}

/** What health needs to report the coach capability. */
export async function readAiRuntime(
  db: Db,
  config: Config,
  now: Date,
): Promise<{ aiKillSwitch: boolean; aiBudgetExhausted: boolean }> {
  const [aiKillSwitch, aiBudgetExhausted] = await Promise.all([
    isAiKillSwitchOn(db),
    isGlobalBudgetExhausted(db, config, now),
  ]);
  return { aiKillSwitch, aiBudgetExhausted };
}
