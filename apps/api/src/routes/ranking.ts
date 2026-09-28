/**
 * Weekly ranking among friends (owner: SOCIAL). docs/API.md §8.2.
 *
 * - Reciprocity: only a caller who shares their ranking sees one, and it lists only friends
 *   who share theirs (blocks excluded).
 * - Each person's `day` values are their own civil dates, so everyone is compared Monday to
 *   Sunday in their own time zone.
 * - Per person and day, devices are summed and capped (focus ≤ 1440, study ≤ focus). Points
 *   are never shared.
 */
import type { IsoWeek, RankingEntry, RankingResponse } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, isoWeekOf, isoWeekRange, localDayIn } from '@centrate/shared/cloud-api';
import { and, between, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { dailyStats, profiles } from '../db/schema';
import { validationFailed } from '../lib/errors';
import { parseQuery, requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireConsent, requireDisplayName } from '../lib/profile';
import { friendIds } from '../social/people';

const QuerySchema = z
  .object({
    week: z
      .string()
      .regex(/^(19[7-9]\d|2\d{3})-W\d{2}$/, 'must be an ISO week like 2026-W40')
      .optional(),
  })
  .strict();

const collator = new Intl.Collator('es', { sensitivity: 'base' });

interface Totals {
  focusMinutes: number;
  studyMinutes: number;
  activeDays: number;
  goalDays: number;
}

/** Orders by minutes, active days, name (Spanish collation), id; ranks 1, 2, 2, 4. */
export function rankEntries(entries: Array<Omit<RankingEntry, 'rank'>>): RankingEntry[] {
  const sorted = [...entries].sort(
    (a, b) =>
      b.focusMinutes - a.focusMinutes ||
      b.activeDays - a.activeDays ||
      collator.compare(a.displayName, b.displayName) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  let rank = 0;
  return sorted.map((entry, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.focusMinutes !== entry.focusMinutes || prev.activeDays !== entry.activeDays) {
      rank = i + 1;
    }
    return { ...entry, rank };
  });
}

export const rankingRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get<{ Querystring: { week?: string }; Reply: RankingResponse }>(
    '/ranking',
    async (request) => {
      requireFeature(ctx, 'social');
      const me = requireUser(request);
      const db = requireDb(ctx);
      const query = parseQuery(QuerySchema, request);
      const profile = await getProfile(db, me.userId);
      requireConsent(profile, 'ranking');
      const myName = requireDisplayName(profile);

      const week: IsoWeek = query.week ?? isoWeekOf(localDayIn(profile.timeZone, ctx.now()));
      const range = isoWeekRange(week);
      if (!range) {
        throw validationFailed([{ path: 'query.week', message: 'This year has no such week' }]);
      }

      // Friends who share their ranking too (reciprocity), blocks excluded.
      const friends = await friendIds(db, me.userId);
      const people =
        friends.length === 0
          ? []
          : await db
              .select({
                userId: profiles.userId,
                displayName: profiles.displayName,
                goal: profiles.dailyGoalMinutes,
              })
              .from(profiles)
              .where(and(inArray(profiles.userId, friends), eq(profiles.shareRanking, true)));
      const members = new Map<string, { displayName: string; goal: number | null }>([
        [me.userId, { displayName: myName, goal: profile.dailyGoalMinutes }],
      ]);
      for (const p of people) {
        if (p.displayName) members.set(p.userId, { displayName: p.displayName, goal: p.goal });
      }

      // One row per person and day, devices summed and capped.
      const focusSum = sql`sum(${dailyStats.focusMinutes})`;
      const days = await db
        .select({
          userId: dailyStats.userId,
          focus: sql<number>`least(${focusSum}, ${CLOUD_LIMITS.dayMinutesMax})::int`.mapWith(
            Number,
          ),
          study:
            sql<number>`least(sum(${dailyStats.studyMinutes}), ${focusSum}, ${CLOUD_LIMITS.dayMinutesMax})::int`.mapWith(
              Number,
            ),
        })
        .from(dailyStats)
        .where(
          and(
            inArray(dailyStats.userId, [...members.keys()]),
            between(dailyStats.day, range.from, range.to),
          ),
        )
        .groupBy(dailyStats.userId, dailyStats.day);

      const totals = new Map<string, Totals>();
      for (const id of members.keys()) {
        totals.set(id, { focusMinutes: 0, studyMinutes: 0, activeDays: 0, goalDays: 0 });
      }
      for (const d of days) {
        const t = totals.get(d.userId);
        const member = members.get(d.userId);
        if (!t || !member) continue;
        t.focusMinutes += d.focus;
        t.studyMinutes += d.study;
        if (d.focus > 0) t.activeDays += 1;
        if (member.goal !== null && d.focus >= member.goal) t.goalDays += 1;
      }

      const entries = rankEntries(
        [...members].map(([userId, m]) => ({
          userId,
          displayName: m.displayName,
          ...(totals.get(userId) as Totals),
          isMe: userId === me.userId,
        })),
      );
      return { week, from: range.from, to: range.to, entries };
    },
  );
};
