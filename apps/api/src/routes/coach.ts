/**
 * Coach through the Claude API (owner: COACH). docs/API.md §10. The Anthropic key never
 * leaves the backend; no prompt or answer text is stored or logged, only token counters.
 *
 * Every route needs the `coach` capability (503 otherwise) and the caller's `sharing.coach`
 * switch (403 consent_required), except GET /coach/quota, which needs only the capability.
 */
import type {
  CoachQuotaResponse,
  InterpretRequest,
  InterpretResponse,
  SplitTaskRequest,
  SplitTaskResponse,
  StudyPlanRequest,
  StudyPlanResponse,
  WeeklySummaryRequest,
  WeeklySummaryResponse,
} from '@centrate/shared/cloud-api';
import { daysBetween, isoWeekRange, localDayIn } from '@centrate/shared/cloud-api';
import type { FastifyPluginAsync } from 'fastify';
import { interpretAnswer, interpretUserMessage, wallClock } from '../coach/interpret';
import {
  INTERPRET_SYSTEM,
  SPLIT_TASK_SYSTEM,
  STUDY_PLAN_SYSTEM,
  WEEKLY_SUMMARY_SYSTEM,
} from '../coach/prompts';
import { quotaLeft } from '../coach/quota';
import {
  InterpretOutput,
  InterpretSchema,
  SplitTaskOutput,
  SplitTaskSchema,
  StudyPlanOutput,
  StudyPlanSchema,
  WeeklySummaryOutput,
  WeeklySummarySchema,
} from '../coach/schemas';
import { callCoach, coachGate, incompleteAnswer } from '../coach/service';
import { splitTaskAnswer, splitTaskUserMessage } from '../coach/split-task';
import {
  STUDY_EXAM_MAX_DAYS_AHEAD,
  studyDays,
  studyPlanAnswer,
  studyPlanUserMessage,
} from '../coach/study-plan';
import type { WeekInput } from '../coach/weekly';
import { loadWeekFromCloud, weeklyAnswer, weeklyUserMessage } from '../coach/weekly';
import { validationFailed } from '../lib/errors';
import { parseBody, requireDb, requireFeature, requireUser } from '../lib/guards';

const coachLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const coachBody = 16 * 1024;
/** The app's clock may drift; anything further off than this is a client bug. */
const CLOCK_SKEW_MS = 24 * 3_600_000;

