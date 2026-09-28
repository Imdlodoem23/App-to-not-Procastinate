/**
 * One coach call from a route (owner: COACH): gates, quota reservation, the model call, cost
 * accounting and error mapping. docs/API.md §10.
 *
 * Logs one line per call with token counts, cost and outcome; never the prompt, the answer,
 * the user id or the provider's error message.
 */
import { isValidTimeZone } from '@centrate/shared/cloud-api';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { AppContext, AuthedUser } from '../context';
import { ApiError, featureDisabled, quotaExceeded } from '../lib/errors';
import { requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireConsent } from '../lib/profile';
import type { ProfileRow } from '../lib/profile';
import { costMicroUsd, isAiKillSwitchOn, worstCaseCostMicroUsd } from './budget';
import type { CoachEffort, CoachFeature, CoachModel, CoachModelAttempt } from './model';
import { CoachModelError } from './model';
import { anthropicUserHash, release, reserve, settle } from './quota';
import type { z } from 'zod';

export type CoachEndpoint = 'interpret' | 'split-task' | 'study-plan' | 'weekly-summary';

interface EndpointSettings {
  feature: CoachFeature;
  maxTokens: number;
  effort: CoachEffort | null;
  /** Hard limit for the model call, retries included (the app waits up to 90 s). */
  deadlineMs: number;
}

/** docs/API.md §10 table. Opus 5 thinks by default: `max_tokens` covers thinking + answer. */
export const ENDPOINTS: Readonly<Record<CoachEndpoint, EndpointSettings>> = Object.freeze({
  interpret: { feature: 'interpret', maxTokens: 1024, effort: null, deadlineMs: 20_000 },
  'split-task': { feature: 'coach', maxTokens: 8000, effort: 'low', deadlineMs: 60_000 },
  'study-plan': { feature: 'coach', maxTokens: 16_000, effort: 'medium', deadlineMs: 80_000 },
  'weekly-summary': { feature: 'coach', maxTokens: 4000, effort: 'low', deadlineMs: 45_000 },
});

/**
 * Upper bound of input tokens: about 3 characters per token for Spanish text and JSON, plus
 * the structured-output schema and message framing.
 */
export function estimateInputTokens(system: string, user: string): number {
  return Math.ceil((system.length + user.length) / 3) + 1500;
}

export interface CoachGate {
  me: AuthedUser;
  model: CoachModel;
  profile: ProfileRow;
}

/**
 * Everything that must hold before a coach call, in this order: the capability (key,
 * `AI_ENABLED`, budget > 0), a session, a model, the caller's `sharing.coach` switch and the
 * database kill switch. The profile's zone is replaced by UTC if it is somehow not valid.
 */
export async function coachGate(ctx: AppContext, request: FastifyRequest): Promise<CoachGate> {
  requireFeature(ctx, 'coach');
  const me = requireUser(request);
  const db = requireDb(ctx);
  const model = ctx.coachModel;
  if (!model) throw featureDisabled('coach', 'missing_key');
  const row = await getProfile(db, me.userId);
  requireConsent(row, 'coach');
  if (await isAiKillSwitchOn(db)) throw featureDisabled('coach', 'kill_switch');
  const profile = isValidTimeZone(row.timeZone) ? row : { ...row, timeZone: 'UTC' };
  return { me, model, profile };
}

export interface CoachCall<T> {
  endpoint: CoachEndpoint;
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

/** Reserves quota, calls the model, settles the real cost and returns the parsed output. */
export async function callCoach<T>(
  ctx: AppContext,
  log: FastifyBaseLogger,
  me: AuthedUser,
  model: CoachModel,
  call: CoachCall<T>,
): Promise<T> {
  const db = requireDb(ctx);
  const settings = ENDPOINTS[call.endpoint];
  const modelId =
    settings.feature === 'interpret' ? ctx.config.ai.models.interpret : ctx.config.ai.models.coach;
  const secret = ctx.config.auth?.secret;
  if (!secret) throw featureDisabled('accounts', 'missing_key');

  const inputTokens = estimateInputTokens(call.system, call.user);
  const reserved = await reserve(db, ctx.config, {
    userId: me.userId,
    feature: settings.feature,
    now: ctx.now(),
    tokens: inputTokens + settings.maxTokens,
    costMicroUsd: worstCaseCostMicroUsd(modelId, inputTokens, settings.maxTokens),
  });
  if (!reserved.ok) {
    if (reserved.reason === 'quota') throw quotaExceeded(reserved.resetsAt);
    throw featureDisabled('coach', 'budget');
  }
  const { reservation } = reserved;

  const started = performance.now();
  const logCall = (outcome: string, model: string | null, attempts: CoachModelAttempt[]) => {
    const sum = (pick: (a: CoachModelAttempt) => number) =>
      attempts.reduce((total, a) => total + pick(a), 0);
    log.info(
      {
        coach: call.endpoint,
        model,
        outcome,
        attempts: attempts.length,
        inputTokens: sum((a) => a.inputTokens),
        outputTokens: sum((a) => a.outputTokens),
        cacheReadTokens: sum((a) => a.cacheReadTokens),
        cacheWriteTokens: sum((a) => a.cacheWriteTokens),
        costMicroUsd: costMicroUsd(attempts),
        ms: Math.round(performance.now() - started),
      },
      'coach call',
    );
  };

  let result;
  try {
    result = await model.run({
      feature: settings.feature,
      model: modelId,
      system: call.system,
      user: call.user,
      maxTokens: settings.maxTokens,
      effort: settings.effort,
      schema: call.schema,
      userHash: anthropicUserHash(secret, me.userId),
      deadlineMs: settings.deadlineMs,
    });
  } catch (err) {
    await release(db, reservation);
    throw failure(err, log, logCall);
  }

  const cost = costMicroUsd(result.attempts);
  await settle(db, reservation, result.attempts, cost);
  const served = result.attempts[result.attempts.length - 1]?.model ?? modelId;
  logCall(result.kind, served, result.attempts);

  if (result.kind === 'refused') {
    throw new ApiError(422, 'coach_refused', 'The model declined this request');
  }
  if (result.kind === 'incomplete') {
    throw new ApiError(502, 'coach_incomplete', 'The model did not return a complete answer');
  }
  return result.output;
}

/** 502 when the model answered but the answer did not survive the server's checks. */
export const incompleteAnswer = (): never => {
  throw new ApiError(502, 'coach_incomplete', 'The model did not return a usable answer');
};

function failure(
  err: unknown,
  log: FastifyBaseLogger,
  logCall: (outcome: string, model: string | null, attempts: CoachModelAttempt[]) => void,
): Error {
  if (!(err instanceof CoachModelError)) return err instanceof Error ? err : new Error('Coach');
  logCall(`failed_${err.reason}`, null, []);
  if (err.reason === 'misconfigured') {
    // A wrong or revoked key: the owner must fix the environment. Class and status only.
    log.error({ errorType: err.errorType, status: err.status }, 'coach model misconfigured');
    return new ApiError(503, 'coach_unavailable', 'The coach is not available right now');
  }
  if (err.reason === 'rejected') {
    log.error({ errorType: err.errorType, status: err.status }, 'coach request rejected');
    return new ApiError(500, 'internal_error', 'Something went wrong');
  }
  log.warn({ errorType: err.errorType, status: err.status }, 'coach model unavailable');
  return new ApiError(503, 'coach_unavailable', 'The coach is not available right now');
}
