/**
 * Stats sync and read-back (owner: CORE). docs/API.md §7.
 *
 * Each computer uploads its absolute totals per (device, local day), computed from its own
 * guardian event log; only the owning device writes its rows, so devices never conflict. The
 * upsert keeps the row with the highest `rev` (an equal `rev` overwrites), so replays are
 * harmless and a lower `rev` comes back as `stale`. Numbers only.
 */
import type {
  CloudDayStats,
  CloudMergedDay,
  PutDaysRequest,
  PutDaysResponse,
  StatsResponse,
  SyncStateResponse,
} from '@centrate/shared/cloud-api';
import {
  CLOUD_LIMITS,
  addDays,
  daysBetween,
  isLocalDay,
  localDayIn,
} from '@centrate/shared/cloud-api';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { readServerEpoch } from '../db/meta';
import { dailyStats, devices } from '../db/schema';
import { forbidden, notFound, validationFailed } from '../lib/errors';
import { toCloudDevice } from '../lib/gdpr';
import {
  parseBody,
  parseQuery,
  requireDb,
  requireFeature,
  requireFreshSession,
  requireUser,
} from '../lib/guards';
import { getProfile, requireConsent } from '../lib/profile';
import { isUuid } from './me';

const L = CLOUD_LIMITS;
const count = (max: number) => z.number().int().min(0).max(max);
const localDay = z.string().refine((v) => isLocalDay(v), 'must be a date YYYY-MM-DD');

const DayStatsSchema = z
  .object({
    day: localDay,
    rev: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    focusMinutes: count(L.dayMinutesMax),
    studyMinutes: count(L.dayMinutesMax),
    blocksCompleted: count(L.counterMax),
    studySessions: count(L.counterMax),
    attempts: count(L.counterMax),
    emergencyUnlocks: count(L.counterMax),
    punishments: count(L.counterMax),
    pointsEarned: count(L.pointsMax),
    pointsLost: count(L.pointsMax),
  })
  .strict()
  .refine((d) => d.studyMinutes <= d.focusMinutes, {
    message: 'studyMinutes cannot exceed focusMinutes',
    path: ['studyMinutes'],
  }) satisfies z.ZodType<CloudDayStats>;

const PutDaysSchema = z
  .object({
    deviceId: z.string(),
    days: z.array(DayStatsSchema).max(L.syncBatchMax),
  })
  .strict() satisfies z.ZodType<PutDaysRequest>;

const StateQuery = z.object({ deviceId: z.string() }).strict();
const DeleteQuery = z.object({ deviceId: z.string().optional() }).strict();
const StatsQuery = z.object({ from: localDay, to: localDay }).strict();

/** The caller's device, or 404 (unknown, malformed or someone else's). */
async function ownDevice(db: Db, userId: string, deviceId: string) {
  if (!isUuid(deviceId)) throw notFound('No such device');
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .limit(1);
  if (!rows[0]) throw notFound('No such device');
  return rows[0];
}

const STAT_COLUMNS = [
  'rev',
  'focus_minutes',
  'study_minutes',
  'blocks_completed',
  'study_sessions',
  'attempts',
  'emergency_unlocks',
  'punishments',
  'points_earned',
  'points_lost',
] as const;

