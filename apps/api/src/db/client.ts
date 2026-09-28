/**
 * Database handle. Production uses node-postgres; tests use PGlite (test/helpers/db.ts) through
 * the same `Db` type, so route code never knows which one it has.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  /** True when a trivial query answers within `timeoutMs`. */
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Pings `db` with a timeout; any error or timeout is `false`. */
export async function pingDb(db: Db, timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const query = db.execute(sql`select 1`).then(() => true as const);
    return await Promise.race([query, timeout]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Server-side cap on one statement: a slow database answers 503 instead of holding a slot. */
export const STATEMENT_TIMEOUT_MS = 10_000;
/** Client-side cap on waiting for an answer (a hung connection that never replies). */
export const QUERY_TIMEOUT_MS = 15_000;
/** Waiting for a free connection or for a new one to open. */
export const CONNECT_TIMEOUT_MS = 5000;

export interface ConnectOptions {
  /** Defaults to `CONNECT_TIMEOUT_MS` (tests shorten it). */
  connectionTimeoutMillis?: number;
}

/**
 * Opens a small pool (the free Render Postgres allows few connections). Every statement has a
 * timeout, so a stuck database frees the pool instead of queueing every request behind it;
 * the errors map to 503 `database_unavailable` (lib/errors.ts).
 */
export function connectPostgres(
  url: string,
  options: ConnectOptions = {},
): DbHandle & { pool: pg.Pool; directClient(): pg.Client } {
  const connectionTimeoutMillis = options.connectionTimeoutMillis ?? CONNECT_TIMEOUT_MS;
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis,
    idleTimeoutMillis: 30_000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 30_000,
  });
  // A dropped idle connection must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    pool,
    /** An unpooled connection without statement timeouts, for migrations (db/migrate.ts). */
    directClient: () => {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis });
      client.on('error', () => {});
      return client;
    },
    ping: (timeoutMs) => pingDb(db, timeoutMs),
    close: () => pool.end(),
  };
}
