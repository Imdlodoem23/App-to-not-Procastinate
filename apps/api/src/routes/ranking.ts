/**
 * Weekly ranking among friends (owner: SOCIAL). docs/API.md §8.2.
 *
 * - Reciprocity: only a caller who shares their ranking sees one, and it lists only friends
 *   who share theirs (blocks excluded).
 * - Each person's `day` values are their own civil dates, so everyone is compared Monday to
 *   Sunday in their own time zone.
 * - Per person and day, devices are summed and capped (focus ≤ 1440, study ≤ focus). Points
 *   are never shared.
 * - Never retroactive: a friend's days count only from the day (in their zone) when the two
 *   were friends and both had the ranking on, so neither a new friend nor someone who just
 *   turned the ranking on sees earlier weeks. A friend with no such day in the week is left
 *   out. The caller's own entry keeps its full history.
 */
import type { IsoWeek, RankingEntry, RankingResponse } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, isoWeekOf, isoWeekRange, localDayIn } from '@centrate/shared/cloud-api';
import { and, between, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { dailyStats, friendships, profiles } from '../db/schema';
import { validationFailed } from '../lib/errors';
import { parseQuery, requireDb, requireFeature, requireUser } from '../lib/guards';
import { getProfile, requireConsent, requireDisplayName } from '../lib/profile';
import { notBlockedWith } from '../social/people';

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

/**
 * The first of a friend's days the caller may see: the civil day, in the friend's zone, of
 * the latest of «became friends», «friend turned the ranking on» and «caller turned it on».
 * A missing start (never stored while the switch is on) counts as now.
 */
export function firstSharedDay(
  friendTimeZone: string,
  friendsSince: Date,
  friendRankingSince: Date | null,
  myRankingSince: Date | null,
  now: Date,
): string {
  const start = Math.max(
    friendsSince.getTime(),
    (friendRankingSince ?? now).getTime(),
    (myRankingSince ?? now).getTime(),
  );
  return localDayIn(friendTimeZone, new Date(start));
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

      const now = ctx.now();
      const week: IsoWeek = query.week ?? isoWeekOf(localDayIn(profile.timeZone, now));
      const range = isoWeekRange(week);
      if (!range) {
        throw validationFailed([{ path: 'query.week', message: 'This year has no such week' }]);
      }

      // Friends who share their ranking too (reciprocity), blocks excluded, each with the
      // first day of theirs the caller may see. Friends whose shared time starts after this
      // week were not in its ranking.
      const friends = await db
        .select({
          userId: profiles.userId,
          displayName: profiles.displayName,
          goal: profiles.dailyGoalMinutes,
          timeZone: profiles.timeZone,
          rankingSince: profiles.rankingSince,
          friendsSince: friendships.createdAt,
        })
        .from(friendships)
        .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
        .where(
          and(
            eq(friendships.userId, me.userId),
            eq(profiles.shareRanking, true),
            notBlockedWith(me.userId, friendships.friendId),
          ),
        );
      const members = new Map<
        string,
        { displayName: string; goal: number | null; firstDay: string }
      >([
        [me.userId, { displayName: myName, goal: profile.dailyGoalMinutes, firstDay: range.from }],
      ]);
      for (const f of friends) {
        if (!f.displayName) continue;
        const firstDay = firstSharedDay(
          f.timeZone,
          f.friendsSince,
          f.rankingSince,
          profile.rankingSince,
          now,
        );
        if (firstDay > range.to) continue;
        members.set(f.userId, { displayName: f.displayName, goal: f.goal, firstDay });
      }

      // One row per person and day, devices summed and capped.
      const focusSum = sql`sum(${dailyStats.focusMinutes})`;
      const days = await db
        .select({
          userId: dailyStats.userId,
          day: dailyStats.day,
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
        if (!t || !member || d.day < member.firstDay) continue;
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