export const syncRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get<{ Querystring: { deviceId: string }; Reply: SyncStateResponse }>(
    '/sync/state',
    async (request) => {
      requireFeature(ctx, 'sync');
      const db = requireDb(ctx);
      const { userId } = requireUser(request);
      const { deviceId } = parseQuery(StateQuery, request);
      await ownDevice(db, userId, deviceId);
      const profile = await getProfile(db, userId);
      const since = addDays(localDayIn(profile.timeZone, ctx.now()), -L.syncPastDays);
      const revs = await db
        .select({ day: dailyStats.day, rev: dailyStats.rev })
        .from(dailyStats)
        .where(and(eq(dailyStats.deviceId, deviceId), gte(dailyStats.day, since)))
        .orderBy(asc(dailyStats.day));
      return { serverEpoch: await readServerEpoch(db), deviceId, revs };
    },
  );

  app.put<{ Body: PutDaysRequest; Reply: PutDaysResponse }>(
    '/sync/days',
    {
      bodyLimit: L.syncBodyBytes,
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    },
    async (request) => {
      requireFeature(ctx, 'sync');
      const db = requireDb(ctx);
      const user = requireUser(request);
      const body = parseBody(PutDaysSchema, request);
      const profile = await getProfile(db, user.userId);
      requireConsent(profile, 'syncStats');
      await ownDevice(db, user.userId, body.deviceId);
      // Only the computer that owns the rows writes them (its bearer session).
      if (user.deviceId !== body.deviceId) {
        throw forbidden('Only the device itself can upload its stats');
      }

      const today = localDayIn(profile.timeZone, ctx.now());
      const first = addDays(today, -L.syncPastDays);
      const last = addDays(today, L.syncFutureDays);
      const seen = new Set<string>();
      const issues: Array<{ path: string; message: string }> = [];
      body.days.forEach((d, i) => {
        if (seen.has(d.day)) issues.push({ path: `body.days.${i}.day`, message: 'duplicate day' });
        seen.add(d.day);
        if (d.day < first || d.day > last) {
          issues.push({
            path: `body.days.${i}.day`,
            message: `must be between ${first} and ${last}`,
          });
        }
      });
      if (issues.length > 0) throw validationFailed(issues.slice(0, 20));

      const now = ctx.now();
      let accepted: string[] = [];
      if (body.days.length > 0) {
        const set = Object.fromEntries([
          ...STAT_COLUMNS.map((c) => [snakeToCamel(c), sql.raw(`excluded.${c}`)]),
          ['updatedAt', now],
        ]);
        const rows = await db
          .insert(dailyStats)
          .values(
            body.days.map((d) => ({
              ...d,
              deviceId: body.deviceId,
              userId: user.userId,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [dailyStats.deviceId, dailyStats.day],
            set,
            setWhere: sql`excluded.rev >= ${dailyStats.rev}`,
          })
          .returning({ day: dailyStats.day });
        accepted = rows.map((r) => r.day);
      }
      await db.update(devices).set({ lastSyncAt: now }).where(eq(devices.id, body.deviceId));
      const acceptedSet = new Set(accepted);
      return {
        accepted: accepted.length,
        stale: body.days
          .map((d) => d.day)
          .filter((day) => !acceptedSet.has(day))
          .sort(),
      };
    },
  );

  // Deletes the caller's cloud stats (all devices, or `?deviceId=`). 204. No consent needed:
  // deleting is always allowed, also after turning sync off. A computer deleting its own stats
  // needs nothing more; all devices or another one's need a fresh session (§4.3), so an old
  // session left somewhere cannot wipe them (days past `syncPastDays` never come back).
  app.delete<{ Querystring: { deviceId?: string } }>('/sync/days', async (request, reply) => {
    const db = requireDb(ctx);
    const user = requireUser(request);
    const { userId } = user;
    const { deviceId } = parseQuery(DeleteQuery, request);
    if (deviceId === undefined || deviceId !== user.deviceId) {
      requireFreshSession(user, ctx.now());
    }
    if (deviceId !== undefined) {
      await ownDevice(db, userId, deviceId);
      await db
        .delete(dailyStats)
        .where(and(eq(dailyStats.userId, userId), eq(dailyStats.deviceId, deviceId)));
    } else {
      await db.delete(dailyStats).where(eq(dailyStats.userId, userId));
    }
    return reply.status(204).send();
  });

  app.get<{ Querystring: { from: string; to: string }; Reply: StatsResponse }>(
    '/stats',
    async (request) => {
      requireFeature(ctx, 'sync');
      const db = requireDb(ctx);
      const user = requireUser(request);
      const { from, to } = parseQuery(StatsQuery, request);
      const span = daysBetween(from, to) + 1;
      if (span < 1 || span > L.statsRangeMaxDays) {
        throw validationFailed([
          { path: 'query.to', message: `must be from..from+${L.statsRangeMaxDays - 1} days` },
        ]);
      }
      const profile = await getProfile(db, user.userId);
      const [rows, deviceRows] = await Promise.all([
        db
          .select()
          .from(dailyStats)
          .where(
            and(
              eq(dailyStats.userId, user.userId),
              gte(dailyStats.day, from),
              lte(dailyStats.day, to),
            ),
          )
          .orderBy(asc(dailyStats.day), asc(dailyStats.deviceId)),
        db
          .select()
          .from(devices)
          .where(eq(devices.userId, user.userId))
          .orderBy(asc(devices.createdAt), asc(devices.id)),
      ]);
      return {
        from,
        to,
        dailyGoalMinutes: profile.dailyGoalMinutes,
        days: mergeDays(rows, profile.dailyGoalMinutes),
        deviceDays: rows.map(toDeviceDay),
        devices: deviceRows.map((d) => toCloudDevice(d, user.deviceId)),
      };
    },
  );
};

function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

type StatRow = typeof dailyStats.$inferSelect;

function toDeviceDay(r: StatRow): CloudDayStats & { deviceId: string } {
  return {
    deviceId: r.deviceId,
    day: r.day,
    rev: r.rev,
    focusMinutes: r.focusMinutes,
    studyMinutes: r.studyMinutes,
    blocksCompleted: r.blocksCompleted,
    studySessions: r.studySessions,
    attempts: r.attempts,
    emergencyUnlocks: r.emergencyUnlocks,
    punishments: r.punishments,
    pointsEarned: r.pointsEarned,
    pointsLost: r.pointsLost,
  };
}

/**
 * Sums devices per day. A day has 1440 minutes however many computers were on, so focus is
 * capped there and study at focus. `goalMet` compares focus minutes with the daily goal.
 */
export function mergeDays(rows: StatRow[], goal: number | null): CloudMergedDay[] {
  const byDay = new Map<string, CloudMergedDay>();
  for (const r of rows) {
    const d = byDay.get(r.day) ?? {
      day: r.day,
      focusMinutes: 0,
      studyMinutes: 0,
      blocksCompleted: 0,
      studySessions: 0,
      attempts: 0,
      emergencyUnlocks: 0,
      punishments: 0,
      pointsEarned: 0,
      pointsLost: 0,
      goalMet: null,
    };
    d.focusMinutes += r.focusMinutes;
    d.studyMinutes += r.studyMinutes;
    d.blocksCompleted += r.blocksCompleted;
    d.studySessions += r.studySessions;
    d.attempts += r.attempts;
    d.emergencyUnlocks += r.emergencyUnlocks;
    d.punishments += r.punishments;
    d.pointsEarned += r.pointsEarned;
    d.pointsLost += r.pointsLost;
    byDay.set(r.day, d);
  }
  const out = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const d of out) {
    d.focusMinutes = Math.min(d.focusMinutes, L.dayMinutesMax);
    d.studyMinutes = Math.min(d.studyMinutes, d.focusMinutes);
    d.goalMet = goal === null ? null : d.focusMinutes >= goal;
  }
  return out;
}
