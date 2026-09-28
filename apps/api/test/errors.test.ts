/**
 * Database failures surface as 503 database_unavailable (also when Drizzle wraps the driver
 * error), and error logs never carry a failed query's parameters.
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { isDatabaseUnavailable } from '../src/lib/errors';
import { testConfig } from './helpers/app';

function queryError(code: string | undefined): Error {
  const driver = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code });
  // What drizzle-orm throws: the SQL and its parameters in the message, the driver error in
  // `cause`.
  return new Error(
    'Failed query: select "session"."id" from "session" where "session"."token" = $1\nparams: SECRET-TOKEN-123',
    { cause: driver },
  );
}

describe('isDatabaseUnavailable', () => {
  it('recognises connection errors, wrapped or not', () => {
    expect(isDatabaseUnavailable({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isDatabaseUnavailable({ code: '08006' })).toBe(true);
    expect(isDatabaseUnavailable(queryError('ECONNREFUSED'))).toBe(true);
    expect(isDatabaseUnavailable(queryError('57P03'))).toBe(true);
    expect(isDatabaseUnavailable(queryError('23505'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('x'))).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
  });
});

describe('database failures', () => {
  async function run(code: string | undefined) {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = await buildApp({
      config: testConfig(),
      db: {} as Db,
      pingDb: async () => false,
      mailer: null,
      resolveSession: async () => {
        throw queryError(code);
      },
      logger: { stream },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer SECRET-TOKEN-123' },
    });
    await app.close();
    return { res, log: lines.join('\n') };
  }

  it('answers 503 database_unavailable when Postgres does not answer', async () => {
    const { res, log } = await run('ECONNREFUSED');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('database_unavailable');
    expect(log).not.toContain('SECRET-TOKEN');
  });

  it('logs other failures by type, code and stack frames only', async () => {
    const { res, log } = await run('42P01');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
    expect(log).toContain('"code":"42P01"');
    expect(log).toContain('"stack":"    at ');
    expect(log).not.toContain('SECRET-TOKEN');
    expect(log).not.toContain('Failed query');
  });
});
