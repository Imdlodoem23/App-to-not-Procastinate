/**
 * The four coach endpoints: settings, input estimate and worst cases (owner: COACH).
 * docs/API.md §10 and §10.2.
 *
 * A call's worst case has two parts: the first hop (the requested model, every input token a
 * cache write, `max_tokens` of output) and, for models sent with refusal fallbacks, a
 * speculative second hop. The global budget holds both; the user's daily caps need room for
 * the first hop only (the second hop happens only after a refusal, and settle books what it
 * really cost).
 */
import type { Config } from '../config';
import {
  budgetMicroUsd,
  costMicroUsd,
  MODEL_PRICES,
  tokensOf,
  userBudgetMicroUsd,
  worstCaseAttempts,
} from './budget';
import type { CoachEffort, CoachFeature, CoachModelAttempt } from './model';
import {
  INTERPRET_SYSTEM,
  SPLIT_TASK_SYSTEM,
  STUDY_PLAN_SYSTEM,
  WEEKLY_SUMMARY_SYSTEM,
} from './prompts';

export type CoachEndpoint = 'interpret' | 'split-task' | 'study-plan' | 'weekly-summary';

export interface EndpointSettings {
  feature: CoachFeature;
  maxTokens: number;
  effort: CoachEffort | null;
  /** Hard limit for the model call, retries included (the app waits up to 90 s). */
  deadlineMs: number;
  /** The frozen system prompt (cached; never holds user data). */
  system: string;
  /**
   * Longest user message the endpoint builds from any valid request, with some margin.
   * test/coach-unit.test.ts builds the largest request of each endpoint and checks it.
   */
  maxUserChars: number;
}

/**
 * docs/API.md §10 table. Opus 5 thinks by default: `max_tokens` covers thinking + answer. The
 * limits are sized to the answers (at most 12 steps, 28 days of up to 4 items, 4 highlights)
 * with room for low-effort thinking; the deadlines leave the app's 90 s wait some slack.
 */
export const ENDPOINTS: Readonly<Record<CoachEndpoint, EndpointSettings>> = Object.freeze({
  interpret: {
    feature: 'interpret',
    maxTokens: 1024,
    effort: null,
    deadlineMs: 20_000,
    system: INTERPRET_SYSTEM,
    maxUserChars: 700,
  },
  'split-task': {
    feature: 'coach',
    maxTokens: 4000,
    effort: 'low',
    deadlineMs: 60_000,
    system: SPLIT_TASK_SYSTEM,
    maxUserChars: 1000,
  },
  'study-plan': {
    feature: 'coach',
    maxTokens: 8000,
    effort: 'low',
    deadlineMs: 80_000,
    system: STUDY_PLAN_SYSTEM,
    maxUserChars: 4200,
  },
  'weekly-summary': {
    feature: 'coach',
    maxTokens: 4000,
    effort: 'low',
    deadlineMs: 45_000,
    system: WEEKLY_SUMMARY_SYSTEM,
    maxUserChars: 2700,
  },
});

export const COACH_ENDPOINTS = Object.keys(ENDPOINTS) as CoachEndpoint[];

/** Input tokens of `chars` characters: about 3 per token, plus schema and framing. */
const inputTokensFor = (chars: number): number => Math.ceil(chars / 3) + 1500;

/**
 * Upper bound of input tokens: about 3 characters per token for Spanish text and JSON, plus
 * the structured-output schema and message framing.
 */
export function estimateInputTokens(system: string, user: string): number {
  return inputTokensFor(system.length + user.length);
}

/** The model an endpoint calls (`AI_MODEL_INTERPRET` or `AI_MODEL_COACH`). */
export function modelFor(config: Config, endpoint: CoachEndpoint): string {
  return ENDPOINTS[endpoint].feature === 'interpret'
    ? config.ai.models.interpret
    : config.ai.models.coach;
}

export interface CallWorstCase {
  /** Every hop that may bill, fallback hop included: what the reservation holds. */
  attempts: CoachModelAttempt[];
  tokens: number;
  costMicroUsd: number;
  /** The first hop alone: what the user's daily token and spend caps must have room for. */
  capTokens: number;
  capMicroUsd: number;
}

/** Worst case of one call of `endpoint` with `inputTokens` of input. */
export function worstCaseOf(
  config: Config,
  endpoint: CoachEndpoint,
  inputTokens: number,
): CallWorstCase {
  const attempts = worstCaseAttempts(
    modelFor(config, endpoint),
    inputTokens,
    ENDPOINTS[endpoint].maxTokens,
    config.ai.refusalFallbacks,
  );
  const first = attempts.slice(0, 1);
  return {
    attempts,
    tokens: tokensOf(attempts),
    costMicroUsd: costMicroUsd(attempts),
    capTokens: tokensOf(first),
    capMicroUsd: costMicroUsd(first),
  };
}

/** Worst case of the largest request `endpoint` accepts. */
export function largestWorstCase(config: Config, endpoint: CoachEndpoint): CallWorstCase {
  const e = ENDPOINTS[endpoint];
  return worstCaseOf(config, endpoint, inputTokensFor(e.system.length + e.maxUserChars));
}

const usd = (microUsd: number): string => (microUsd / 1_000_000).toFixed(3);

/**
 * Why `endpoint` can never run with this configuration (its largest request does not fit
 * even on an unused day), or null when it can. Such a call answers 503 `budget` (spend) or
 * 429 `quota_exceeded` (tokens) every time.
 */
export function neverFits(config: Config, endpoint: CoachEndpoint): string | null {
  const worst = largestWorstCase(config, endpoint);
  if (worst.costMicroUsd > budgetMicroUsd(config)) {
    return `its worst case (${usd(worst.costMicroUsd)} USD) is above AI_GLOBAL_DAILY_BUDGET_USD`;
  }
  if (worst.capMicroUsd > userBudgetMicroUsd(config)) {
    return `its first hop's worst case (${usd(worst.capMicroUsd)} USD) is above AI_USER_DAILY_BUDGET_USD`;
  }
  if (worst.capTokens > config.ai.limits.userDailyTokens) {
    return `its first hop's worst case (${worst.capTokens} tokens) is above AI_USER_DAILY_TOKENS`;
  }
  return null;
}

/**
 * Coach settings worth a warning at boot (logged with the configuration warnings): an
 * endpoint that can never run, or a model id without a price (billed at the dearest listed
 * rate, which may push an endpoint over a cap). Nothing when the coach is off or a budget of
 * 0 turns it off on purpose.
 */
export function coachConfigWarnings(config: Config): string[] {
  const { ai } = config;
  if (!ai.apiKey || !ai.enabled) return [];
  if (budgetMicroUsd(config) <= 0 || userBudgetMicroUsd(config) <= 0) return [];
  const out: string[] = [];
  for (const [name, model] of [
    ['AI_MODEL_INTERPRET', ai.models.interpret],
    ['AI_MODEL_COACH', ai.models.coach],
  ] as const) {
    if (!Object.hasOwn(MODEL_PRICES, model)) {
      out.push(`${name} «${model}» has no known price; it is billed at the dearest listed rate`);
    }
  }
  for (const endpoint of COACH_ENDPOINTS) {
    const why = neverFits(config, endpoint);
    if (why) out.push(`The coach's ${endpoint} can never run: ${why}`);
  }
  return out;
}
