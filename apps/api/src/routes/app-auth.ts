/**
 * Desktop login, RFC 8252 loopback redirect + PKCE S256 (owner: CORE). docs/API.md §4.2.
 *
 * 1. /cuenta/conectar (pages/account.ts) asks «¿Conectar este ordenador?»; its button posts
 *    here (`authorize`) with the browser's cookie session.
 * 2. `authorize` stores a one-time code (only its SHA-256, 60 s) and redirects the browser to
 *    http://127.0.0.1:<port>/callback?code&state, where the app listens.
 * 3. The app trades the code and its PKCE verifier for a bearer session (`token`).
 */
import type { AppTokenRequest, AppTokenResponse, CloudPlatform } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, CLOUD_PLATFORMS } from '@centrate/shared/cloud-api';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createSessionRow, hasBearer } from '../auth/session';
import { appAuthCodes, devices, session } from '../db/schema';
import { ApiError, conflict, forbidden, unauthorized, validationFailed } from '../lib/errors';
import { parseBody, requireDb, requireUser } from '../lib/guards';
import { hasControlChars, loadMe } from '../lib/profile';

/** Form fields posted by the «Conectar» button on /cuenta/conectar. */
export interface AuthorizeForm {
  challenge: string;
  state: string;
  port: string;
  device?: string;
}

/** PKCE S256 challenge: base64url(sha256(verifier)), 43 characters. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** The app's anti-CSRF `state`, echoed back unchanged. */
export const STATE_RE = /^[A-Za-z0-9._~-]{16,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]+$/;

export const AuthorizeFormSchema = z
  .object({
    challenge: z.string().regex(CHALLENGE_RE, 'must be a S256 challenge'),
    state: z.string().regex(STATE_RE, 'must be 16–128 URL-safe characters'),
    port: z.coerce.number().int().min(1024).max(65_535),
    device: z.string().max(200).optional(),
  })
  .strict();

/** A device name: trimmed, 1–40 characters, no control characters. */
export const deviceName = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(CLOUD_LIMITS.deviceNameMax)
      .refine((v) => !hasControlChars(v), 'must not contain control characters'),
  );

const TokenSchema = z
  .object({
    code: z.string().regex(CODE_RE, 'must be a login code'),
    codeVerifier: z.string().regex(VERIFIER_RE, 'must be a PKCE verifier (RFC 7636)'),
    installId: z
      .string()
      .min(CLOUD_LIMITS.opaqueIdMin)
      .max(CLOUD_LIMITS.opaqueIdMax)
      .regex(OPAQUE_ID_RE),
    device: z
      .object({
        name: deviceName,
        platform: z.enum(CLOUD_PLATFORMS),
        appVersion: z
          .string()
          .min(1)
          .max(CLOUD_LIMITS.appVersionMax)
          .regex(/^[0-9A-Za-z.+-]+$/, 'must be a version like 1.4.0'),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<AppTokenRequest>;

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** base64url(sha256(verifier)) === challenge, in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** The loopback URL: only the literal 127.0.0.1, a checked port and a fixed path. */
export function loopbackCallback(port: number, code: string, state: string): string {
  const query = new URLSearchParams({ code, state }).toString();
  return `http://127.0.0.1:${port}/callback?${query}`;
}

const invalidCode = () =>
  validationFailed([{ path: 'body.code', message: 'invalid or expired code' }], 'Invalid code');

export const appAuthRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  const limit = { rateLimit: { max: 20, timeWindow: '1 hour' } };

  // Cookie session + Origin check (app.ts); 303 to http://127.0.0.1:<port>/callback?code&state.
  app.post<{ Body: AuthorizeForm }>(
    '/app-auth/authorize',
    { config: limit },
    async (request, reply) => {
      const db = requireDb(ctx);
      const form = parseBody(AuthorizeFormSchema, request);
      if (!request.user) {
        // The browser session ended between the page and the click: sign in and come back.
        const back = new URLSearchParams({
          challenge: form.challenge,
          state: form.state,
          port: String(form.port),
          ...(form.device ? { device: form.device } : {}),
        });
        const volver = `/cuenta/conectar?${back.toString()}`;
        return reply.redirect(`/cuenta?${new URLSearchParams({ volver }).toString()}`, 303);
      }
      // Only a browser session may link a computer, never another computer's bearer token.
      if (hasBearer(request.headers)) throw forbidden('Use the browser to connect a computer');
      const code = randomBytes(32).toString('base64url');
      const now = ctx.now();
      await db.insert(appAuthCodes).values({
        codeHash: sha256Hex(code),
        userId: request.user.userId,
        challenge: form.challenge,
        port: form.port,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CLOUD_LIMITS.appAuthCodeTtlSeconds * 1000),
      });
      return reply.redirect(loopbackCallback(form.port, code, form.state), 303);
    },
  );

  app.post<{ Body: AppTokenRequest; Reply: AppTokenResponse }>(
    '/app-auth/token',
    { config: limit },
    async (request) => {
      const db = requireDb(ctx);
      const body = parseBody(TokenSchema, request);
      const now = ctx.now();

      // Single use: the row is deleted and read in one statement, before anything is checked.
      const consumed = await db
        .delete(appAuthCodes)
        .where(eq(appAuthCodes.codeHash, sha256Hex(body.code)))
        .returning();
      const row = consumed[0];
      if (!row || row.expiresAt.getTime() <= now.getTime()) throw invalidCode();
      if (!pkceMatches(body.codeVerifier, row.challenge)) throw invalidCode();
      const userId = row.userId;

      const existing = await db
        .select({ id: devices.id, sessionId: devices.sessionId })
        .from(devices)
        .where(and(eq(devices.userId, userId), eq(devices.installId, body.installId)))
        .limit(1);
      const previous = existing[0];
      if (!previous) {
        const [{ n } = { n: 0 }] = await db
          .select({ n: count() })
          .from(devices)
          .where(eq(devices.userId, userId));
        if (n >= CLOUD_LIMITS.maxDevices) {
          throw conflict('limit_reached', `At most ${CLOUD_LIMITS.maxDevices} devices`);
        }
      }

      const created = await createSessionRow(db, userId, now);
      const deviceFields = {
        sessionId: created.id,
        name: body.device.name,
        platform: body.device.platform satisfies CloudPlatform,
        appVersion: body.device.appVersion,
      };
      const upserted = await db
        .insert(devices)
        .values({ userId, installId: body.installId, createdAt: now, ...deviceFields })
        .onConflictDoUpdate({ target: [devices.userId, devices.installId], set: deviceFields })
        .returning({ id: devices.id });
      const deviceId = upserted[0]?.id;
      if (!deviceId) throw new ApiError(500, 'internal_error', 'Device not stored');
      // Logging in again on the same computer replaces its previous session.
      if (previous?.sessionId && previous.sessionId !== created.id) {
        await db.delete(session).where(eq(session.id, previous.sessionId));
      }

      return {
        token: created.token,
        expiresAt: created.expiresAt.toISOString(),
        deviceId,
        me: await loadMe(db, userId),
      };
    },
  );

  // Revokes the calling session (the device row and its stats stay). 204.
  app.post('/app-auth/logout', async (request, reply) => {
    const db = requireDb(ctx);
    const user = requireUser(request);
    const deleted = await db
      .delete(session)
      .where(eq(session.id, user.sessionId))
      .returning({ id: session.id });
    if (deleted.length === 0) throw unauthorized();
    return reply.status(204).send();
  });
};
