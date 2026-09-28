/**
 * Server metadata rows. `server_epoch` is created once per database: when the free Postgres
 * expires and a new one takes its place, the epoch changes and the app re-uploads its history.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { meta } from './schema';

/** Creates `server_epoch` if missing and returns it. */
export async function ensureServerEpoch(db: Db): Promise<string> {
  await db.insert(meta).values({ key: 'server_epoch', value: randomUUID() }).onConflictDoNothing();
  const rows = await db
    .select({ value: meta.value })
    .from(meta)
    .where(sql`${meta.key} = 'server_epoch'`)
    .limit(1);
  const value = rows[0]?.value;
  if (!value) throw new Error('server_epoch missing');
  return value;
}
