/**
 * Server metadata rows. `server_epoch` is created once per database: when the free Postgres
 * expires and a new one takes its place, the epoch changes and the app re-uploads its history.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { meta } from './schema';

export const META_KEYS = Object.freeze({
  serverEpoch: 'server_epoch',
  janitorLastRun: 'janitor_last_run',
});

/** Reads one meta value, or null. */
export async function readMeta(db: Db, key: string): Promise<string | null> {
  const rows = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

/** Inserts or replaces one meta value. */
export async function writeMeta(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: meta.key, set: { value } });
}

/** Creates `server_epoch` if missing and returns it. */
export async function ensureServerEpoch(db: Db): Promise<string> {
  await db
    .insert(meta)
    .values({ key: META_KEYS.serverEpoch, value: randomUUID() })
    .onConflictDoNothing();
  const value = await readMeta(db, META_KEYS.serverEpoch);
  if (!value) throw new Error('server_epoch missing');
  return value;
}

/** The server epoch (created on first use when the boot step did not run). */
export async function readServerEpoch(db: Db): Promise<string> {
  return (await readMeta(db, META_KEYS.serverEpoch)) ?? ensureServerEpoch(db);
}
