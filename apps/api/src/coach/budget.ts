/**
 * Prices, worst cases, the per-user and global daily AI budgets and the database kill switch
 * (owner: COACH). Health reads `readAiRuntime` to report `coach: budget` or
 * `coach: kill_switch`. docs/API.md §10.2.
 */
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { aiGlobalDaily, meta } from '../db/schema';
import type { CoachModelAttempt } from './model';
import { SERVER_FALLBACK_TARGETS, worstCaseAttempt } from './model';

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

/**
 * Upper bound of one call, as the attempts it could bill: the requested model with every input
 * token written to the cache and `maxTokens` of output, plus, for models sent with refusal
 * fallbacks (`fallbacks`, `AI_REFUSAL_FALLBACKS`), a second hop on the dearest of the requested
 * model and its documented fallbacks (named after the fallback on a tie). That hop may read the
 * declined partial answer as extra input (up to `maxTokens`) and write its own `maxTokens`
 * (each hop has its own output limit).
 */
export function worstCaseAttempts(
  model: string,
  inputTokens: number,
  maxTokens: number,
  fallbacks = true,
): CoachModelAttempt[] {
  const first = worstCaseAttempt(model, inputTokens, maxTokens);
  const targets = fallbacks ? SERVER_FALLBACK_TARGETS[model] : undefined;
  if (!targets || targets.length === 0) return [first];
  const dearest = [model, ...targets].reduce((a, b) =>
    priceOf(b).output >= priceOf(a).output ? b : a,
  );
  return [first, worstCaseAttempt(dearest, inputTokens + maxTokens, maxTokens)];
}

/** Tokens the attempts count against `AI_USER_DAILY_TOKENS`. */
export function tokensOf(attempts: readonly CoachModelAttempt[]): number {
  return attempts.reduce(
    (sum, a) => sum + a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens,
    0,
  );
}

export const budgetMicroUsd = (config: Config): number =>
  Math.round(config.ai.limits.globalDailyBudgetUsd * 1_000_000);

/** One user's daily spend cap (`AI_USER_DAILY_BUDGET_USD`, never above the global budget). */
export const userBudgetMicroUsd = (config: Config): number =>
  Math.round(
    Math.min(config.ai.limits.userDailyBudgetUsd, config.ai.limits.globalDailyBudgetUsd) *
      1_000_000,
  );

/**
 * What `day` has settled against the global budget (booked calls and lost reservations the
 * janitor booked), in micro-USD. Amounts held by calls in flight are not included.
 */
export async function globalSpentMicroUsd(db: Pick<Db, 'select'>, day: string): Promise<number> {
  const rows = await db
    .select({ cost: aiGlobalDaily.costMicroUsd })
    .from(aiGlobalDaily)
    .where(eq(aiGlobalDaily.day, day))
    .limit(1);
  return Number(rows[0]?.cost ?? 0);
}

/**
 * True when today's settled cost reaches `AI_GLOBAL_DAILY_BUDGET_USD`. Amounts held by calls in
 * flight are left out: they settle within the call's deadline, and a few parallel reservations
 * must not make /health report the coach as off for everyone (while they fill the budget, new
 * calls get 429 `rate_limited`, src/coach/quota.ts).
 */
export async function isGlobalBudgetExhausted(db: Db, config: Config, now: Date): Promise<boolean> {
  const budget = budgetMicroUsd(config);
  if (budget <= 0) return true;
  return (await globalSpentMicroUsd(db, utcDay(now))) >= budget;
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
