/**
 * Booting against a database that never answers (an expired free Postgres, a host that drops
 * packets): the server must still listen, report `db: down`, answer /v1 with 503 and keep
 * retrying in the background instead of exiting (docs/API.md §15).
 */
import type { HealthResponse } from '@centrate/shared/cloud-api';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRetryableBootError, startServer } from '../src/boot';
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
