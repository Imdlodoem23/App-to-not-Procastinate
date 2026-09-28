/**
 * PGlite (in-process Postgres) with the real SQL migrations from apps/api/drizzle. One
 * database per test file is the usual pattern; `resetDb` empties it between tests.
 */
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../src/db/client';
import { ensureServerEpoch } from '../../src/db/meta';
import * as schema from '../../src/db/schema';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const pglite = drizzle({ client, schema });
  await migrate(pglite, { migrationsFolder: MIGRATIONS });
  const db = pglite as unknown as Db;
  await ensureServerEpoch(db);
  return { db, client, close: () => client.close() };
}

/** Deletes every row except `meta` (keeps the server epoch). */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE "user", "verification", "ai_global_daily", "ai_identity_daily", "rate_counters"
      RESTART IDENTITY CASCADE
  `);
}
