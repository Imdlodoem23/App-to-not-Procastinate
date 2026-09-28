/**
 * Account, consent, devices and GDPR (owner: CORE). docs/API.md §5.1 and §13.
 */
import type {
  CloudDevice,
  CloudExport,
  DeleteAccountRequest,
  DevicesResponse,
  MeResponse,
  PatchDeviceRequest,
  PatchMeRequest,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, isValidTimeZone } from '@centrate/shared/cloud-api';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE } from '../auth/session';
import { devices, presence, profiles, session } from '../db/schema';
import { notFound, validationFailed } from '../lib/errors';
import { buildExport, deleteAccount, toCloudDevice } from '../lib/gdpr';
import { parseBody, parseParams, requireDb, requireFreshSession, requireUser } from '../lib/guards';
import { getProfile, hasControlChars, loadMe } from '../lib/profile';
import { deviceName } from './app-auth';

const gdprLimit = { rateLimit: { max: 3, timeWindow: '1 hour' } };

/** A display name: trimmed, 1–40 characters, no control characters. */
export const displayNameSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(CLOUD_LIMITS.displayNameMax)
      .refine((v) => !hasControlChars(v), 'must not contain control characters'),
  );

const PatchMeSchema = z
  .object({
    profile: z
      .object({
        displayName: displayNameSchema.optional(),
        timeZone: z
          .string()
          .refine((v) => isValidTimeZone(v), 'must be an IANA time zone')
          .optional(),
        dailyGoalMinutes: z
          .number()
          .int()
          .min(CLOUD_LIMITS.dailyGoalMinMinutes)
          .max(CLOUD_LIMITS.dailyGoalMaxMinutes)
          .nullable()
          .optional(),
      })
      .strict()
      .optional(),
    sharing: z
      .object({
        syncStats: z.boolean().optional(),
        ranking: z.boolean().optional(),
        presence: z.boolean().optional(),
        partnerEmails: z.boolean().optional(),
        coach: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<PatchMeRequest>;

/**
 * The shared wire type and this schema must accept exactly the same bodies: `satisfies` alone
 * only checks that the schema's output fits the type, so a type wider than the schema (say a
 * nullable display name) would compile in the app and be refused here. This fails to compile
 * when either side accepts something the other does not.
 */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PATCH_ME_TYPES_AGREE: SameShape<z.input<typeof PatchMeSchema>, PatchMeRequest> = true;

const DeleteSchema = z
  .object({ confirm: z.literal('BORRAR') })
  .strict() satisfies z.ZodType<DeleteAccountRequest>;

const PatchDeviceSchema = z
  .object({ name: deviceName })
  .strict() satisfies z.ZodType<PatchDeviceRequest>;

/** Malformed ids are unknown ids: the same 404, and never a Postgres cast error. */
const DeviceParams = z.object({ id: z.string() }).strict();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);

/** Expires the browser session cookie (both spellings) after the account is gone. */
const CLEAR_COOKIES = [
  `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  `__Secure-${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
];

export const meRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get<{ Reply: MeResponse }>('/me', async (request) => {
    const db = requireDb(ctx);
    return loadMe(db, requireUser(request).userId);
  });

  app.patch<{ Body: PatchMeRequest; Reply: MeResponse }>('/me', async (request) => {
    const db = requireDb(ctx);
    const { userId } = requireUser(request);
    const body = parseBody(PatchMeSchema, request);
    const current = await getProfile(db, userId);
    const s = body.sharing ?? {};
    const p = body.profile ?? {};

    const next = {
      shareSync: s.syncStats ?? current.shareSync,
      shareRanking: s.ranking ?? current.shareRanking,
      sharePresence: s.presence ?? current.sharePresence,
      partnerEmails: s.partnerEmails ?? current.partnerEmails,
      coachEnabled: s.coach ?? current.coachEnabled,
    };
    // Turning sync off also turns the ranking off (it is built from synced stats) …
    if (s.syncStats === false && s.ranking === undefined) next.shareRanking = false;
    // … and the ranking cannot be on without sync (a database CHECK enforces it too).
    if (next.shareRanking && !next.shareSync) {
      throw validationFailed([
        { path: 'body.sharing.ranking', message: 'needs sharing.syncStats on' },
      ]);
    }
    const consentChanged =
      next.shareSync !== current.shareSync ||
      next.shareRanking !== current.shareRanking ||
      next.sharePresence !== current.sharePresence ||
      next.partnerEmails !== current.partnerEmails ||
      next.coachEnabled !== current.coachEnabled;
    const now = ctx.now();

    await db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({
          ...next,
          ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
          ...(p.timeZone !== undefined ? { timeZone: p.timeZone } : {}),
          ...(p.dailyGoalMinutes !== undefined ? { dailyGoalMinutes: p.dailyGoalMinutes } : {}),
          ...(consentChanged ? { consentUpdatedAt: now } : {}),
          // Ranking on: keep the time it was turned on, or start now (off → on). Friends
          // only see days from then (§8.2). Decided on the stored row, so a concurrent
          // PATCH cannot leave the ranking on without a start. Off: forgotten.
          rankingSince: next.shareRanking
            ? sql`CASE WHEN ${profiles.shareRanking} THEN coalesce(${profiles.rankingSince}, ${now.toISOString()}::timestamptz) ELSE ${now.toISOString()}::timestamptz END`
            : null,
          updatedAt: now,
        })
        .where(eq(profiles.userId, userId));
      // Presence off: friends stop seeing it at once, not when the row would expire.
      if (!next.sharePresence) await tx.delete(presence).where(eq(presence.userId, userId));
    });
    return loadMe(db, userId);
  });

  app.get<{ Reply: CloudExport }>('/me/export', { config: gdprLimit }, async (request, reply) => {
    const db = requireDb(ctx);
    const user = requireUser(request);
    const data = await buildExport(db, user, ctx.now());
    reply.header('content-disposition', 'attachment; filename="centrate-datos.json"');
    return data;
  });

  app.delete<{ Body: DeleteAccountRequest }>(
    '/me',
    { config: gdprLimit },
    async (request, reply) => {
      const db = requireDb(ctx);
      const user = requireUser(request);
      requireFreshSession(user, ctx.now());
      parseBody(DeleteSchema, request);
      await deleteAccount(db, user.userId);
      reply.header('set-cookie', CLEAR_COOKIES);
      return reply.status(204).send();
    },
  );

  app.get<{ Reply: DevicesResponse }>('/devices', async (request) => {
    const db = requireDb(ctx);
    const user = requireUser(request);
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, user.userId))
      .orderBy(asc(devices.createdAt), asc(devices.id));
    return { devices: rows.map((r) => toCloudDevice(r, user.deviceId)) };
  });

  app.patch<{ Params: { id: string }; Body: PatchDeviceRequest; Reply: CloudDevice }>(
    '/devices/:id',
    async (request) => {
      const db = requireDb(ctx);
      const user = requireUser(request);
      const { id } = parseParams(DeviceParams, request);
      if (!isUuid(id)) throw notFound();
      const { name } = parseBody(PatchDeviceSchema, request);
      const rows = await db
        .update(devices)
        .set({ name })
        .where(and(eq(devices.id, id), eq(devices.userId, user.userId)))
        .returning();
      if (!rows[0]) throw notFound();
      return toCloudDevice(rows[0], user.deviceId);
    },
  );

  // Removes the device, its stats (cascade) and its session. 204. A computer disconnecting
  // itself needs nothing more; removing any other one needs a fresh session (§4.3), so an old
  // session left somewhere cannot sign the owner's computers out and wipe their stats.
  app.delete<{ Params: { id: string } }>('/devices/:id', async (request, reply) => {
    const db = requireDb(ctx);
    const user = requireUser(request);
    const { id } = parseParams(DeviceParams, request);
    if (id !== user.deviceId) requireFreshSession(user, ctx.now());
    if (!isUuid(id)) throw notFound();
    await db.transaction(async (tx) => {
      const rows = await tx
        .delete(devices)
        .where(and(eq(devices.id, id), eq(devices.userId, user.userId)))
        .returning({ sessionId: devices.sessionId });
      if (!rows[0]) throw notFound();
      const sessionId = rows[0].sessionId;
      if (sessionId) {
        await tx
          .delete(session)
          .where(and(eq(session.id, sessionId), eq(session.userId, user.userId)));
      }
    });
    return reply.status(204).send();
  });
};
