/**
 * Process entry (owner: CORE). Bundled by build.mjs into dist/server.mjs and started by Render
 * with `node apps/api/dist/server.mjs`. `--check` validates the configuration and exits.
 *
 * The boot sequence lives in boot.ts: when the database is unreachable at boot (a free Render
 * Postgres that expired, a host that never answers, a network blip) the server still starts:
 * /health reports `db: down` and /v1 answers 503 until a background retry manages to prepare
 * the database. SIGTERM/SIGINT close the server gracefully (in-flight requests finish; new ones
 * get 503) within 10 s.
 */
import { fileURLToPath } from 'node:url';
import { startServer } from './boot';
import { ConfigError, loadConfig } from './config';
import type { Config } from './config';

// src/server.ts and dist/server.mjs both sit one level below apps/api.
const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 10_000;

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

  const server = await startServer({ config, migrationsFolder: MIGRATIONS });
  const { app } = server;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    app.log.error({ err }, 'unhandled rejection');
  });
}

void main().catch((err: unknown) => {
  // Type and code only: messages can quote configuration values.
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `Startup failed: ${err instanceof Error ? err.name : 'Error'}${code ? ` (${String(code)})` : ''}`,
  );
  process.exit(1);
});
