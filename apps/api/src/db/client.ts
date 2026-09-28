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

/** Opens a small pool (the free Render Postgres allows few connections). */
export function connectPostgres(url: string): DbHandle & { pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // A dropped idle connection must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    pool,
    ping: (timeoutMs) => pingDb(db, timeoutMs),
    close: () => pool.end(),
  };
}
