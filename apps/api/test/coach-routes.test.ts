import type {
  CoachQuotaResponse,
  HealthResponse,
  StudyPlanResponse,
} from '@centrate/shared/cloud-api';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BREAKER_OPEN_MS } from '../src/coach/breaker';
import { AI_KILL_SWITCH_KEY, costMicroUsd, tokensOf, worstCaseAttempts } from '../src/coach/budget';
import { CoachModelError } from '../src/coach/model';
import {
  INTERPRET_SYSTEM,
  SPLIT_TASK_SYSTEM,
  STUDY_PLAN_SYSTEM,
  WEEKLY_SUMMARY_SYSTEM,
} from '../src/coach/prompts';
import { largestWorstCase } from '../src/coach/endpoints';
import { aiIdentityHmac, anthropicUserHash, reserve, settle } from '../src/coach/quota';
import { ENDPOINTS, estimateInputTokens, SETTLE_MARGIN_MS } from '../src/coach/service';
import type { Config } from '../src/config';
import {
  aiGlobalDaily,
  aiIdentityDaily,
  aiUsage,
  dailyStats,
  devices,
  meta,
} from '../src/db/schema';
import {
  buildTestApp,
  createTestUser,
  fakeClock,
  testConfig,
  type CreateUserOptions,
  type FakeClock,
  type TestUser,
} from './helpers/app';
import { attempt, dumpAllTables, fakeCoachModel, ok, type FakeCoachModel } from './helpers/coach';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const KEY = 'sk-ant-test-routes-0000';
const env = (extra: Record<string, string> = {}) => ({ ANTHROPIC_API_KEY: KEY, ...extra });

const splitOutput = {
  steps: [
    {
      title: 'Leer el enunciado y subrayar lo que piden',
      minutes: 10,
      suggestedPhrase: 'estudiar enunciado 10 minutos',
    },
    {
      title: 'Hacer un esquema del trabajo',
      minutes: 25,
      suggestedPhrase: 'estudiar esquema del trabajo 20 minutos',
    },
  ],
  firstStepTip: 'Empieza leyendo solo el primer párrafo.',
};

const interpretOutput = {
  kind: 'block',
  serviceIds: ['youtube', 'instagram'],
  categoryIds: [],
  domains: [],
  durationMinutes: 75,
  untilTime: null,
  untilTomorrow: false,
  task: null,
  clarification: null,
};

