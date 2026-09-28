/**
 * Process entry (owner: CORE). Bundled by build.mjs into dist/server.mjs and started by Render
 * with `node apps/api/dist/server.mjs`. `--check` validates the configuration and exits.
 *
 * TODO(CORE): server_epoch row, janitor (src/jobs/janitor.ts), mailer, graceful shutdown.
 */
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';
import { connectPostgres } from './db/client';
import { runMigrations } from './db/migrate';

// src/server.ts and dist/server.mjs both sit one level below apps/api.
const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

async function main(): Promise<void> {
  // Every date computed by the server is explicit about its zone; pin the process to UTC.
  process.env.TZ = 'UTC';
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (process.argv.includes('--check')) {
    console.log('Configuration OK');
    return;
  }

  const handle = config.databaseUrl ? connectPostgres(config.databaseUrl) : null;
  if (handle) await runMigrations(handle.pool, MIGRATIONS);

  const app = await buildApp({ config, db: handle?.db ?? null });
  for (const warning of config.warnings) app.log.warn(warning);

  const close = async () => {
    await app.close();
    await handle?.close();
    process.exit(0);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);

  await app.listen({ host: config.host, port: config.port });
}

void main();
