/**
 * Applies the SQL migrations in `apps/api/drizzle/` at boot (Render's free plan has no
 * pre-deploy command). A Postgres advisory lock keeps two starting instances from racing.
 *
 * Migrations run on their own unpooled connection without the pool's statement timeouts (a
 * migration may legitimately take longer). Anything that fails before the first migration
 * statement (connecting, taking the lock) throws `DatabaseNotReadyError`: the server keeps
 * running and retries (server.ts).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** Arbitrary constant shared by every instance of this service. */
const MIGRATION_LOCK_ID = 4_726_001;
/** How long to wait for another instance's migrations before trying again later. */
const LOCK_WAIT = '60s';

/** The database could not be reached or locked yet; nothing was migrated. Retry later. */
export class DatabaseNotReadyError extends Error {
  constructor(cause: unknown) {
    super('The database is not ready for migrations', { cause });
    this.name = 'DatabaseNotReadyError';
  }
}

/** Connects `client`, takes the lock, migrates and closes the connection. */
export async function runMigrations(client: pg.Client, migrationsFolder: string): Promise<void> {
  try {
    await client.connect();
    await client.query(`SET statement_timeout = '${LOCK_WAIT}'`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('SET statement_timeout = 0');
  } catch (err) {
    await client.end().catch(() => undefined);
    throw new DatabaseNotReadyError(err);
  }
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
