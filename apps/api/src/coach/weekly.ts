/**
 * «Resumen semanal» (owner: COACH). docs/API.md §10.1.
 *
 * Numbers only: with stats sync on, the week (plus the three previous weeks' totals) is read
 * from `daily_stats`; otherwise the app sends the week's numbers, which are used for this call
 * and never stored. The summary text is not stored either (the app caches it).
 */
import type { CloudDayStats, IsoWeek, WeeklySummaryResponse } from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, addDays, isoWeekOf } from '@centrate/shared/cloud-api';
import type { LocalDay } from '@centrate/shared/domain';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { dailyStats } from '../db/schema';
import type { WeeklySummaryOutput } from './schemas';
import { weekdayName } from './study-plan';
import { outputText } from './text';

export type DayNumbers = Omit<CloudDayStats, 'rev'>;

export interface WeekTotals {
  week: IsoWeek;
  focusMinutes: number;
  studyMinutes: number;
  activeDays: number;
  goalDays: number;
}

export interface WeekInput {
  week: IsoWeek;
  from: LocalDay;
  to: LocalDay;
  /** Days of the week with numbers (days without a row count as zero). */
  days: DayNumbers[];
  dailyGoalMinutes: number | null;
  /** Up to three earlier weeks, oldest first; empty when the numbers came from the app. */
  previous: WeekTotals[];
}

const HEADLINE_MAX = 120;
const HIGHLIGHT_MAX = 160;
const HIGHLIGHTS_MAX = 4;
const SUGGESTION_MAX = 240;
const PREVIOUS_WEEKS = 3;

const goalMet = (d: DayNumbers, goal: number | null): boolean =>
  goal !== null && d.focusMinutes >= goal;

/** The week and the three before it, summed across devices (focus capped at 1440 a day). */
export async function loadWeekFromCloud(
  db: Db,
  userId: string,
  week: IsoWeek,
  range: { from: LocalDay; to: LocalDay },
  dailyGoalMinutes: number | null,
): Promise<WeekInput> {
  const start = addDays(range.from, -7 * PREVIOUS_WEEKS);
  const s = (column: AnyPgColumn) => sql<number>`SUM(${column})::int`;
  const rows = await db
    .select({
      day: dailyStats.day,
      focusMinutes: s(dailyStats.focusMinutes),
      studyMinutes: s(dailyStats.studyMinutes),
      blocksCompleted: s(dailyStats.blocksCompleted),
      studySessions: s(dailyStats.studySessions),
      attempts: s(dailyStats.attempts),
      emergencyUnlocks: s(dailyStats.emergencyUnlocks),
      punishments: s(dailyStats.punishments),
      pointsEarned: s(dailyStats.pointsEarned),
      pointsLost: s(dailyStats.pointsLost),
    })
    .from(dailyStats)
    .where(
      and(eq(dailyStats.userId, userId), gte(dailyStats.day, start), lte(dailyStats.day, range.to)),
    )
    .groupBy(dailyStats.day)
    .orderBy(asc(dailyStats.day));

  const days: DayNumbers[] = rows.map((r) => {
    const focus = Math.min(CLOUD_LIMITS.dayMinutesMax, Number(r.focusMinutes));
    return {
      day: r.day,
      focusMinutes: focus,
      studyMinutes: Math.min(focus, Number(r.studyMinutes)),
      blocksCompleted: Number(r.blocksCompleted),
      studySessions: Number(r.studySessions),
      attempts: Number(r.attempts),
      emergencyUnlocks: Number(r.emergencyUnlocks),
      punishments: Number(r.punishments),
      pointsEarned: Number(r.pointsEarned),
      pointsLost: Number(r.pointsLost),
    };
  });

  const previous: WeekTotals[] = [];
  for (let k = PREVIOUS_WEEKS; k >= 1; k -= 1) {
    const from = addDays(range.from, -7 * k);
    const to = addDays(from, 6);
    const inWeek = days.filter((d) => d.day >= from && d.day <= to);
    previous.push(totals(isoWeekOf(from), inWeek, dailyGoalMinutes));
  }
  return {
    week,
    from: range.from,
    to: range.to,
    days: days.filter((d) => d.day >= range.from && d.day <= range.to),
    dailyGoalMinutes,
    previous: previous.some((w) => w.activeDays > 0) ? previous : [],
  };
}