export const coachRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get<{ Reply: CoachQuotaResponse }>('/coach/quota', async (request) => {
    requireFeature(ctx, 'coach');
    const me = requireUser(request);
    const left = await quotaLeft(requireDb(ctx), ctx.config, me.userId, ctx.now());
    return { ...left, resetsAt: left.resetsAt.toISOString() };
  });

  app.post<{ Body: InterpretRequest; Reply: InterpretResponse }>(
    '/coach/interpret',
    { bodyLimit: coachBody, config: coachLimit },
    async (request) => {
      const gate = await coachGate(ctx, request);
      const { me } = gate;
      const body = parseBody(InterpretSchema, request);
      const at = new Date(body.now);
      if (Math.abs(at.getTime() - ctx.now().getTime()) > CLOCK_SKEW_MS) {
        throw validationFailed([{ path: 'body.now', message: 'Must be the current time' }]);
      }
      const intent = await callCoach(ctx, request.log, me, gate.model, {
        endpoint: 'interpret',
        system: INTERPRET_SYSTEM,
        user: interpretUserMessage(body.text, at, body.timeZone),
        schema: InterpretOutput,
      });
      return interpretAnswer(intent, body.text, wallClock(at, body.timeZone));
    },
  );

  app.post<{ Body: SplitTaskRequest; Reply: SplitTaskResponse }>(
    '/coach/split-task',
    { bodyLimit: coachBody, config: coachLimit },
    async (request) => {
      const gate = await coachGate(ctx, request);
      const { me } = gate;
      const body = parseBody(SplitTaskSchema, request);
      const output = await callCoach(ctx, request.log, me, gate.model, {
        endpoint: 'split-task',
        system: SPLIT_TASK_SYSTEM,
        user: splitTaskUserMessage(body),
        schema: SplitTaskOutput,
      });
      const now = wallClock(ctx.now(), gate.profile.timeZone);
      return splitTaskAnswer(output, now) ?? incompleteAnswer();
    },
  );

  app.post<{ Body: StudyPlanRequest; Reply: StudyPlanResponse }>(
    '/coach/study-plan',
    { bodyLimit: coachBody, config: coachLimit },
    async (request) => {
      const gate = await coachGate(ctx, request);
      const { me } = gate;
      const body = parseBody(StudyPlanSchema, request);
      const utcToday = ctx.now().toISOString().slice(0, 10);
      if (Math.abs(daysBetween(utcToday, body.today)) > 1) {
        throw validationFailed([{ path: 'body.today', message: 'Must be the current date' }]);
      }
      const ahead = daysBetween(body.today, body.examDate);
      if (ahead < 1 || ahead > STUDY_EXAM_MAX_DAYS_AHEAD) {
        throw validationFailed([
          { path: 'body.examDate', message: 'Must be after today and within a year' },
        ]);
      }
      const { days, truncated } = studyDays(body);
      if (days.length === 0) {
        throw validationFailed([
          { path: 'body.daysOff', message: 'No study day left before the exam' },
        ]);
      }
      const output = await callCoach(ctx, request.log, me, gate.model, {
        endpoint: 'study-plan',
        system: STUDY_PLAN_SYSTEM,
        user: studyPlanUserMessage(body, days, truncated),
        schema: StudyPlanOutput,
      });
      return studyPlanAnswer(output, body, days) ?? incompleteAnswer();
    },
  );

  app.post<{ Body: WeeklySummaryRequest; Reply: WeeklySummaryResponse }>(
    '/coach/weekly-summary',
    { bodyLimit: coachBody, config: coachLimit },
    async (request) => {
      const gate = await coachGate(ctx, request);
      const { me } = gate;
      const body = parseBody(WeeklySummarySchema, request);
      const range = isoWeekRange(body.week);
      if (!range) throw validationFailed([{ path: 'body.week', message: 'No such ISO week' }]);
      const today = localDayIn(gate.profile.timeZone, ctx.now());
      if (range.from > today) {
        throw validationFailed([{ path: 'body.week', message: 'The week has not started yet' }]);
      }

      let input: WeekInput;
      if (gate.profile.shareSync) {
        // Stats sync is on: the numbers come from the cloud copy; `stats` is ignored.
        input = await loadWeekFromCloud(
          requireDb(ctx),
          me.userId,
          body.week,
          range,
          gate.profile.dailyGoalMinutes,
        );
      } else {
        if (!body.stats) {
          throw validationFailed([
            { path: 'body.stats', message: 'Required while stats sync is off' },
          ]);
        }
        const outside = body.stats.days.findIndex((d) => d.day < range.from || d.day > range.to);
        if (outside >= 0) {
          throw validationFailed([
            { path: `body.stats.days.${outside}.day`, message: 'Must fall inside the week' },
          ]);
        }
        input = {
          week: body.week,
          from: range.from,
          to: range.to,
          days: [...body.stats.days].sort((a, b) => (a.day < b.day ? -1 : 1)),
          dailyGoalMinutes: body.stats.dailyGoalMinutes,
          previous: [],
        };
      }

      const output = await callCoach(ctx, request.log, me, gate.model, {
        endpoint: 'weekly-summary',
        system: WEEKLY_SUMMARY_SYSTEM,
        user: weeklyUserMessage(input),
        schema: WeeklySummaryOutput,
      });
      return weeklyAnswer(output) ?? incompleteAnswer();
    },
  );
};
