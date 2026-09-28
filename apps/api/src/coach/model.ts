/**
 * The narrow seam between the coach routes and the Anthropic SDK (owner: COACH). Tests inject
 * a fake; production wraps `@anthropic-ai/sdk` (src/coach/anthropic.ts). app.ts only passes it
 * through.
 *
 * Nothing crossing this seam is ever logged or stored: the service (src/coach/service.ts) keeps
 * only the token counts of `attempts`.
 */
import type { z } from 'zod';

/** The quota bucket a call counts against (`ai_usage.feature`). */
export type CoachFeature = 'interpret' | 'coach';

export type CoachEffort = 'low' | 'medium' | 'high';

export interface CoachModelRequest<T> {
  feature: CoachFeature;
  model: string;
  /** Frozen Spanish system prompt, cached with `cache_control`. Never holds user data. */
  system: string;
  /** Everything that varies, with the user's text wrapped in `<datos_usuario>` as data. */
  user: string;
  maxTokens: number;
  /** Effort for models that take it; null leaves the model's default (and Haiku 4.5). */
  effort: CoachEffort | null;
  /**
   * Shape of the answer, enforced with structured outputs. Keep it to types and enums: the
   * service clamps lengths and ranges itself, so a long title is shortened, not a failure.
   */
  schema: z.ZodType<T>;
  /** HMAC of the user id for `metadata.user_id`; never the id or email. */
  userHash: string;
  /** Wall-clock limit for the whole call, retries included. */
  deadlineMs: number;
  /**
   * Upper bound of the input tokens (the service's estimate). Bounds the cost of a call whose
   * final usage never arrived (see `CoachBilling`).
   */
  inputTokensBound: number;
}

export interface CoachModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * One billed model attempt. With refusal fallbacks a request can run on two models (the one
 * that declined and the one that answered); each is priced at its own rate.
 */
export interface CoachModelAttempt extends CoachModelUsage {
  model: string;
}

export type CoachModelResult<T> =
  | { kind: 'ok'; output: T; attempts: CoachModelAttempt[] }
  /** `stop_reason: refusal` on the final answer (the whole fallback chain declined). */
  | { kind: 'refused'; attempts: CoachModelAttempt[] }
  /** `max_tokens`, another unexpected stop, or output that does not match the schema. */
  | { kind: 'incomplete'; attempts: CoachModelAttempt[] };

/**
 * - `unavailable`: rate limited, overloaded, 5xx, network error or deadline (503, retry later).
 * - `misconfigured`: the key is wrong or lacks permission (503, logged as an error).
 * - `rejected`: the API refused the request shape (a bug on our side: 500).
 */
export type CoachModelFailure = 'unavailable' | 'misconfigured' | 'rejected';

/**
 * What a failed call may have cost, so the budget also counts calls that never answered:
 * - `none`: certainly not billed (never sent, or refused with 400/401/403/404/409/413/422/429,
 *   or 529 before any output). `attempts` is empty and the reservation is released.
 * - `exact`: the final usage arrived before the failure; `attempts` is what was billed.
 * - `bound`: sent, but the final usage never arrived (our deadline, a timeout, a connection
 *   reset, a 5xx, an error in the middle of the stream). `attempts` is an upper bound: every
 *   model that may have run, each with its input and `maxTokens` of output.
 */
export type CoachBilling = 'none' | 'exact' | 'bound';

/** Thrown by a `CoachModel` when no answer came back. Carries no message from the provider. */
export class CoachModelError extends Error {
  readonly reason: CoachModelFailure;
  /** SDK error class name, for logs (never the provider's message). */
  readonly errorType: string;
  readonly status: number | null;
  readonly billing: CoachBilling;
  /** What to book against the quotas and the budget (see `CoachBilling`). */
  readonly attempts: readonly CoachModelAttempt[];
  /** The provider's `retry-after`, when it sent one. */
  readonly retryAfterMs: number | null;

  constructor(
    reason: CoachModelFailure,
    errorType: string,
    status: number | null = null,
    billed: { billing: CoachBilling; attempts: readonly CoachModelAttempt[] } = {
      billing: 'none',
      attempts: [],
    },
    retryAfterMs: number | null = null,
  ) {
    super(`Coach model call failed (${reason})`);
    this.name = 'CoachModelError';
    this.reason = reason;
    this.errorType = errorType;
    this.status = status;
    this.billing = billed.billing;
    this.attempts = billed.billing === 'none' ? [] : billed.attempts;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Models sent with `fallbacks: 'default'`, and the models Anthropic documents as their
 * fallbacks (claude-api skill, 2026-09: Opus 4.8 for cyber declines; routing for the other
 * categories is not published). With it a request can run on two models: the one that
 * declined and the one that answered.
 */
export const SERVER_FALLBACK_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'claude-opus-5': ['claude-opus-4-8'],
  'claude-fable-5-1': ['claude-opus-4-8', 'claude-opus-5'],
});

/**
 * The most one model hop can cost: every input token written to the cache (the dearest input
 * rate) and `outputTokens` of output.
 */
export function worstCaseAttempt(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CoachModelAttempt {
  return { model, inputTokens: 0, cacheWriteTokens: inputTokens, cacheReadTokens: 0, outputTokens };
}

export interface CoachModel {
  /** Resolves with the outcome, or throws `CoachModelError`. */
  run<T>(request: CoachModelRequest<T>): Promise<CoachModelResult<T>>;
}
