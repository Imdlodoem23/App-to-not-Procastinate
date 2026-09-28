/**
 * The real `@anthropic-ai/sdk` client against a local fake of the Messages API: the request
 * shape (models, cached system prompt, max_tokens, fallback beta, metadata.user_id), the
 * answer handling and the error mapping, end to end through the routes.
 */
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAnthropicCoachModel, SERVER_FALLBACK_BETA } from '../src/coach/anthropic';
import { INTERPRET_SYSTEM, SPLIT_TASK_SYSTEM } from '../src/coach/prompts';
import { anthropicUserHash } from '../src/coach/quota';
import type { Config } from '../src/config';
import { aiUsage } from '../src/db/schema';
import { buildTestApp, createTestUser, fakeClock, testConfig, type TestUser } from './helpers/app';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

const KEY = 'sk-ant-api03-fake-key-for-tests-only-00000000';

interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const message = (text: string, overrides: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 300,
    output_tokens: 120,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 700,
  },
  ...overrides,
});

const splitJson = JSON.stringify({
  steps: [
    { title: 'Leer el enunciado', minutes: 10, suggestedPhrase: 'estudiar enunciado 10 minutos' },
    { title: 'Hacer un esquema', minutes: 20, suggestedPhrase: null },
  ],
  firstStepTip: 'Abre el documento y lee el título.',
});

describe('coach through the real Anthropic SDK', () => {
  let t: TestDb;
  let server: Server;
  let baseURL: string;
  let captured: Captured[];
  let replies: Reply[];
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
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.close();
  });

  beforeEach(async () => {
    await resetDb(t.db);
    captured = [];
    replies = [];
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

  it('sends the coach request the skill describes and bills every attempt', async () => {
    replies.push({
      status: 200,
      body: message(splitJson, {
        model: 'claude-opus-4-8',
        content: [
          { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
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
      max_tokens: 8000,
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

    const [row] = await t.db.select().from(aiUsage);
    // 280 × 5 (declined Opus 5 attempt) + 300 × 5 + 120 × 25 (Opus 4.8 answer).
    expect(row).toMatchObject({
      inputTokens: 580,
      outputTokens: 120,
      costMicroUsd: 1400 + 1500 + 3000,
    });
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
    replies.push({
      status: 200,
      body: message(JSON.stringify(intent), { model: 'claude-haiku-4-5' }),
    });
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
    replies.push({ status: 200, body: message('', { content: [], stop_reason: 'refusal' }) });
    let res = await splitTask();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('coach_refused');

    replies.push({
      status: 200,
      body: message('{"steps":[{"title":"Le', {
        stop_reason: 'max_tokens',
        usage: { input_tokens: 300, output_tokens: 8000 },
      }),
    });
    res = await splitTask();
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('coach_incomplete');

    const [row] = await t.db.select().from(aiUsage);
    expect(row).toMatchObject({ requests: 2, reservedTokens: 0, outputTokens: 120 + 8000 });
  });

  it('retries an overloaded API once, then answers 503 coach_unavailable', async () => {
    const overloaded: Reply = {
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      headers: { 'retry-after-ms': '1' },
    };
    replies.push(overloaded, overloaded);
    const res = await splitTask();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('coach_unavailable');
    expect(captured).toHaveLength(2);
    const [row] = await t.db.select().from(aiUsage);
    expect(row).toMatchObject({ requests: 1, reservedTokens: 0, costMicroUsd: 0 });
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
  });
});
