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
import type { Db } from '../db/client';
import { ApiError, featureDisabled, quotaExceeded } from '../lib/errors';
import { requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireConsent } from '../lib/profile';
import type { ProfileRow } from '../lib/profile';
import { BREAKER_OPEN_MS, breakerOf, isCoachBreakerOpen } from './breaker';
import { costMicroUsd, isAiKillSwitchOn } from './budget';
import type { CoachEndpoint } from './endpoints';
import { ENDPOINTS, estimateInputTokens, modelFor, worstCaseOf } from './endpoints';
import type { CoachModel, CoachModelAttempt } from './model';
import { CoachModelError } from './model';
import { anthropicUserHash, release, reserve, settle } from './quota';
import type { z } from 'zod';

export { ENDPOINTS, estimateInputTokens } from './endpoints';
export type { CoachEndpoint } from './endpoints';

/** How long past its deadline a reservation may take to settle before it stops blocking. */
export const SETTLE_MARGIN_MS = 30_000;

export interface CoachGate {
  me: AuthedUser;
  model: CoachModel;
  profile: ProfileRow;
}

/**
 * The coach's runtime switches, which /health also reports as `coach: kill_switch`: the
 * database kill switch (`meta.ai_kill_switch`) and the breaker (src/coach/breaker.ts). 503
 * `feature_disabled` when either is on.
 */
export async function requireCoachRunning(ctx: AppContext, db: Db): Promise<void> {
  if (isCoachBreakerOpen(ctx.coachModel, ctx.now())) throw featureDisabled('coach', 'kill_switch');
  if (await isAiKillSwitchOn(db)) throw featureDisabled('coach', 'kill_switch');
}

/**
 * Everything that must hold before a coach call, in this order: the capability (key,
 * `AI_ENABLED`, budget > 0), a session, a model, the caller's `sharing.coach` switch, the
 * breaker and the database kill switch. The profile's zone is replaced by UTC if it is somehow
 * not valid.
 */
export async function coachGate(ctx: AppContext, request: FastifyRequest): Promise<CoachGate> {
  requireFeature(ctx, 'coach');
  const me = requireUser(request);
  const db = requireDb(ctx);
  const model = ctx.coachModel;
  if (!model) throw featureDisabled('coach', 'missing_key');
  const row = await getProfile(db, me.userId);
  requireConsent(row, 'coach');
  await requireCoachRunning(ctx, db);
  const profile = isValidTimeZone(row.timeZone) ? row : { ...row, timeZone: 'UTC' };
  return { me, model, profile };
}

export interface CoachCall<T> {
  endpoint: CoachEndpoint;
  /** The user message; the system prompt is the endpoint's (`ENDPOINTS`). */
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
  const modelId = modelFor(ctx.config, call.endpoint);
  const secret = ctx.config.auth?.secret;
  if (!secret) throw featureDisabled('accounts', 'missing_key');

  const inputTokens = estimateInputTokens(settings.system, call.user);
  const worst = worstCaseOf(ctx.config, call.endpoint, inputTokens);
  const reserved = await reserve(db, ctx.config, {
    userId: me.userId,
    feature: settings.feature,
    now: ctx.now(),
    tokens: worst.tokens,
    costMicroUsd: worst.costMicroUsd,
    capTokens: worst.capTokens,
    capMicroUsd: worst.capMicroUsd,
    holdMs: settings.deadlineMs + SETTLE_MARGIN_MS,
  });
  if (!reserved.ok) {
    if (reserved.reason === 'quota') throw quotaExceeded(reserved.resetsAt);
    if (reserved.reason === 'busy') {
      throw new ApiError(429, 'rate_limited', 'Another coach request is still running', {
        retryAfterSeconds: Math.ceil(reserved.retryAfterMs / 1000),
      });
    }
    if (reserved.reason === 'crowded') {
      throw new ApiError(429, 'rate_limited', 'The coach is busy with other requests', {
        retryAfterSeconds: Math.ceil(reserved.retryAfterMs / 1000),
      });
    }
    throw featureDisabled('coach', 'budget');
  }
  const { reservation } = reserved;

  const started = performance.now();
  const logCall = (
    outcome: string,
    model: string | null,
    attempts: readonly CoachModelAttempt[],
    billing: string,
  ) => {
    const sum = (pick: (a: CoachModelAttempt) => number) =>
      attempts.reduce((total, a) => total + pick(a), 0);
    log.info(
      {
        coach: call.endpoint,
        model,
        outcome,
        billing,
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
      system: settings.system,
      user: call.user,
      maxTokens: settings.maxTokens,
      effort: settings.effort,
      schema: call.schema,
      userHash: anthropicUserHash(secret, me.userId),
      deadlineMs: settings.deadlineMs,
      inputTokensBound: inputTokens,
      fallbacks: ctx.config.ai.refusalFallbacks,
    });
  } catch (err) {
    // Book what the call may have cost: nothing, and the request back, only when the provider
    // certainly did not run it; the worst case when we cannot tell (an unexpected error
    // included).
    const billed =
      err instanceof CoachModelError
        ? { billing: err.billing, attempts: err.attempts }
        : { billing: 'bound' as const, attempts: worst.attempts };
    if (billed.billing === 'none') await release(db, reservation);
    else await settle(db, reservation, billed.attempts, costMicroUsd(billed.attempts));
    if (err instanceof CoachModelError && breakerOf(model).failed(err, me.userId, ctx.now())) {
      log.error(
        { errorType: err.errorType, status: err.status, minutes: BREAKER_OPEN_MS / 60_000 },
        'coach breaker open',
      );
    }
    throw failure(err, log, (outcome) => logCall(outcome, null, billed.attempts, billed.billing));
  }

  breakerOf(model).succeeded();
  await settle(db, reservation, result.attempts, costMicroUsd(result.attempts));
  const served = result.attempts[result.attempts.length - 1]?.model ?? modelId;
  logCall(result.kind, served, result.attempts, 'exact');

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

function failure(err: unknown, log: FastifyBaseLogger, logCall: (outcome: string) => void): Error {
  if (!(err instanceof CoachModelError)) {
    logCall('failed_unexpected');
    return err instanceof Error ? err : new Error('Coach');
  }
  logCall(`failed_${err.reason}`);
  if (err.reason === 'misconfigured') {
    // The owner's account or settings (key, credit, model id): only they can fix it. Class and
    // status only.
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
