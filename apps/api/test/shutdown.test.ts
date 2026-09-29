/**
 * Graceful shutdown with work still running: a coach call whose client went away (the app was
 * closed, the request cancelled) holds no connection, so the HTTP server closes at once. The
 * app must still wait for its handler, so the quota reservation settles before the database
 * pool closes (docs/API.md §10.2 and §15). Emails sent without making their request wait are
 * waited for too.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/context';
import { aiUsage } from '../src/db/schema';
import { InFlightWork } from '../src/lib/in-flight';
import { buildTestApp, createTestUser, fakeClock, testConfig } from './helpers/app';
import type { FakeClock } from './helpers/app';
import { fakeCoachModel, ok } from './helpers/coach';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock('2026-09-28T10:00:00.000Z');
});

const splitOutput = {
  steps: [
    {
      title: 'Leer el enunciado y subrayar lo que piden',
      minutes: 10,
      suggestedPhrase: 'estudiar enunciado 10 minutos',
    },
  ],
  firstStepTip: 'Empieza leyendo solo el primer párrafo.',
};

const until = async (condition: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('closing the app', () => {
  it('waits for a coach call whose client left, so its reservation settles', async () => {
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const model = fakeCoachModel(async () => {
      await answered;
      return ok(splitOutput);
    });
    const app: FastifyInstance = await buildTestApp({
      db: t.db,
      clock,
      config: testConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-shutdown-0000' }),
      coachModel: model,
    });
    const ana = await createTestUser(t.db, { now: clock.now(), sharing: { coach: true } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    // The client sends a split-task request and leaves while the model is still thinking.
    const body = JSON.stringify({
      task: 'Trabajo de historia',
      context: null,
      minutesAvailable: 45,
    });
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/coach/split-task',
      headers: { ...ana.headers, 'content-type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.end(body);
    await until(() => model.calls.length === 1);
    const [held] = await t.db.select().from(aiUsage).where(eq(aiUsage.userId, ana.userId));
    expect(held?.reservedTokens).toBeGreaterThan(0);
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The HTTP server has no connection left, but the call is still running.
    expect(closed).toBe(false);

    answer();
    await closing;
    const [settled] = await t.db.select().from(aiUsage).where(eq(aiUsage.userId, ana.userId));
    expect(settled).toMatchObject({ reservedTokens: 0, reservedMicroUsd: 0, reservedUntil: null });
    expect(settled?.outputTokens).toBe(400);
  });

  it('waits for emails sent without making their request wait', async () => {
    let deliver: () => void = () => undefined;
    const delivered = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const sent: MailMessage[] = [];
    const app = await buildTestApp({
      db: t.db,
      clock,
      mailer: {
        send: async (message) => {
          await delivered;
          sent.push(message);
        },
      },
    });
    // What the sign-in code and the partner alerts do: send and answer at once.
    void app.ctx.mailer?.send({
      to: 'ana@example.com',
      subject: 'Tu código',
      text: '123456',
      html: null,
      tag: 'sign_in_code',
    });
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    deliver();
    await closing;
    expect(sent).toHaveLength(1);
  });
});

describe('InFlightWork', () => {
  it('drains work added while draining and ignores failures', async () => {
    const work = new InFlightWork();
    const order: string[] = [];
    let second: Promise<void> = Promise.resolve();
    const first = work.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          order.push('first');
          second = work.track(
            new Promise<void>((r) =>
              setTimeout(() => {
                order.push('second');
                r();
              }, 20),
            ),
          );
          resolve();
        }, 20),
      ),
    );
    const failing = work.track(Promise.reject(new Error('boom')));
    await expect(failing).rejects.toThrow('boom');
    expect(work.size).toBe(1);
    await work.drain();
    expect(order).toEqual(['first', 'second']);
    expect(work.size).toBe(0);
    await first;
    await second;
    // Nothing pending: draining returns at once.
    await work.drain();
  });
});
