/**
 * Booting against a database that never answers (an expired free Postgres, a host that drops
 * packets): the server must still listen, report `db: down`, answer /v1 with 503 and keep
 * retrying in the background instead of exiting (docs/API.md §15). And shutting down: requests
 * in flight (a coach call included) finish before the process exits.
 */
import type { HealthResponse } from '@centrate/shared/cloud-api';
import { readFileSync } from 'node:fs';
import { Agent, get } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { isRetryableBootError, SHUTDOWN_TIMEOUT_MS, startServer } from '../src/boot';
import { ENDPOINTS, SETTLE_MARGIN_MS } from '../src/coach/service';
import { DatabaseNotReadyError } from '../src/db/migrate';
import { testConfig } from './helpers/app';
import { closedPortUrl, startBlackhole } from './helpers/blackhole';
import type { Blackhole } from './helpers/blackhole';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

let hole: Blackhole;
beforeAll(async () => {
  hole = await startBlackhole();
});
afterAll(async () => {
  await hole.close();
});

function logSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('startServer without a reachable database', () => {
  for (const [label, url] of [
    ['a host that never answers', () => hole.url],
    ['a refused connection', closedPortUrl],
  ] as const) {
    it(`starts, reports db: down and retries (${label})`, async () => {
      const log = logSink();
      const fatal: unknown[] = [];
      const config = { ...testConfig({ DATABASE_URL: await url() }), host: '127.0.0.1', port: 0 };
      const server = await startServer({
        config,
        migrationsFolder: MIGRATIONS,
        connectTimeoutMs: 200,
        retryMs: 50,
        logger: { stream: log.stream },
        onFatal: (err) => fatal.push(err),
      });
      try {
        const { port } = server.app.server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        const health = (await res.json()) as HealthResponse;
        expect(health.db).toBe('down');
        expect(health.capabilities.accounts).toEqual({ enabled: false, reason: 'database_down' });

        const me = await fetch(`http://127.0.0.1:${port}/v1/me`, {
          headers: { authorization: 'Bearer made-up-token-made-up-token-0000' },
        });
        expect(me.status).toBe(503);
        expect(((await me.json()) as { error: { code: string } }).error.code).toBe(
          'database_unavailable',
        );

        const retries = () =>
          log.lines.filter((l) => l.includes('database unavailable, retrying')).length;
        await waitFor(() => retries() >= 3);
        expect(server.databaseReady()).toBe(false);
        expect(fatal).toEqual([]);
        expect(log.lines.join('\n')).not.toContain('secret@');
      } finally {
        await server.close();
      }
    });
  }

  it('treats only connection trouble as retryable', () => {
    expect(isRetryableBootError(new DatabaseNotReadyError(new Error('x')))).toBe(true);
    expect(isRetryableBootError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryableBootError(Object.assign(new Error('syntax'), { code: '42601' }))).toBe(false);
  });
});

describe('graceful shutdown', () => {
  it('waits for the longest coach call to settle, and Render waits for it', () => {
    const longest = Math.max(...Object.values(ENDPOINTS).map((e) => e.deadlineMs));
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThanOrEqual(longest + SETTLE_MARGIN_MS);
    const blueprint = readFileSync(new URL('../../../render.yaml', import.meta.url), 'utf8');
    const api = blueprint.slice(blueprint.indexOf('name: centrate-api'));
    const delay = Number(/\n\s+maxShutdownDelaySeconds: (\d+)\n/.exec(api)?.[1]);
    expect(delay * 1000).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS);
    expect(delay).toBeLessThanOrEqual(300);
  });

  it('lets a request in flight finish, then closes its keep-alive connection at once', async () => {
    const app = await buildApp({ config: testConfig({ DATABASE_URL: undefined }), logger: false });
    app.get('/slow-test', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const call = (path: string) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; at: number }>(
        (resolve, reject) => {
          get({ host: '127.0.0.1', port, path, agent }, (res) => {
            res.resume();
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, at: Date.now() }),
            );
          }).on('error', reject);
        },
      );
    try {
      // A warm keep-alive connection, as Render's proxy keeps.
      expect((await call('/health')).headers.connection).toBe('keep-alive');
      const inFlight = call('/slow-test');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const closed = app.close().then(() => Date.now());
      const res = await inFlight;
      expect(res.status).toBe(200);
      expect(res.headers.connection).toBe('close');
      // Without closing the connection the server would wait for Fastify's 72 s keep-alive.
      expect((await closed) - res.at).toBeLessThan(1000);
    } finally {
      agent.destroy();
      await app.close();
    }
  });
});
