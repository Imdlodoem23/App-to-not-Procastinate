/**
 * Small helpers every route uses: who is calling, is the feature on, parse the input with zod.
 */
import type { CloudFeature } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { deriveCapabilities } from '../config';
import type { AppContext, AuthedUser } from '../context';
import type { Db } from '../db/client';
import { ApiError, featureDisabled, fromZodError, reauthRequired, unauthorized } from './errors';

/** The signed-in caller, or 401. */
export function requireUser(request: FastifyRequest): AuthedUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

/** The database, or 503 feature_disabled (accounts, missing_key). */
export function requireDb(ctx: AppContext): Db {
  if (!ctx.db) throw featureDisabled('accounts', 'missing_key');
  return ctx.db;
}

/**
 * 503 feature_disabled when configuration switches `feature` off (missing key, kill switch).
 * Runtime conditions are checked where they happen: a dead database surfaces as
 * `database_unavailable`, the AI budget inside the coach quota.
 */
export function requireFeature(ctx: AppContext, feature: CloudFeature): void {
  const cap = deriveCapabilities(ctx.config)[feature];
  if (!cap.enabled) throw featureDisabled(feature, cap.reason ?? 'missing_key');
}

/** 403 reauth_required unless the session is younger than `freshSessionMinutes`. */
export function requireFreshSession(user: AuthedUser, now: Date): void {
  const ageMs = now.getTime() - user.sessionCreatedAt.getTime();
  if (ageMs > CLOUD_LIMITS.freshSessionMinutes * 60_000) throw reauthRequired();
}

function parseWith<T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: 'body' | 'query' | 'params',
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw fromZodError(result.error, where);
  return result.data;
}

/** Validates `request.body` (use `.strict()` object schemas). */
export const parseBody = <T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> =>
  parseWith(schema, request.body ?? {}, 'body');

export const parseQuery = <T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> =>
  parseWith(schema, request.query ?? {}, 'query');

export const parseParams = <T extends z.ZodType>(schema: T, request: FastifyRequest): z.output<T> =>
  parseWith(schema, request.params ?? {}, 'params');

export { ApiError };
