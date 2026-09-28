/**
 * The narrow seam between the coach routes and the Anthropic SDK (owner: COACH). Tests inject
 * a fake; production wraps `@anthropic-ai/sdk` (src/coach/anthropic.ts). COACH may reshape
 * this interface; app.ts only passes it through.
 */
import type { z } from 'zod';

export type CoachFeature = 'interpret' | 'coach';

export interface CoachModelRequest<T> {
  feature: CoachFeature;
  model: string;
  /** Frozen Spanish system prompt (cached with `cache_control`). */
  system: string;
  /** Everything that varies, with the user's text wrapped in tags as data. */
  user: string;
  maxTokens: number;
  /** Effort for models that take it; null for the interpret model. */
  effort: 'low' | 'medium' | 'high' | null;
  schema: z.ZodType<T>;
  /** HMAC of the user id for `metadata.user_id`; never the id or email. */
  userHash: string;
}

export interface CoachModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type CoachModelResult<T> =
  | { kind: 'ok'; output: T; model: string; usage: CoachModelUsage }
  | { kind: 'refused'; model: string; usage: CoachModelUsage }
  | { kind: 'incomplete'; model: string; usage: CoachModelUsage };

export interface CoachModel {
  run<T>(request: CoachModelRequest<T>): Promise<CoachModelResult<T>>;
}
