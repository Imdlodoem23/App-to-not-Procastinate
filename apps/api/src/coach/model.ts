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

/** Thrown by a `CoachModel` when no answer came back. Carries no message from the provider. */
export class CoachModelError extends Error {
  readonly reason: CoachModelFailure;
  /** SDK error class name, for logs (never the provider's message). */
  readonly errorType: string;
  readonly status: number | null;

  constructor(reason: CoachModelFailure, errorType: string, status: number | null = null) {
    super(`Coach model call failed (${reason})`);
    this.name = 'CoachModelError';
    this.reason = reason;
    this.errorType = errorType;
    this.status = status;
  }
}

export interface CoachModel {
  /** Resolves with the outcome, or throws `CoachModelError`. */
  run<T>(request: CoachModelRequest<T>): Promise<CoachModelResult<T>>;
}
