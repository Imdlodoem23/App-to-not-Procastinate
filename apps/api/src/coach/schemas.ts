/**
 * Zod schemas of the coach (owner: COACH): request bodies (checked against the shared wire
 * types) and the shapes asked from the model with structured outputs.
 *
 * Model schemas hold only types and enums. Structured outputs cannot enforce lengths or ranges
 * (the SDK strips them), so the service clamps those itself after parsing: a title that runs
 * long is shortened instead of failing the whole answer.
 */
import type { CategoryId } from '@centrate/shared/catalog';
import { CATEGORY_IDS, SERVICES } from '@centrate/shared/catalog';
import type {
  InterpretRequest,
  SplitTaskRequest,
  StudyPlanRequest,
  WeeklySummaryRequest,
  WeekStats,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS, isLocalDay, isValidTimeZone } from '@centrate/shared/cloud-api';
import type { IsoWeekday } from '@centrate/shared/domain';
import { z } from 'zod';
import { oneLine } from './text';

const L = CLOUD_LIMITS;

/** Trimmed text, `min`–`max` characters after removing control characters. */
const text = (min: number, max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(oneLine)
    .pipe(z.string().min(min).max(max));

const localDay = z.string().refine((v) => isLocalDay(v), 'must be a date YYYY-MM-DD');
const count = (max: number) => z.number().int().min(0).max(max);

// ---------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------

export const InterpretSchema = z
  .object({
    text: text(1, L.interpretTextMax),
    timeZone: z.string().refine((v) => isValidTimeZone(v), 'must be an IANA time zone'),
    now: z.iso.datetime({ offset: true }),
  })
  .strict() satisfies z.ZodType<InterpretRequest, unknown>;

export const SplitTaskSchema = z
  .object({
    task: text(1, L.coachTaskMax),
    context: text(0, L.coachContextMax)
      .nullable()
      .transform((v) => (v ? v : null)),
    minutesAvailable: z.number().int().min(5).max(600).nullable(),
  })
  .strict() satisfies z.ZodType<SplitTaskRequest, unknown>;

const weekday = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]) satisfies z.ZodType<IsoWeekday>;

export const StudyPlanSchema = z
  .object({
    subject: text(1, L.studySubjectMax),
    examDate: localDay,
    today: localDay,
    dailyMinutes: z.number().int().min(L.studyDailyMinMinutes).max(L.studyDailyMaxMinutes),
    topics: z.array(text(1, L.studyTopicMax)).max(L.studyTopicsMax),
    level: z.enum(['starting', 'intermediate', 'reviewing']).nullable(),
    daysOff: z
      .array(weekday)
      .max(6)
      .refine((days) => new Set(days).size === days.length, 'must not repeat a weekday'),
  })
  .strict() satisfies z.ZodType<StudyPlanRequest, unknown>;

const WeekDaySchema = z
  .object({
    day: localDay,
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
  });

const WeekStatsSchema = z
  .object({
    days: z
      .array(WeekDaySchema)
      .max(7)
      .refine((days) => new Set(days.map((d) => d.day)).size === days.length, {
        message: 'must not repeat a day',
      }),
    dailyGoalMinutes: z
      .number()
      .int()
      .min(L.dailyGoalMinMinutes)
      .max(L.dailyGoalMaxMinutes)
      .nullable(),
  })
  .strict() satisfies z.ZodType<WeekStats, unknown>;

export const WeeklySummarySchema = z
  .object({
    week: z.string().regex(/^\d{4}-W\d{2}$/, 'must be an ISO week YYYY-Www'),
    stats: WeekStatsSchema.nullable(),
  })
  .strict() satisfies z.ZodType<WeeklySummaryRequest, unknown>;

// ---------------------------------------------------------------------------------------
// Model outputs (structured outputs)
// ---------------------------------------------------------------------------------------

export const SERVICE_IDS = SERVICES.map((s) => s.id) as [string, ...string[]];

export const InterpretOutput = z.object({
  kind: z.enum(['block', 'study', 'unclear']),
  serviceIds: z.array(z.enum(SERVICE_IDS)),
  categoryIds: z.array(z.enum(CATEGORY_IDS as unknown as [CategoryId, ...CategoryId[]])),
  domains: z.array(z.string()),
  durationMinutes: z.number().int().nullable(),
  untilTime: z.string().nullable(),
  untilTomorrow: z.boolean(),
  task: z.string().nullable(),
  clarification: z.string().nullable(),
});
export type InterpretOutput = z.infer<typeof InterpretOutput>;

export const SplitTaskOutput = z.object({
  steps: z.array(
    z.object({
      title: z.string(),
      minutes: z.number().int(),
      suggestedPhrase: z.string().nullable(),
    }),
  ),
  firstStepTip: z.string(),
});
export type SplitTaskOutput = z.infer<typeof SplitTaskOutput>;

export const StudyPlanOutput = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      items: z.array(
        z.object({
          topic: z.string(),
          kind: z.enum(['learn', 'review', 'practice', 'mock']),
          minutes: z.number().int(),
        }),
      ),
    }),
  ),
  advice: z.array(z.string()),
});
export type StudyPlanOutput = z.infer<typeof StudyPlanOutput>;

export const WeeklySummaryOutput = z.object({
  headline: z.string(),
  highlights: z.array(z.string()),
  suggestion: z.string(),
});
export type WeeklySummaryOutput = z.infer<typeof WeeklySummaryOutput>;
