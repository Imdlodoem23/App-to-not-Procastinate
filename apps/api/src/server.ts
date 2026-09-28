/**
 * Process entry (owner: CORE). Bundled by build.mjs into dist/server.mjs and started by Render
 * with `node apps/api/dist/server.mjs`. `--check` validates the configuration and exits.
 *
 * Boot: config → Postgres pool → migrations (advisory lock) → server epoch → app → janitor.
 * When the database is unreachable at boot (a free Render Postgres that expired, a network
 * blip) the server still starts: /health reports `db: down` and /v1 answers 503 until a
 * background retry manages to prepare the database. SIGTERM/SIGINT close the server
 * gracefully (in-flight requests finish; new ones get 503) within 10 s.
 */
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import type { Config } from './config';
import { connectPostgres } from './db/client';
import { ensureServerEpoch } from './db/meta';
import { runMigrations } from './db/migrate';
import { startJanitor } from './jobs/janitor';
import type { JanitorHandle } from './jobs/janitor';
import { isDatabaseUnavailable } from './lib/errors';

// src/server.ts and dist/server.mjs both sit one level below apps/api.
const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_RETRY_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

type PgHandle = ReturnType<typeof connectPostgres>;

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  // Every date computed by the server is explicit about its zone; pin the process to UTC.
  process.env.TZ = 'UTC';
  const config = readConfig();
  if (process.argv.includes('--check')) {
    console.log('Configuration OK');
    for (const warning of config.warnings) console.log(`Warning: ${warning}`);
    return;
  }

  const handle = config.databaseUrl ? connectPostgres(config.databaseUrl) : null;
  const app = await buildApp({ config, db: handle?.db ?? null });
  for (const warning of config.warnings) app.log.warn(warning);

  let janitor: JanitorHandle | null = null;
  let retry: NodeJS.Timeout | null = null;

  /** Migrations and the server epoch; then the janitor. Retries while Postgres is down. */
  const prepareDatabase = async (h: PgHandle): Promise<void> => {
    try {
      await runMigrations(h.pool, MIGRATIONS);
      await ensureServerEpoch(h.db);
      janitor = startJanitor(h.db, { log: app.log });
      app.log.info('database ready');
    } catch (err) {
      if (!isDatabaseUnavailable(err)) throw err;
      app.log.warn({ code: (err as { code?: unknown }).code }, 'database unavailable, retrying');
      retry = setTimeout(() => void prepareDatabase(h).catch(fatal), DB_RETRY_MS);
      retry.unref();
    }
  };

  const fatal = (err: unknown) => {
    app.log.fatal({ err }, 'database setup failed');
    process.exit(1);
  };

  if (handle) await prepareDatabase(handle);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    if (retry) clearTimeout(retry);
    janitor?.stop();
    try {
      await app.close();
      await handle?.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    app.log.error({ err }, 'unhandled rejection');
  });

  await app.listen({ host: config.host, port: config.port });
}

void main().catch((err: unknown) => {
  // Type and code only: messages can quote configuration values.
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `Startup failed: ${err instanceof Error ? err.name : 'Error'}${code ? ` (${String(code)})` : ''}`,
  );
  process.exit(1);
});
