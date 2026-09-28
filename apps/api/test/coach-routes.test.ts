import type {
  CoachQuotaResponse,
  HealthResponse,
  StudyPlanResponse,
} from '@centrate/shared/cloud-api';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AI_KILL_SWITCH_KEY, costMicroUsd, tokensOf, worstCaseAttempts } from '../src/coach/budget';
import { CoachModelError } from '../src/coach/model';
import {
  INTERPRET_SYSTEM,
  SPLIT_TASK_SYSTEM,
  STUDY_PLAN_SYSTEM,
  WEEKLY_SUMMARY_SYSTEM,
} from '../src/coach/prompts';
import { anthropicUserHash, reserve, settle } from '../src/coach/quota';
import { ENDPOINTS, estimateInputTokens, SETTLE_MARGIN_MS } from '../src/coach/service';
import type { Config } from '../src/config';
import { aiGlobalDaily, aiUsage, dailyStats, devices, meta } from '../src/db/schema';
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

      // Every request counted; tokens settled or released; nothing held.
      const [row] = await usageRows(u.userId);
      expect(row?.requests).toBe(6);
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

    it('refuses a call whose worst case does not fit in the daily tokens', async () => {
      // A split task (worst case about 17 000 tokens with the fallback hop) fits; a study plan
      // (about 30 000) does not.
      await start({ AI_USER_DAILY_TOKENS: '25000' });
      const u = await person();
      model.script = () => ok(splitOutput);
      expect((await post(u, '/v1/coach/split-task', splitBody)).statusCode).toBe(200);
      const plan = await post(u, '/v1/coach/study-plan', planBody);
      expect(plan.statusCode).toBe(429);
      expect(plan.json().error.code).toBe('quota_exceeded');
      const quota = await app.inject({ method: 'GET', url: '/v1/coach/quota', headers: u.headers });
      expect(quota.json<CoachQuotaResponse>().coach).toEqual({
        requestsLeft: 9,
        tokensLeft: 25_000 - 1600,
      });
    });

    it('caps what one user can spend in a day, both buckets together', async () => {
      const u = await person();
      model.script = (request) =>
        request.feature === 'interpret'
          ? ok(interpretOutput, [attempt({ model: 'claude-haiku-4-5' })])
          : ok(splitOutput);
      // 0.30 USD already spent today: a split task's worst case (about 0.25 USD with the
      // fallback hop) no longer fits in the default 0.50 USD, a phrase (about 0.01) does.
      await t.db.insert(aiUsage).values({
        userId: u.userId,
        day: '2026-09-28',
        feature: 'coach',
        requests: 1,
        costMicroUsd: 300_000,
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