describe('coach routes', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let model: FakeCoachModel;
  let config: Config;
  let logs: string[];

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  /** Builds the app for this test; call again to rebuild it with other variables. */
  let running = false;
  const start = async (extraEnv: Record<string, string> = {}, withModel = true) => {
    if (running) await app.close();
    running = true;
    config = testConfig(env(extraEnv));
    logs = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        logs.push(String(chunk));
        done();
      },
    });
    app = await buildTestApp({
      db: t.db,
      clock,
      config,
      coachModel: withModel ? model : null,
      logger: { stream },
    });
  };

  beforeEach(async () => {
    await resetDb(t.db);
    await t.db.delete(meta).where(eq(meta.key, AI_KILL_SWITCH_KEY));
    clock = fakeClock('2026-09-28T10:00:00.000Z');
    model = fakeCoachModel();
    await start();
  });
  afterEach(async () => {
    await app.close();
    running = false;
  });

  const person = (options: CreateUserOptions = {}): Promise<TestUser> =>
    createTestUser(t.db, { now: clock.now(), sharing: { coach: true }, ...options });

  const post = (who: TestUser, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload: payload as object });

  const interpretBody = (
    text = 'que no me deje entrar al youtube ni al insta en hora y cuarto',
  ) => ({
    text,
    timeZone: 'Europe/Madrid',
    now: clock.now().toISOString(),
  });
  const splitBody = {
    task: 'Trabajo de historia sobre la Revolución francesa',
    context: null,
    minutesAvailable: 45,
  };
  const planBody = {
    subject: 'Matemáticas',
    examDate: '2026-10-05',
    today: '2026-09-28',
    dailyMinutes: 60,
    topics: ['Derivadas', 'Integrales'],
    level: 'intermediate',
    daysOff: [7],
  };

  const usageRows = (userId: string) =>
    t.db.select().from(aiUsage).where(eq(aiUsage.userId, userId));

  describe('gates', () => {
    it('answers 503 feature_disabled without an Anthropic key', async () => {
      await app.close();
      app = await buildTestApp({ db: t.db, clock });
      expect(running).toBe(true);
      const u = await person();
      const routes: Array<[string, string]> = [
        ['GET', '/v1/coach/quota'],
        ['POST', '/v1/coach/interpret'],
        ['POST', '/v1/coach/split-task'],
        ['POST', '/v1/coach/study-plan'],
        ['POST', '/v1/coach/weekly-summary'],
      ];
      const anonymous = await app.inject({
        method: 'POST',
        url: '/v1/coach/split-task',
        payload: {},
      });
      expect(anonymous.statusCode).toBe(503);
      for (const [method, url] of routes) {
        const res = await app.inject({
          method: method as 'GET',
          url,
          headers: u.headers,
          payload: {},
        });
        expect(res.statusCode, url).toBe(503);
        expect(res.json().error).toMatchObject({
          code: 'feature_disabled',
          feature: 'coach',
          reason: 'missing_key',
        });
      }
    });

    it('needs sign-in and sharing.coach, except for the quota', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/v1/coach/split-task',
        payload: splitBody,
      });
      expect(anon.statusCode).toBe(401);

      const u = await person({ sharing: { coach: false } });
      for (const url of [
        '/v1/coach/interpret',
        '/v1/coach/split-task',
        '/v1/coach/study-plan',
        '/v1/coach/weekly-summary',
      ]) {
        const res = await post(u, url, {});
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'consent_required', consent: 'coach' });
      }
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.statusCode).toBe(200);
      expect(quota.json<CoachQuotaResponse>()).toEqual({
        interpret: { requestsLeft: 30 },
        coach: { requestsLeft: 10, tokensLeft: 150_000 },
        available: { interpret: true, splitTask: true, studyPlan: true, weeklySummary: true },
        resetsAt: '2026-09-29T00:00:00.000Z',
      });
      expect(model.calls).toHaveLength(0);
    });

    it('turns off with AI_ENABLED=false and with the database kill switch; health says so', async () => {
      const u = await person();
      await start({ AI_ENABLED: 'false' });
      let res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.json().error).toMatchObject({ code: 'feature_disabled', reason: 'kill_switch' });
      let health = (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>();
      expect(health.capabilities.coach).toEqual({ enabled: false, reason: 'kill_switch' });

      await start();
      await t.db.insert(meta).values({ key: AI_KILL_SWITCH_KEY, value: 'on' });
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({ code: 'feature_disabled', reason: 'kill_switch' });
      health = (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>();
      expect(health.capabilities.coach).toEqual({ enabled: false, reason: 'kill_switch' });
      // The quota says the same: the capability is off.
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.statusCode).toBe(503);
      expect(quota.json().error).toMatchObject({ code: 'feature_disabled', reason: 'kill_switch' });
      expect(model.calls).toHaveLength(0);

      await t.db.delete(meta).where(eq(meta.key, AI_KILL_SWITCH_KEY));
      model.script = () => ok(splitOutput);
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('interpret', () => {
    it('returns a canonical phrase from the fast model and records only counters', async () => {
      const u = await person();
      model.script = () => ok(interpretOutput, [attempt({ model: 'claude-haiku-4-5' })]);
      const res = await post(u, '/v1/coach/interpret', interpretBody());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        canonicalText: 'bloquear youtube y instagram durante 75 minutos',
        clarification: null,
      });

      const call = model.calls[0];
      expect(call).toMatchObject({
        feature: 'interpret',
        model: 'claude-haiku-4-5',
        maxTokens: 1024,
        effort: null,
        system: INTERPRET_SYSTEM,
        userHash: anthropicUserHash(config.auth?.secret ?? '', u.userId),
      });
      expect(call?.user).toContain('lunes, 28/09/2026, 12:00');
      expect(call?.user).toContain(
        '<frase>que no me deje entrar al youtube ni al insta en hora y cuarto</frase>',
      );

      const [row] = await usageRows(u.userId);
      expect(row).toMatchObject({
        day: '2026-09-28',
        feature: 'interpret',
        requests: 1,
        reservedTokens: 0,
        inputTokens: 1200,
        outputTokens: 400,
        costMicroUsd: 1200 + 2000,
      });
      const [global] = await t.db.select().from(aiGlobalDaily);
      expect(global).toMatchObject({ requests: 1, costMicroUsd: 3200, reservedMicroUsd: 0 });
      expect(logs.join('')).toContain('"coach":"interpret"');
    });

    it('rejects a clock far from the server, without spending quota', async () => {
      const u = await person();
      const res = await post(u, '/v1/coach/interpret', {
        ...interpretBody(),
        now: '2026-09-20T10:00:00.000Z',
      });
      expect(res.statusCode).toBe(400);
      expect(await usageRows(u.userId)).toHaveLength(0);
      expect(model.calls).toHaveLength(0);
    });

    it('asks back when the model cannot express the phrase', async () => {
      const u = await person();
      model.script = () =>
        ok({ ...interpretOutput, serviceIds: [], domains: ['facebook.com'] }, [
          attempt({ model: 'claude-haiku-4-5' }),
        ]);
      const res = await post(u, '/v1/coach/interpret', interpretBody('bloquea la web de caras'));
      expect(res.json().canonicalText).toBeNull();
      expect(res.json().clarification).toMatch(/^No he podido entender la frase/);
    });
  });

  describe('split-task', () => {
    it('calls the capable model with low effort and filters the one-tap phrases', async () => {
      const u = await person();
      model.script = () => ok(splitOutput);
      const res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        steps: [
          {
            title: 'Leer el enunciado y subrayar lo que piden',
            minutes: 10,
            suggestedPhrase: 'estudiar enunciado 10 minutos',
          },
          // 20 minutes in the phrase, 25 in the step: dropped.
          { title: 'Hacer un esquema del trabajo', minutes: 25, suggestedPhrase: null },
        ],
        firstStepTip: 'Empieza leyendo solo el primer párrafo.',
      });
      expect(model.calls[0]).toMatchObject({
        feature: 'coach',
        model: 'claude-opus-5',
        maxTokens: 4000,
        effort: 'low',
        system: SPLIT_TASK_SYSTEM,
        deadlineMs: 60_000,
      });
      expect(model.calls[0]?.inputTokensBound).toBe(
        estimateInputTokens(SPLIT_TASK_SYSTEM, model.calls[0]?.user ?? ''),
      );
      expect(model.calls[0]?.user).toContain(
        '<tarea>Trabajo de historia sobre la Revolución francesa</tarea>',
      );
      expect(model.calls[0]?.user).toContain('Tiempo disponible: 45 minutos.');
    });

    it('maps refusals, incomplete answers and provider failures', async () => {
      const u = await person();
      model.script = () => ({ kind: 'refused', attempts: [attempt({ outputTokens: 0 })] });
      let res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('coach_refused');

      model.script = () => ({ kind: 'incomplete', attempts: [attempt({ outputTokens: 4000 })] });
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('coach_incomplete');

      // A parsed answer that fails the server's checks (a single step) is also incomplete.
      model.script = () => ok({ ...splitOutput, steps: splitOutput.steps.slice(0, 1) });
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(502);

      model.script = () => {
        throw new CoachModelError('unavailable', 'RateLimitError', 429);
      };
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('coach_unavailable');

      model.script = () => {
        throw new CoachModelError('misconfigured', 'AuthenticationError', 401);
      };
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('coach_unavailable');
      expect(logs.join('')).toContain('coach model misconfigured');

      model.script = () => {
        throw new CoachModelError('rejected', 'BadRequestError', 400);
      };
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('internal_error');

      // The three answers stay counted; the three failures the provider certainly did not
      // run (429, 401 and 400 before the stream) give their request back. Nothing held.
      const [row] = await usageRows(u.userId);
      expect(row?.requests).toBe(3);
      expect(row?.reservedTokens).toBe(0);
      expect(row?.outputTokens).toBe(0 + 4000 + 400);
      const [global] = await t.db.select().from(aiGlobalDaily);
      expect(global?.reservedMicroUsd).toBe(0);
    });
  });

  describe('study-plan', () => {
    it('gives the model the exact days and returns a clamped plan', async () => {
      const u = await person();
      model.script = () =>
        ok({
          days: [
            {
              day: '2026-09-28',
              items: [
                { topic: 'Derivadas', kind: 'learn', minutes: 50 },
                { topic: 'Problemas', kind: 'practice', minutes: 50 },
              ],
            },
            { day: '2026-10-04', items: [{ topic: 'Domingo', kind: 'review', minutes: 30 }] },
          ],
          advice: ['Repasa un poco cada día.'],
        });
      const res = await post(u, '/v1/coach/study-plan', planBody);
      expect(res.statusCode).toBe(200);
      const plan = res.json<StudyPlanResponse>();
      expect(plan.days.map((d) => d.day)).toEqual(['2026-09-28']);
      expect(plan.days[0]?.items.reduce((sum, i) => sum + i.minutes, 0)).toBeLessThanOrEqual(60);
      expect(plan.advice).toEqual(['Repasa un poco cada día.']);
      expect(model.calls[0]).toMatchObject({
        model: 'claude-opus-5',
        maxTokens: 8000,
        effort: 'low',
        system: STUDY_PLAN_SYSTEM,
        deadlineMs: 80_000,
      });
      expect(model.calls[0]?.user).toContain('2026-10-03 (sábado)');
      expect(model.calls[0]?.user).not.toContain('2026-10-04');
      expect(plan).toMatchObject({ coversUntil: '2026-10-04', truncated: false });

      // A later exam gets the first four weeks, and the app learns it must ask for the rest.
      const far = await post(u, '/v1/coach/study-plan', { ...planBody, examDate: '2026-12-20' });
      expect(far.statusCode).toBe(200);
      expect(far.json<StudyPlanResponse>()).toMatchObject({
        coversUntil: '2026-10-25',
        truncated: true,
      });
      expect(model.calls[1]?.user).toContain('2026-10-24 (sábado)');
      expect(model.calls[1]?.user).not.toContain('2026-10-26');
    });

    it('validates dates before spending anything', async () => {
      const u = await person();
      const bad = [
        { ...planBody, examDate: '2026-09-28' },
        { ...planBody, today: '2026-09-20' },
        { ...planBody, examDate: '2028-01-01' },
        { ...planBody, examDate: '2026-09-29', daysOff: [1] },
        { ...planBody, daysOff: [1, 1] },
        { ...planBody, topics: ['x'.repeat(81)] },
      ];
      for (const body of bad) {
        const res = await post(u, '/v1/coach/study-plan', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().error.code).toBe('validation_failed');
      }
      expect(model.calls).toHaveLength(0);
    });
  });

  describe('weekly-summary', () => {
    const week = '2026-W40';
    const summary = {
      headline: 'Buena semana',
      highlights: ['Constancia'],
      suggestion: 'Sigue así.',
    };
    const day = (d: string, focus: number) => ({
      day: d,
      focusMinutes: focus,
      studyMinutes: 0,
      blocksCompleted: 1,
      studySessions: 0,
      attempts: 2,
      emergencyUnlocks: 0,
      punishments: 0,
      pointsEarned: 10,
      pointsLost: 5,
    });

    it('uses the numbers the app sends while sync is off, and never a future week', async () => {
      const u = await person();
      model.script = () => ok(summary);
      let res = await post(u, '/v1/coach/weekly-summary', { week, stats: null });
      expect(res.statusCode).toBe(400);
      res = await post(u, '/v1/coach/weekly-summary', {
        week,
        stats: { days: [day('2026-10-05', 30)], dailyGoalMinutes: null },
      });
      expect(res.statusCode).toBe(400);
      res = await post(u, '/v1/coach/weekly-summary', {
        week: '2026-W41',
        stats: { days: [], dailyGoalMinutes: null },
      });
      expect(res.statusCode).toBe(400);
      expect(model.calls).toHaveLength(0);

      res = await post(u, '/v1/coach/weekly-summary', {
        week,
        stats: { days: [day('2026-09-28', 90)], dailyGoalMinutes: 60 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(summary);
      expect(model.calls[0]?.system).toBe(WEEKLY_SUMMARY_SYSTEM);
      expect(model.calls[0]?.user).toContain('lunes 28/09: concentración 90 min');
      expect(model.calls[0]?.user).toContain('Semanas anteriores: sin datos.');
    });

    it('reads the cloud copy while sync is on, summing devices with the daily cap', async () => {
      const u = await person({ sharing: { coach: true, syncStats: true }, dailyGoalMinutes: 60 });
      const [a, b] = await t.db
        .insert(devices)
        .values(
          ['a', 'b'].map((k) => ({
            userId: u.userId,
            installId: `install-${k}-0123456789`,
            name: `PC ${k}`,
            platform: 'win' as const,
            appVersion: '1.0.0',
          })),
        )
        .returning({ id: devices.id });
      const row = (deviceId: string, d: string, focus: number) => ({
        deviceId,
        userId: u.userId,
        rev: 1,
        ...day(d, focus),
      });
      await t.db
        .insert(dailyStats)
        .values([
          row(a?.id ?? '', '2026-09-29', 900),
          row(b?.id ?? '', '2026-09-29', 900),
          row(a?.id ?? '', '2026-09-15', 45),
        ]);
      model.script = () => ok(summary);
      const res = await post(u, '/v1/coach/weekly-summary', { week, stats: null });
      expect(res.statusCode).toBe(200);
      const message = model.calls[0]?.user ?? '';
      expect(message).toContain('martes 29/09: concentración 1440 min');
      expect(message).toContain('2 bloqueos completados');
      expect(message).toContain('Objetivo diario: 60 minutos');
      expect(message).toContain('- 2026-W38: concentración 45 min');
    });
  });

  describe('quotas and budget', () => {
    it('answers 429 quota_exceeded with resetsAt after the daily requests, until 00:00 UTC', async () => {
      await start({ AI_USER_DAILY_INTERPRET_REQUESTS: '2' });
      const u = await person();
      model.script = () => ok(interpretOutput, [attempt({ model: 'claude-haiku-4-5' })]);
      expect((await post(u, '/v1/coach/interpret', interpretBody())).statusCode).toBe(200);
      expect((await post(u, '/v1/coach/interpret', interpretBody())).statusCode).toBe(200);
      const third = await post(u, '/v1/coach/interpret', interpretBody());
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toMatchObject({
        code: 'quota_exceeded',
        resetsAt: '2026-09-29T00:00:00.000Z',
      });
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.json<CoachQuotaResponse>().interpret.requestsLeft).toBe(0);
      expect(quota.json<CoachQuotaResponse>().coach.tokensLeft).toBe(150_000 - 2 * 1600);

      clock.set('2026-09-29T00:00:01.000Z');
      const nextDay = await post(u, '/v1/coach/interpret', interpretBody());
      expect(nextDay.statusCode).toBe(200);
      expect(model.calls).toHaveLength(3);
    });

    it('refuses a call whose first hop does not fit in the daily tokens', async () => {
      // The user's caps need room for the first hop only: a split task (about 6 400 tokens:
      // its input as cache writes plus 4 000 of output) fits; after it (1 600 tokens settled)
      // a study plan (about 10 500) does not.
      await start({ AI_USER_DAILY_TOKENS: '11000' });
      expect(largestWorstCase(config, 'split-task').capTokens).toBeLessThan(11_000 - 1600);
      const u = await person();
      model.script = () => ok(splitOutput);
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      const plan = await post(u, '/v1/coach/study-plan', planBody);
      expect(plan.statusCode).toBe(429);
      expect(plan.json().error.code).toBe('quota_exceeded');
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.json<CoachQuotaResponse>()).toMatchObject({
        coach: { requestsLeft: 9, tokensLeft: 11_000 - 1600 },
        available: { interpret: true, splitTask: true, studyPlan: false, weeklySummary: true },
      });
    });

    it('caps what one user can spend in a day, both buckets together', async () => {
      const u = await person();
      model.script = (request) =>
        request.feature === 'interpret'
          ? ok(interpretOutput, [attempt({ model: 'claude-haiku-4-5' })])
          : ok(splitOutput);
      // 0.40 USD already spent today: a split task's first hop (about 0.11 USD) no longer fits
      // in the default 0.50 USD, a phrase (about 0.01) does.
      await t.db.insert(aiUsage).values({
        userId: u.userId,
        day: '2026-09-28',
        feature: 'coach',
        requests: 1,
        costMicroUsd: 400_000,
      });
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.json<CoachQuotaResponse>()).toMatchObject({
        coach: { requestsLeft: 9 },
        available: { interpret: true, splitTask: false, studyPlan: false, weeklySummary: false },
      });
      const split = await post(u, '/v1/coach/split-task', splitBody);
      expect(split.statusCode).toBe(429);
      expect(split.json().error).toMatchObject({
        code: 'quota_exceeded',
        resetsAt: '2026-09-29T00:00:00.000Z',
      });
      expect((await post(u, '/v1/coach/interpret', interpretBody())).statusCode).toBe(200);
      expect(model.calls.map((c) => c.feature)).toEqual(['interpret']);
      // Someone else still has their whole share.
      const other = await person();
      expect((await post(other, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
    });

    const planOutput = {
      days: [{ day: '2026-09-28', items: [{ topic: 'Derivadas', kind: 'learn', minutes: 50 }] }],
      advice: ['Repasa un poco cada día.'],
    };
    /** What an ordinary split task bills on Opus 5: about 0.045 USD. */
    const typicalSplit = attempt({ cacheWriteTokens: 900, inputTokens: 300, outputTokens: 1500 });
    /** An ordinary study plan: about 0.15 USD. */
    const typicalPlan = attempt({ cacheWriteTokens: 3000, inputTokens: 500, outputTokens: 5000 });

    it('keeps study plans within reach after an ordinary day (the fallback hop is not capped)', async () => {
      const u = await person();
      model.script = (request) =>
        request.maxTokens === ENDPOINTS['study-plan'].maxTokens
          ? ok(planOutput, [typicalPlan])
          : ok(splitOutput, [typicalSplit]);
      // A study plan's whole worst case (about 0.49 USD with the fallback hop) would not fit
      // next to one split task under the default 0.50 USD; its first hop (about 0.21) does.
      const worst = largestWorstCase(config, 'study-plan');
      expect(worst.costMicroUsd).toBeGreaterThan(500_000 - costMicroUsd([typicalSplit]));
      expect(worst.capMicroUsd).toBeLessThan(250_000);

      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      expect((await post(u, '/v1/coach/study-plan', planBody)).statusCode).toBe(200);
      expect((await post(u, '/v1/coach/study-plan', planBody)).statusCode).toBe(200);
      const quota = async () =>
        (
          await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers })
        ).json<CoachQuotaResponse>();
      expect(await quota()).toMatchObject({
        coach: { requestsLeft: 7 },
        available: { interpret: true, splitTask: true, studyPlan: false, weeklySummary: true },
      });
      // Spent about 0.34 USD: the quota says a third plan will not fit, and it does not.
      const third = await post(u, '/v1/coach/study-plan', planBody);
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('quota_exceeded');
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      const [row] = await usageRows(u.userId);
      expect(row?.costMicroUsd).toBe(
        2 * costMicroUsd([typicalSplit]) + 2 * costMicroUsd([typicalPlan]),
      );
    });

    it('holds the whole worst case until the call settles, checking only the first hop', async () => {
      const u = await person();
      const cfg = testConfig(env());
      await t.db.insert(aiUsage).values({
        userId: u.userId,
        day: '2026-09-28',
        feature: 'interpret',
        requests: 1,
        costMicroUsd: 200_000,
      });
      // 0.20 + 0.49 is over the 0.50 cap, 0.20 + 0.22 is not.
      const r = await reserve(t.db, cfg, {
        userId: u.userId,
        feature: 'coach',
        now: clock.now(),
        tokens: 30_000,
        costMicroUsd: 490_000,
        capTokens: 11_000,
        capMicroUsd: 220_000,
        holdMs: 90_000,
      });
      if (!r.ok) throw new Error(`expected a reservation, got ${r.reason}`);
      const coach = (await usageRows(u.userId)).find((x) => x.feature === 'coach');
      expect(coach).toMatchObject({ reservedTokens: 30_000, reservedMicroUsd: 490_000 });
      expect((await t.db.select().from(aiGlobalDaily))[0]?.reservedMicroUsd).toBe(490_000);
      // A first hop above the cap on its own can never run.
      expect(
        await reserve(t.db, cfg, {
          userId: u.userId,
          feature: 'interpret',
          now: clock.now(),
          tokens: 100,
          costMicroUsd: 10,
          capMicroUsd: 500_001,
          holdMs: 20_000,
        }),
      ).toEqual({ ok: false, reason: 'budget' });
      await settle(t.db, r.reservation, [typicalPlan], costMicroUsd([typicalPlan]));
      expect((await t.db.select().from(aiGlobalDaily))[0]).toMatchObject({
        reservedMicroUsd: 0,
        costMicroUsd: costMicroUsd([typicalPlan]),
      });
    });

    it('counts the day per mailbox: a new account on the same address starts where it was', async () => {
      await start({ AI_USER_DAILY_COACH_REQUESTS: '2' });
      model.script = () => ok(splitOutput, [typicalSplit]);
      const ana = await person({ email: 'ana.garcia@gmail.com' });
      expect((await post(ana, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      expect((await post(ana, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      expect((await post(ana, '/v1/coach/split-task', splitBody)).statusCode).toBe(429);

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: ana.headers,
        payload: { confirm: 'BORRAR' },
      });
      expect(deleted.statusCode).toBe(204);
      expect(await usageRows(ana.userId)).toHaveLength(0);

      // The same mailbox, as the same address or another spelling of it: still used up.
      for (const email of ['ana.garcia@gmail.com', 'AnaGarcia+coach@googlemail.com']) {
        const again = await person({ email });
        const res = await post(again, '/v1/coach/split-task', splitBody);
        expect(res.statusCode, email).toBe(429);
        expect(res.json().error).toMatchObject({
          code: 'quota_exceeded',
          resetsAt: '2026-09-29T00:00:00.000Z',
        });
        const quota = await app.inject({
          method: 'GET',
          url: '/v1/coach/quota',
          headers: again.headers,
        });
        expect(quota.json<CoachQuotaResponse>()).toMatchObject({
          coach: { requestsLeft: 0, tokensLeft: 150_000 - 2 * tokensOf([typicalSplit]) },
          available: { interpret: true, splitTask: false, studyPlan: false },
        });
      }
      expect(model.calls).toHaveLength(2);
      // The mailbox's counters hold numbers and an HMAC, never the address or an account id.
      const rows = await t.db.select().from(aiIdentityDaily);
      expect(rows).toEqual([
        {
          day: '2026-09-28',
          identityHmac: aiIdentityHmac(config.auth?.secret ?? '', 'ana.garcia@gmail.com'),
          feature: 'coach',
          requests: 2,
          tokens: 2 * tokensOf([typicalSplit]),
          costMicroUsd: 2 * costMicroUsd([typicalSplit]),
        },
      ]);
      const stored = JSON.stringify(rows);
      for (const secret of ['ana.garcia@gmail.com', 'anagarcia@gmail.com', ana.userId]) {
        expect(stored).not.toContain(secret);
      }

      // Another mailbox has its own day, and the next UTC day starts over.
      expect((await post(await person(), '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      clock.set('2026-09-29T00:00:01.000Z');
      const tomorrow = await person({ email: 'ana.garcia+manana@gmail.com' });
      expect((await post(tomorrow, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
    });

    it('spends the mailbox’s cap once across its accounts', async () => {
      const first = await person({ email: 'luis@example.com' });
      const second = await person({ email: 'Luis+2@Example.com' });
      model.script = () => ok(splitOutput, [typicalPlan]);
      // Each call settles about 0.15 USD; a split task needs about 0.11 of room.
      let accepted = 0;
      for (const who of [first, second, first, second]) {
        const res = await post(who, '/v1/coach/split-task', splitBody);
        if (res.statusCode === 200) accepted += 1;
        else expect(res.json().error.code).toBe('quota_exceeded');
      }
      expect(accepted).toBe(3);
      const [row] = await t.db.select().from(aiIdentityDaily);
      expect(row?.costMicroUsd).toBe(3 * costMicroUsd([typicalPlan]));
    });

    it('lets exactly N of many parallel calls through', async () => {
      await start({ AI_USER_DAILY_COACH_REQUESTS: '5' });
      const u = await person();
      model.script = () => ok(splitOutput);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post(u, '/v1/coach/split-task', splitBody)),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
      expect(model.calls).toHaveLength(5);
    });

    const input = (userId: string, extra: Partial<Parameters<typeof reserve>[2]> = {}) => ({
      userId,
      feature: 'coach' as const,
      now: clock.now(),
      tokens: 100,
      costMicroUsd: 10,
      holdMs: 90_000,
      ...extra,
    });

    it('reserves atomically, one call in flight per user and feature', async () => {
      const u = await person();
      const cfg = testConfig(env({ AI_USER_DAILY_COACH_REQUESTS: '10' }));
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => reserve(t.db, cfg, input(u.userId))),
      );
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      for (const o of outcomes.filter((o) => !o.ok)) {
        expect(o).toEqual({ ok: false, reason: 'busy', retryAfterMs: 90_000 });
      }
      // The other bucket is independent.
      expect((await reserve(t.db, cfg, input(u.userId, { feature: 'interpret' }))).ok).toBe(true);

      // One after another, the request limit holds exactly.
      const first = outcomes.find((o) => o.ok);
      if (!first?.ok) throw new Error('unreachable');
      await settle(t.db, first.reservation, [], 0);
      let granted = 1;
      for (let i = 0; i < 12; i += 1) {
        const r = await reserve(t.db, cfg, input(u.userId));
        if (!r.ok) {
          expect(r).toMatchObject({ reason: 'quota' });
          continue;
        }
        granted += 1;
        await settle(t.db, r.reservation, [], 0);
      }
      expect(granted).toBe(10);
      const rows = await usageRows(u.userId);
      expect(rows.find((r) => r.feature === 'coach')).toMatchObject({
        requests: 10,
        reservedTokens: 0,
        reservedMicroUsd: 0,
        reservedUntil: null,
      });
    });

    it('answers 429 rate_limited while the same user has a coach call running', async () => {
      const u = await person();
      let finish: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      model.script = async () => {
        await gate;
        return ok(splitOutput);
      };
      const first = post(u, '/v1/coach/split-task', splitBody);
      // Wait until the first call is at the model.
      while (model.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
      const second = await post(u, '/v1/coach/split-task', splitBody);
      expect(second.statusCode).toBe(429);
      expect(second.json().error).toMatchObject({
        code: 'rate_limited',
        retryAfterSeconds: (ENDPOINTS['split-task'].deadlineMs + SETTLE_MARGIN_MS) / 1000,
      });
      expect(second.headers['retry-after']).toBe('90');
      // Other people are not held up.
      const other = await person();
      const otherCall = post(other, '/v1/coach/split-task', splitBody);
      while (model.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
      finish();
      expect((await first).statusCode).toBe(200);
      expect((await otherCall).statusCode).toBe(200);
      model.script = () => ok(splitOutput);
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      const [row] = await usageRows(u.userId);
      // The refused call is not counted.
      expect(row).toMatchObject({ requests: 2, reservedTokens: 0, reservedUntil: null });
    });

    it('answers busy, not quota, when only the other call in flight is in the way', async () => {
      const u = await person();
      const cfg = testConfig(env({ AI_USER_DAILY_BUDGET_USD: '0.1' }));
      const interpret = await reserve(
        t.db,
        cfg,
        input(u.userId, { feature: 'interpret', costMicroUsd: 30_000, holdMs: 20_000 }),
      );
      expect(interpret.ok).toBe(true);
      // 80 000 fits in 100 000 once the phrase settles, but not next to its 30 000: busy
      // (retryable), not quota (until tomorrow).
      const coach = await reserve(t.db, cfg, input(u.userId, { costMicroUsd: 80_000 }));
      expect(coach).toEqual({ ok: false, reason: 'busy', retryAfterMs: 20_000 });
      // The phrase settles at 50 000: now 80 000 does not fit at all.
      if (!interpret.ok) throw new Error('unreachable');
      await settle(t.db, interpret.reservation, [attempt({ model: 'claude-haiku-4-5' })], 50_000);
      expect(await reserve(t.db, cfg, input(u.userId, { costMicroUsd: 80_000 }))).toMatchObject({
        reason: 'quota',
      });
      // A call that can never fit under the cap is a configuration problem.
      expect(await reserve(t.db, cfg, input(u.userId, { costMicroUsd: 100_001 }))).toEqual({
        ok: false,
        reason: 'budget',
      });
    });

    it('stops blocking after a reservation that never settled, but keeps its amounts', async () => {
      const u = await person();
      const cfg = testConfig(env());
      const lost = await reserve(t.db, cfg, input(u.userId, { costMicroUsd: 200_000 }));
      expect(lost.ok).toBe(true);
      // The process died: nothing settles it. Until its hold ends the user waits.
      expect(await reserve(t.db, cfg, input(u.userId))).toMatchObject({ reason: 'busy' });
      clock.advance(90_001);
      // The spend cap still counts the lost 0.20 USD: 0.35 more does not fit in 0.50.
      expect(
        await reserve(t.db, cfg, input(u.userId, { now: clock.now(), costMicroUsd: 350_000 })),
      ).toMatchObject({ reason: 'quota' });
      const next = await reserve(t.db, cfg, input(u.userId, { now: clock.now() }));
      if (!next.ok) throw new Error('expected a reservation');
      await settle(t.db, next.reservation, [attempt()], 16_000);
      const [row] = await usageRows(u.userId);
      expect(row).toMatchObject({
        requests: 2,
        reservedTokens: 100,
        reservedMicroUsd: 200_000,
        reservedUntil: null,
        costMicroUsd: 16_000,
      });
      // A late settle of the lost call frees its amounts without touching a newer call.
      const newer = await reserve(t.db, cfg, input(u.userId, { now: clock.now() }));
      if (!newer.ok || !lost.ok) throw new Error('expected reservations');
      await settle(t.db, lost.reservation, [], 0);
      const [after] = await usageRows(u.userId);
      expect(after).toMatchObject({
        reservedTokens: 100,
        reservedMicroUsd: 10,
        reservedUntil: newer.reservation.until,
      });
    });

    it('books what a failed call may have cost', async () => {
      const u = await person();
      const [row0] = await usageRows(u.userId);
      expect(row0).toBeUndefined();
      const hop = attempt({ model: 'claude-opus-5', inputTokens: 900, outputTokens: 4000 });
      model.script = () => {
        throw new CoachModelError('unavailable', 'APIUserAbortError', null, {
          billing: 'bound',
          attempts: [hop],
        });
      };
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(503);
      let [row] = await usageRows(u.userId);
      expect(row).toMatchObject({
        costMicroUsd: costMicroUsd([hop]),
        outputTokens: 4000,
        reservedMicroUsd: 0,
      });

      // Certainly not billed (429 before any output): nothing.
      model.script = () => {
        throw new CoachModelError('unavailable', 'RateLimitError', 429);
      };
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(503);
      [row] = await usageRows(u.userId);
      expect(row?.costMicroUsd).toBe(costMicroUsd([hop]));

      // Anything unexpected: the whole reservation, fallback hop included.
      model.script = () => {
        throw new Error('boom');
      };
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(500);
      [row] = await usageRows(u.userId);
      const user = model.calls[2]?.user ?? '';
      const worst = worstCaseAttempts(
        'claude-opus-5',
        estimateInputTokens(SPLIT_TASK_SYSTEM, user),
        4000,
      );
      expect(row?.costMicroUsd).toBe(costMicroUsd([hop]) + costMicroUsd(worst));
      // Both hops' input as cache writes: all tokens but the two outputs.
      expect(row?.cacheWriteTokens).toBe(tokensOf(worst) - 2 * 4000 + hop.cacheWriteTokens);
      const [global] = await t.db.select().from(aiGlobalDaily);
      expect(global).toMatchObject({ costMicroUsd: row?.costMicroUsd, reservedMicroUsd: 0 });
      expect(logs.join('')).toContain('"outcome":"failed_unexpected"');
    });

    it('stops at the global daily budget and health reports it', async () => {
      await start({ AI_GLOBAL_DAILY_BUDGET_USD: '1' });
      const u = await person();
      model.script = () => ok(splitOutput);
      await t.db.insert(aiGlobalDaily).values({ day: '2026-09-28', costMicroUsd: 999_000 });
      const res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        code: 'feature_disabled',
        feature: 'coach',
        reason: 'budget',
      });
      expect(model.calls).toHaveLength(0);
      expect(await usageRows(u.userId)).toHaveLength(0);

      // Amounts held by calls in flight do not switch the coach off in /health…
      await t.db
        .update(aiGlobalDaily)
        .set({ costMicroUsd: 100_000, reservedMicroUsd: 900_000 })
        .where(eq(aiGlobalDaily.day, '2026-09-28'));
      let health = (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>();
      expect(health.capabilities.coach).toEqual({ enabled: true, reason: null });

      // …settled spend does.
      await t.db
        .update(aiGlobalDaily)
        .set({ costMicroUsd: 1_000_000, reservedMicroUsd: 0 })
        .where(eq(aiGlobalDaily.day, '2026-09-28'));
      clock.advance(60_000);
      health = (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>();
      expect(health.capabilities.coach).toEqual({ enabled: false, reason: 'budget' });
    });

    const health = async () =>
      (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>().capabilities
        .coach;
    const quotaOf = async (who: TestUser) =>
      (
        await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: who.headers })
      ).json<CoachQuotaResponse>();

    it('answers 429 rate_limited, not budget, while only calls in flight fill the global budget', async () => {
      const plan = largestWorstCase(config, 'study-plan');
      const holdMs = ENDPOINTS['study-plan'].deadlineMs + SETTLE_MARGIN_MS;
      // Four other people each have a study plan in flight: their whole worst cases (about
      // 0.50 USD each, fallback hop included) hold nearly all of the default 2 USD.
      const held = [];
      for (let i = 0; i < 4; i += 1) {
        const other = await person();
        const r = await reserve(t.db, config, {
          userId: other.userId,
          feature: 'coach',
          now: clock.now(),
          tokens: plan.tokens,
          costMicroUsd: plan.costMicroUsd,
          capTokens: plan.capTokens,
          capMicroUsd: plan.capMicroUsd,
          holdMs,
        });
        if (!r.ok) throw new Error(`expected a reservation, got ${r.reason}`);
        held.push(r.reservation);
      }
      const split = largestWorstCase(config, 'split-task').costMicroUsd;
      expect(4 * plan.costMicroUsd + split).toBeGreaterThan(2_000_000);

      const u = await person();
      model.script = () => ok(splitOutput);
      let res = await post(u, '/v1/coach/split-task', splitBody);
      // Retryable: the holds come back within their calls' deadlines. Not 503 budget, which
      // the app reads as «spent until 00:00 UTC».
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
      expect(res.headers['retry-after']).toBe('30');
      expect(model.calls).toHaveLength(0);
      expect(await usageRows(u.userId)).toHaveLength(0);
      // Nothing is spent yet: the coach stays on and every action stays available.
      expect(await health()).toEqual({ enabled: true, reason: null });
      expect((await quotaOf(u)).available).toEqual({
        interpret: true,
        splitTask: true,
        studyPlan: true,
        weeklySummary: true,
      });

      // Near the end of the holds the wait is until the first one ends.
      clock.advance(holdMs - 12_000);
      res = await post(u, '/v1/coach/split-task', splitBody);
      expect(res.json().error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 12 });

      // One plan settles at what it really cost: there is room again.
      const [first] = held;
      if (!first) throw new Error('unreachable');
      await settle(t.db, first, [typicalPlan], costMicroUsd([typicalPlan]));
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      const [global] = await t.db.select().from(aiGlobalDaily);
      expect(global).toMatchObject({
        requests: 5,
        reservedMicroUsd: 3 * plan.costMicroUsd,
        costMicroUsd: costMicroUsd([typicalPlan]) + costMicroUsd([attempt()]),
      });
    });

    it('answers 503 budget per endpoint once settled spend leaves it no room, as the quota says', async () => {
      const u = await person();
      model.script = () => ok(splitOutput);
      // Settled today: exactly the room for a split task's largest whole worst case (about
      // 0.26 USD), less than a weekly summary's (a little more) or any study plan's (0.4+).
      const split = largestWorstCase(config, 'split-task').costMicroUsd;
      expect(largestWorstCase(config, 'weekly-summary').costMicroUsd).toBeGreaterThan(split);
      await t.db
        .insert(aiGlobalDaily)
        .values({ day: '2026-09-28', costMicroUsd: 2_000_000 - split });

      expect((await quotaOf(u)).available).toEqual({
        interpret: true,
        splitTask: true,
        studyPlan: false,
        weeklySummary: false,
      });
      expect(await health()).toEqual({ enabled: true, reason: null });
      const res = await post(u, '/v1/coach/study-plan', planBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        code: 'feature_disabled',
        feature: 'coach',
        reason: 'budget',
      });
      expect(model.calls).toHaveLength(0);
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);

      // Settled spend at the budget: nothing fits, and /health turns the coach off.
      await t.db
        .update(aiGlobalDaily)
        .set({ costMicroUsd: 2_000_000 })
        .where(eq(aiGlobalDaily.day, '2026-09-28'));
      expect((await quotaOf(u)).available).toEqual({
        interpret: false,
        splitTask: false,
        studyPlan: false,
        weeklySummary: false,
      });
      clock.advance(60_000);
      expect(await health()).toEqual({ enabled: false, reason: 'budget' });
    });
  });

  describe('breaker', () => {
    const health = async () =>
      (await app.inject({ method: 'GET', url: '/health' })).json<HealthResponse>().capabilities
        .coach;
    const quota = (who: TestUser) =>
      app.inject({ method: 'GET', url: '/v1/coach/quota', headers: who.headers });
    const fail = (reason: 'misconfigured' | 'rejected' | 'unavailable', status: number) => () => {
      throw new CoachModelError(reason, 'APIError', status);
    };

    it('switches the coach off for 15 minutes after repeated account failures', async () => {
      const [a, b, c] = [await person(), await person(), await person()];
      if (!a || !b || !c) throw new Error('unreachable');
      // No credit left (402): every call fails the same way until the owner acts.
      model.script = fail('misconfigured', 402);
      for (const who of [a, b]) {
        const res = await post(who, '/v1/coach/split-task', splitBody);
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('coach_unavailable');
      }
      expect(await health()).toEqual({ enabled: true, reason: null });
      expect((await post(c, '/v1/coach/interpret', interpretBody())).statusCode).toBe(503);
      expect(logs.join('')).toContain('coach breaker open');

      // Open: /health says so, and no route calls the model.
      expect(await health()).toEqual({ enabled: false, reason: 'kill_switch' });
      const off = { code: 'feature_disabled', feature: 'coach', reason: 'kill_switch' };
      let res = await post(a, '/v1/coach/study-plan', planBody);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject(off);
      res = await quota(a);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject(off);
      expect(model.calls).toHaveLength(3);
      // None of it cost anyone a request.
      for (const who of [a, b, c]) {
        for (const row of await usageRows(who.userId)) expect(row.requests).toBe(0);
      }

      // 15 minutes later one call goes through; one more failure opens it again at once.
      clock.advance(BREAKER_OPEN_MS);
      expect(await health()).toEqual({ enabled: true, reason: null });
      expect((await post(a, '/v1/coach/split-task', splitBody)).statusCode).toBe(503);
      expect(model.calls).toHaveLength(4);
      expect(await health()).toEqual({ enabled: false, reason: 'kill_switch' });

      // Once the owner fixed it, an answer ends the streak: one more failure does not open it.
      clock.advance(BREAKER_OPEN_MS);
      model.script = () => ok(splitOutput);
      expect((await post(a, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      model.script = fail('misconfigured', 401);
      expect((await post(b, '/v1/coach/split-task', splitBody)).statusCode).toBe(503);
      expect(await health()).toEqual({ enabled: true, reason: null });
      expect((await quota(b)).statusCode).toBe(200);
    });

    it('counts one rejected call per user, and passing outages not at all', async () => {
      const [a, b, c] = [await person(), await person(), await person()];
      if (!a || !b || !c) throw new Error('unreachable');
      // A 400 may come from the request itself: one person alone cannot open the breaker.
      model.script = fail('rejected', 400);
      for (let i = 0; i < 4; i += 1) {
        const res = await post(a, '/v1/coach/split-task', splitBody);
        expect(res.statusCode).toBe(500);
        expect(res.json().error.code).toBe('internal_error');
      }
      expect(await health()).toEqual({ enabled: true, reason: null });
      // An overloaded API neither adds to the streak nor ends it.
      model.script = fail('unavailable', 529);
      expect((await post(b, '/v1/coach/split-task', splitBody)).statusCode).toBe(503);
      model.script = fail('rejected', 400);
      expect((await post(b, '/v1/coach/split-task', splitBody)).statusCode).toBe(500);
      expect(await health()).toEqual({ enabled: true, reason: null });
      // A third person hits it too: it is the account, not a request.
      expect((await post(c, '/v1/coach/split-task', splitBody)).statusCode).toBe(500);
      expect(await health()).toEqual({ enabled: false, reason: 'kill_switch' });
    });
  });

  describe('privacy', () => {
    it('stores and logs no prompt or answer text', async () => {
      const u = await person({ sharing: { coach: true } });
      const secrets = {
        task: 'Redactar el TFG sobre abejas melíferas',
        context: 'Mi tutora se llama Remedios',
        phrase: 'bloquéame lo de las zapatillas moradas',
        subject: 'Paleontología cuántica',
        answer: 'Paso clandestino número uno',
        tip: 'Consejo irrepetible',
      };
      model.script = (request) => {
        if (request.feature === 'interpret') {
          return ok(
            { ...interpretOutput, kind: 'unclear', serviceIds: [], clarification: secrets.tip },
            [attempt({ model: 'claude-haiku-4-5' })],
          );
        }
        if (request.system === SPLIT_TASK_SYSTEM) {
          return ok({
            steps: [
              { title: secrets.answer, minutes: 10, suggestedPhrase: null },
              { title: 'Otro paso', minutes: 10, suggestedPhrase: null },
            ],
            firstStepTip: secrets.tip,
          });
        }
        return ok({
          days: [
            { day: '2026-09-28', items: [{ topic: secrets.answer, kind: 'learn', minutes: 30 }] },
          ],
          advice: [secrets.tip],
        });
      };
      expect((await post(u, '/v1/coach/interpret', interpretBody(secrets.phrase))).statusCode).toBe(
        200,
      );
      expect(
        (
          await post(u, '/v1/coach/split-task', {
            ...splitBody,
            task: secrets.task,
            context: secrets.context,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await post(u, '/v1/coach/study-plan', { ...planBody, subject: secrets.subject }))
          .statusCode,
      ).toBe(200);

      const everything = await dumpAllTables(t.db);
      const log = logs.join('');
      for (const value of Object.values(secrets)) {
        expect(everything).not.toContain(value);
        expect(log).not.toContain(value);
      }
      expect(log).not.toContain(KEY);
      expect(log).not.toContain(u.token);
      // Cost logging: one line per call with token counts.
      expect(log.match(/"msg":"coach call"/g)).toHaveLength(3);
      expect(log).toContain('"costMicroUsd"');
      const rows = await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(aiUsage)
        .where(and(eq(aiUsage.userId, u.userId), eq(aiUsage.reservedTokens, 0)));
      expect(rows[0]?.n).toBe(2);
    });
  });
});
