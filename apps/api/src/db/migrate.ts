/**
 * Applies the SQL migrations in `apps/api/drizzle/` at boot (Render's free plan has no
 * pre-deploy command). A Postgres advisory lock keeps two starting instances from racing.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** Arbitrary constant shared by every instance of this service. */
const MIGRATION_LOCK_ID = 4_726_001;

export async function runMigrations(pool: pg.Pool, migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
