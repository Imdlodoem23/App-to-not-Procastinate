/**
 * Coach through the Claude API (owner: COACH). docs/API.md §10. The Anthropic key never
 * leaves the backend; no prompt or answer text is stored or logged.
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
import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from '../lib/errors';

const coachLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const coachBody = 16 * 1024;

export const coachRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: CoachQuotaResponse }>('/coach/quota', async () => notImplemented());
  app.post<{ Body: InterpretRequest; Reply: InterpretResponse }>(
    '/coach/interpret',
    { bodyLimit: coachBody, config: coachLimit },
    async () => notImplemented(),
  );
  app.post<{ Body: SplitTaskRequest; Reply: SplitTaskResponse }>(
    '/coach/split-task',
    { bodyLimit: coachBody, config: coachLimit },
    async () => notImplemented(),
  );
  app.post<{ Body: StudyPlanRequest; Reply: StudyPlanResponse }>(
    '/coach/study-plan',
    { bodyLimit: coachBody, config: coachLimit },
    async () => notImplemented(),
  );
  app.post<{ Body: WeeklySummaryRequest; Reply: WeeklySummaryResponse }>(
    '/coach/weekly-summary',
    { bodyLimit: coachBody, config: coachLimit },
    async () => notImplemented(),
  );
};
