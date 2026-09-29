/**
 * The real `@anthropic-ai/sdk` client against a local fake of the streaming Messages API: the
 * request shape (models, cached system prompt, max_tokens, fallback beta, metadata.user_id),
 * the answer handling, the error mapping, the one retry and what failed calls are billed, end
 * to end through the routes.
 */
import type { FastifyInstance } from 'fastify';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAnthropicCoachModel, SERVER_FALLBACK_BETA } from '../src/coach/anthropic';
import { costMicroUsd } from '../src/coach/budget';
import { largestWorstCase } from '../src/coach/endpoints';
import { CoachModelError } from '../src/coach/model';
import { INTERPRET_SYSTEM, SPLIT_TASK_SYSTEM } from '../src/coach/prompts';
import { anthropicUserHash } from '../src/coach/quota';
import type { Config } from '../src/config';
import { aiGlobalDaily, aiUsage } from '../src/db/schema';
import { buildTestApp, createTestUser, fakeClock, testConfig, type TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const KEY = 'sk-ant-api03-fake-key-for-tests-only-00000000';

interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type SseEvent = { type: string } & Record<string, unknown>;

type Reply =
  /** A JSON answer (errors). */
  | { status: number; body: unknown; headers?: Record<string, string> }
  /** A 200 event stream; `end` says how it stops (default: cleanly). */
  | { sse: SseEvent[]; end?: 'close' | 'hang' | 'destroy' };

type Usage = Record<string, unknown>;

const USAGE: Usage = {
  input_tokens: 300,
  output_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 700,
};

const message = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: USAGE,
  ...overrides,
});

/** `message_start` as the API sends it: no content yet, the input usage, one output token. */
const start = (model = 'claude-opus-5', usage: Usage = USAGE): SseEvent => ({
  type: 'message_start',
  message: {
    ...message(''),
    model,
    content: [],
    stop_reason: null,
    usage: { ...usage, output_tokens: 1 },
  },
});

/** The events of a whole message, in the order the API streams them. */
function streamOf(m: ReturnType<typeof message>): SseEvent[] {
  const blocks = m.content as Array<Record<string, unknown>>;
  const usage = m.usage as Usage;
  const events: SseEvent[] = [start(m.model, usage)];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: m.stop_reason, stop_sequence: null },
    usage,
    context_management: null,
  });
  events.push({ type: 'message_stop' });
  return events;
}

const splitJson = JSON.stringify({
  steps: [
    { title: 'Leer el enunciado', minutes: 10, suggestedPhrase: 'estudiar enunciado 10 minutos' },
    { title: 'Hacer un esquema', minutes: 20, suggestedPhrase: null },
  ],
  firstStepTip: 'Abre el documento y lee el título.',
});

const overloaded: Reply = {
  status: 529,
  body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  headers: { 'retry-after-ms': '1' },
};