export function totals(
  week: IsoWeek,
  days: readonly DayNumbers[],
  goal: number | null,
): WeekTotals {
  return {
    week,
    focusMinutes: days.reduce((sum, d) => sum + d.focusMinutes, 0),
    studyMinutes: days.reduce((sum, d) => sum + d.studyMinutes, 0),
    activeDays: days.filter((d) => d.focusMinutes > 0).length,
    goalDays: days.filter((d) => goalMet(d, goal)).length,
  };
}

const shortDate = (day: LocalDay): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const points = (earned: number, lost: number): string =>
  `puntos +${earned} / ${lost > 0 ? `−${lost}` : '0'}`;

/** The numbers as Spanish lines. No free text from the user ever goes in. */
export function weeklyUserMessage(input: WeekInput): string {
  const byDay = new Map(input.days.map((d) => [d.day, d]));
  const lines = [
    `Semana ${input.week}: del lunes ${shortDate(input.from)} al domingo ${shortDate(input.to)}.`,
    input.dailyGoalMinutes === null
      ? 'Sin objetivo diario.'
      : `Objetivo diario: ${input.dailyGoalMinutes} minutos de concentración.`,
    'Días:',
  ];
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(input.from, i);
    const d = byDay.get(day);
    const label = `${weekdayName(day)} ${shortDate(day)}`;
    if (
      !d ||
      (d.focusMinutes === 0 && d.attempts === 0 && d.pointsEarned === 0 && d.pointsLost === 0)
    ) {
      lines.push(`- ${label}: sin actividad.`);
      continue;
    }
    const goal =
      input.dailyGoalMinutes === null
        ? ''
        : `, objetivo ${goalMet(d, input.dailyGoalMinutes) ? 'cumplido' : 'no cumplido'}`;
    lines.push(
      `- ${label}: concentración ${d.focusMinutes} min (estudio ${d.studyMinutes} min), ` +
        `${d.blocksCompleted} bloqueos completados, ${d.studySessions} sesiones de estudio, ` +
        `${d.attempts} intentos de abrir algo bloqueado, ${d.emergencyUnlocks} desbloqueos de emergencia, ` +
        `${d.punishments} castigos del Study Mode, ${points(d.pointsEarned, d.pointsLost)}${goal}.`,
    );
  }
  const t = totals(input.week, input.days, input.dailyGoalMinutes);
  lines.push(
    `Totales: concentración ${t.focusMinutes} min, estudio ${t.studyMinutes} min, ` +
      `${t.activeDays} días con actividad` +
      (input.dailyGoalMinutes === null ? '.' : `, ${t.goalDays} días con el objetivo cumplido.`),
  );
  if (input.previous.length === 0) {
    lines.push('Semanas anteriores: sin datos.');
  } else {
    lines.push('Semanas anteriores:');
    for (const w of input.previous) {
      lines.push(
        `- ${w.week}: concentración ${w.focusMinutes} min, estudio ${w.studyMinutes} min, ` +
          `${w.activeDays} días con actividad` +
          (input.dailyGoalMinutes === null ? '.' : `, ${w.goalDays} con el objetivo cumplido.`),
      );
    }
  }
  return lines.join('\n');
}

export function weeklyAnswer(output: WeeklySummaryOutput): WeeklySummaryResponse | null {
  const headline = outputText(output.headline, HEADLINE_MAX);
  if (!headline) return null;
  return {
    headline,
    highlights: output.highlights
      .map((h) => outputText(h, HIGHLIGHT_MAX))
      .filter((h) => h.length > 0)
      .slice(0, HIGHLIGHTS_MAX),
    suggestion: outputText(output.suggestion, SUGGESTION_MAX),
  };
}