describe('coach through the real Anthropic SDK', () => {
  let t: TestDb;
  let server: Server;
  let baseURL: string;
  let captured: Captured[];
  let replies: Reply[];
  let open: ServerResponse[];
  let app: FastifyInstance;
  let config: Config;
  let logs: string[];
  let u: TestUser;
  const clock = fakeClock('2026-09-28T10:00:00.000Z');

  beforeAll(async () => {
    t = await createTestDb();
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        const reply = replies.shift() ?? { status: 500, body: { type: 'error' } };
        if ('status' in reply) {
          res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
          res.end(JSON.stringify(reply.body));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of reply.sse) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (reply.end === 'hang') open.push(res);
        else if (reply.end === 'destroy') setTimeout(() => res.destroy(), 10);
        else res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.close();
  });

  beforeEach(async () => {
    await resetDb(t.db);
    captured = [];
    replies = [];
    open = [];
    logs = [];
    config = testConfig({ ANTHROPIC_API_KEY: KEY });
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
      coachModel: createAnthropicCoachModel(config.ai, { baseURL }),
      logger: { stream },
    });
    u = await createTestUser(t.db, { now: clock.now(), sharing: { coach: true } });
  });
  afterEach(async () => {
    for (const res of open) res.destroy();
    await app.close();
    // The key must never leave through a response or a log line.
    expect(logs.join('')).not.toContain(KEY);
  });

  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers: u.headers, payload });
  const splitTask = () =>
    post('/v1/coach/split-task', {
      task: 'Trabajo de historia',
      context: null,
      minutesAvailable: null,
    });
  const usageRow = async () => (await t.db.select().from(aiUsage))[0];
  const globalRow = async () => (await t.db.select().from(aiGlobalDaily))[0];

  it('streams the coach request the skill describes and bills every attempt', async () => {
    replies.push({
      sse: streamOf(
        message(splitJson, {
          model: 'claude-opus-4-8',
          content: [
            {
              type: 'fallback',
              from: { model: 'claude-opus-5' },
              to: { model: 'claude-opus-4-8' },
              trigger: { type: 'refusal' },
            },
            { type: 'text', text: splitJson },
          ],
          usage: {
            input_tokens: 300,
            output_tokens: 120,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            iterations: [
              {
                type: 'message',
                model: 'claude-opus-5',
                input_tokens: 280,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              {
                type: 'fallback_message',
                model: 'claude-opus-4-8',
                input_tokens: 300,
                output_tokens: 120,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            ],
          },
        }),
      ),
    });
    const res = await splitTask();
    expect(res.statusCode).toBe(200);
    expect(res.json().steps[0]).toEqual({
      title: 'Leer el enunciado',
      minutes: 10,
      suggestedPhrase: 'estudiar enunciado 10 minutos',
    });
    expect(res.body).not.toContain(KEY);

    expect(captured).toHaveLength(1);
    const req = captured[0] as Captured;
    expect(req.path).toBe('/v1/messages?beta=true');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
    expect(String(req.headers['anthropic-beta'])).toContain(SERVER_FALLBACK_BETA);
    expect(req.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 4000,
      stream: true,
      fallbacks: 'default',
      metadata: { user_id: anthropicUserHash(config.auth?.secret ?? '', u.userId) },
      system: [{ type: 'text', text: SPLIT_TASK_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(req.body.thinking).toBeUndefined();
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.betas).toBeUndefined();
    const schema = (req.body.output_config as { format: { schema: Record<string, unknown> } })
      .format.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    const userContent = (req.body.messages as Array<{ content: string }>)[0]?.content ?? '';
    expect(userContent).toContain('<tarea>Trabajo de historia</tarea>');
    expect(JSON.stringify(req.body)).not.toContain(u.userId);

    // 280 × 5 (declined Opus 5 attempt) + 300 × 5 + 120 × 25 (Opus 4.8 answer).
    expect(await usageRow()).toMatchObject({
      inputTokens: 580,
      outputTokens: 120,
      costMicroUsd: 1400 + 1500 + 3000,
      reservedTokens: 0,
      reservedMicroUsd: 0,
      reservedUntil: null,
    });
    expect(await globalRow()).toMatchObject({ costMicroUsd: 5900, reservedMicroUsd: 0 });
  });

  it('sends phrases to Haiku without effort, thinking or fallbacks, at temperature 0', async () => {
    const intent = {
      kind: 'study',
      serviceIds: [],
      categoryIds: [],
      domains: [],
      durationMinutes: 40,
      untilTime: null,
      untilTomorrow: false,
      task: 'física',
      clarification: null,
    };
    replies.push({ sse: streamOf(message(JSON.stringify(intent), { model: 'claude-haiku-4-5' })) });
    const res = await post('/v1/coach/interpret', {
      text: 'ponme a hacer física un ratito, 40 min',
      timeZone: 'Europe/Madrid',
      now: clock.now().toISOString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      canonicalText: 'estudiar física durante 40 minutos',
      clarification: null,
    });
    const req = captured[0] as Captured;
    expect(req.body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      temperature: 0,
      system: [{ type: 'text', text: INTERPRET_SYSTEM, cache_control: { type: 'ephemeral' } }],
    });
    expect((req.body.output_config as Record<string, unknown>).effort).toBeUndefined();
    expect(req.body.fallbacks).toBeUndefined();
    expect(req.body.thinking).toBeUndefined();
    expect(String(req.headers['anthropic-beta'] ?? '')).not.toContain('server-side-fallback');
  });

  it('maps a refusal to 422 and a truncated answer to 502, billing both', async () => {
    replies.push({ sse: streamOf(message('', { content: [], stop_reason: 'refusal' })) });
    let res = await splitTask();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('coach_refused');

    replies.push({
      sse: streamOf(
        message('{"steps":[{"title":"Le', {
          stop_reason: 'max_tokens',
          usage: { input_tokens: 300, output_tokens: 4000 },
        }),
      ),
    });
    res = await splitTask();
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('coach_incomplete');

    expect(await usageRow()).toMatchObject({
      requests: 2,
      reservedTokens: 0,
      outputTokens: 120 + 4000,
    });
  });

  it('retries an overloaded API once, then answers 503 without billing', async () => {
    replies.push(overloaded, overloaded);
    const res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('coach_unavailable');
    expect(captured).toHaveLength(2);
    // Anthropic's overload is not the user's use of the day: the request comes back too.
    expect(await usageRow()).toMatchObject({
      requests: 0,
      reservedTokens: 0,
      reservedMicroUsd: 0,
      costMicroUsd: 0,
    });
    expect(await globalRow()).toMatchObject({ costMicroUsd: 0, reservedMicroUsd: 0 });

    // An overloaded `error` event before any output is not billed either, and the retry can
    // answer.
    replies.push(
      { sse: [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }] },
      { sse: streamOf(message(splitJson)) },
    );
    expect((await splitTask()).statusCode).toBe(200);
    expect(captured).toHaveLength(4);
    expect((await usageRow())?.costMicroUsd).toBe(300 * 5 + 700 * 0.5 + 120 * 25);
  });

  it('books nothing for an HTTP error instead of the stream, an upper bound once it opened', async () => {
    // A 5xx answered instead of the event stream: the request failed before streaming began,
    // so nothing was generated. Retried once (unbilled), then 503 with nothing booked.
    const apiError = { type: 'error', error: { type: 'api_error', message: 'Internal' } };
    replies.push({ status: 500, body: apiError }, { status: 502, body: apiError });
    let res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('coach_unavailable');
    expect(captured).toHaveLength(2);
    let row = await usageRow();
    expect(row).toMatchObject({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: 0,
      reservedMicroUsd: 0,
    });
    expect(await globalRow()).toMatchObject({ costMicroUsd: 0, reservedMicroUsd: 0 });
    expect(logs.join('')).toContain('"billing":"none"');
    // …and a 503 followed by an answer is simply retried.
    replies.push({ status: 503, body: apiError }, { sse: streamOf(message(splitJson)) });
    expect((await splitTask()).statusCode).toBe(200);
    expect(captured).toHaveLength(4);
    const answered = 300 * 5 + 700 * 0.5 + 120 * 25;
    expect((await usageRow())?.costMicroUsd).toBe(answered);

    // The stream opened (200) and the connection dropped before message_start: sent, usage
    // unknown, not retried: one hop at its worst case from the input estimate.
    replies.push({ sse: [], end: 'destroy' });
    res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(captured).toHaveLength(5);
    row = await usageRow();
    const estimate = row?.cacheWriteTokens ?? 0;
    expect(estimate).toBeGreaterThan(1500);
    expect(row).toMatchObject({ outputTokens: 120 + 4000, reservedMicroUsd: 0 });
    const worstHop = Math.ceil(estimate * 5 * 1.25 + 4000 * 25);
    expect(row?.costMicroUsd).toBe(answered + worstHop);

    // The connection drops after message_start: the reported input and max output.
    replies.push({ sse: [start()], end: 'destroy' });
    res = await splitTask();
    expect(res.statusCode).toBe(503);
    row = await usageRow();
    expect(row?.costMicroUsd).toBe(answered + worstHop + 300 * 5 + 700 * 0.5 + 4000 * 25);
    // The unbilled first call gave its request back; the other three stay counted.
    expect(row).toMatchObject({ requests: 3, reservedTokens: 0, reservedUntil: null });
    expect((await globalRow())?.costMicroUsd).toBe(row?.costMicroUsd);
    expect((await globalRow())?.reservedMicroUsd).toBe(0);
    expect(logs.join('')).toContain('"billing":"bound"');
  });

  it('bounds a call cut off by its deadline, fallback hop included', async () => {
    const model = createAnthropicCoachModel(config.ai, { baseURL });
    replies.push({
      sse: [
        start(),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'fallback',
            from: { model: 'claude-opus-5' },
            to: { model: 'claude-opus-4-8' },
            trigger: { type: 'refusal' },
          },
        },
      ],
      end: 'hang',
    });
    const request = {
      feature: 'coach' as const,
      model: 'claude-opus-5',
      system: 'Sistema',
      user: 'Usuario',
      maxTokens: 4000,
      effort: 'low' as const,
      schema: z.object({ answer: z.string() }),
      userHash: 'a'.repeat(32),
      deadlineMs: 300,
      inputTokensBound: 2000,
      fallbacks: true,
    };
    const err = await model?.run(request).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CoachModelError);
    const failed = err as CoachModelError;
    expect(failed.reason).toBe('unavailable');
    expect(failed.billing).toBe('bound');
    expect(failed.attempts).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 300,
        cacheReadTokens: 700,
        cacheWriteTokens: 0,
        outputTokens: 4000,
      },
      {
        model: 'claude-opus-4-8',
        inputTokens: 0,
        cacheWriteTokens: 6000,
        cacheReadTokens: 0,
        outputTokens: 4000,
      },
    ]);
    expect(costMicroUsd(failed.attempts)).toBe(1500 + 350 + 100_000 + 37_500 + 100_000);
    // Not retried: the first try may have been billed.
    expect(captured).toHaveLength(1);
  });

  it('logs a wrong key by class only and hides it behind 503; a bad request is a 500', async () => {
    replies.push({
      status: 401,
      body: {
        type: 'error',
        error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` },
      },
    });
    let res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('coach_unavailable');
    const log = logs.join('');
    expect(log).toContain('coach model misconfigured');
    expect(log).toContain('AuthenticationError');
    expect(log).not.toContain('invalid x-api-key');

    replies.push({
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } },
    });
    res = await splitTask();
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal_error');
    expect(res.body).not.toContain('bad schema');
    expect(logs.join('')).not.toContain('bad schema');
    // Neither ran the model: nothing billed, no retry.
    expect(captured).toHaveLength(2);
    expect((await usageRow())?.costMicroUsd).toBe(0);
  });

  it('treats no credit and an unknown model as the owner’s problem: 503, request given back', async () => {
    // 402 (no SDK class), a 404 for the model id and a billing `error` event before any
    // output: an error log with class and status, 503 coach_unavailable (never a 500), no
    // retry, nothing billed and the request back.
    replies.push(
      {
        status: 402,
        body: { type: 'error', error: { type: 'billing_error', message: `no credit ${KEY}` } },
      },
      {
        status: 404,
        body: { type: 'error', error: { type: 'not_found_error', message: 'model: x' } },
      },
    );
    for (const status of [402, 404]) {
      const res = await splitTask();
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('coach_unavailable');
      expect(logs.join('')).toContain(`"status":${status}`);
    }
    expect(captured).toHaveLength(2);
    expect(logs.join('')).toContain('coach model misconfigured');
    expect(logs.join('')).not.toContain('no credit');
    expect(await usageRow()).toMatchObject({ requests: 0, costMicroUsd: 0, reservedMicroUsd: 0 });
    expect(await globalRow()).toMatchObject({ requests: 0, costMicroUsd: 0, reservedMicroUsd: 0 });

    // The third one in a row opens the breaker: /health turns the coach off.
    replies.push({ sse: [{ type: 'error', error: { type: 'billing_error', message: 'x' } }] });
    const res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('coach_unavailable');
    expect(captured).toHaveLength(3);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().capabilities.coach).toEqual({ enabled: false, reason: 'kill_switch' });
    expect((await splitTask()).json().error).toMatchObject({
      code: 'feature_disabled',
      reason: 'kill_switch',
    });
    expect(captured).toHaveLength(3);
    expect((await usageRow())?.requests).toBe(0);
  });

  it('drops the fallback beta with AI_REFUSAL_FALLBACKS=false', async () => {
    await app.close();
    config = testConfig({ ANTHROPIC_API_KEY: KEY, AI_REFUSAL_FALLBACKS: 'false' });
    expect(config.ai.refusalFallbacks).toBe(false);
    app = await buildTestApp({
      db: t.db,
      clock,
      config,
      coachModel: createAnthropicCoachModel(config.ai, { baseURL }),
    });
    replies.push({ sse: streamOf(message(splitJson)) });
    expect((await splitTask()).statusCode).toBe(200);
    const req = captured[0] as Captured;
    expect(req.body.model).toBe('claude-opus-5');
    expect(req.body.fallbacks).toBeUndefined();
    expect(String(req.headers['anthropic-beta'] ?? '')).not.toContain(SERVER_FALLBACK_BETA);
    // Without fallbacks the worst case is the first hop alone.
    const worst = largestWorstCase(config, 'split-task');
    expect(worst.attempts).toHaveLength(1);
    expect(worst.costMicroUsd).toBe(worst.capMicroUsd);
  });
});
