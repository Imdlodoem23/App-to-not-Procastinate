/**
 * Starting and stopping the server (owner: CORE), separate from the process entry (server.ts)
 * so tests can boot it against a database that does not answer.
 *
 * Boot: Postgres pool → app → migrations (advisory lock) → server epoch → janitor → listen.
 * When the database cannot be reached at boot (a free Render Postgres that expired, a host
 * that never answers, a network blip) the server still starts: /health reports `db: down`,
 * /v1 answers 503, and a background retry prepares the database every `retryMs`. Only a
 * failure inside the migrations themselves (a broken migration) is fatal.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { BuildAppOptions } from './app';
import { ENDPOINTS as COACH_ENDPOINTS, SETTLE_MARGIN_MS } from './coach/service';
import type { Config } from './config';
import { connectPostgres } from './db/client';
import { ensureServerEpoch } from './db/meta';
import { DatabaseNotReadyError, runMigrations } from './db/migrate';
import { startJanitor } from './jobs/janitor';
import type { JanitorHandle } from './jobs/janitor';
import { isDatabaseUnavailable } from './lib/errors';

export const DB_RETRY_MS = 60_000;

/**
 * How long a graceful shutdown (SIGTERM on every deploy or restart) waits for requests in flight
 * before the process exits anyway: the longest coach call (its deadline) plus the margin its
 * quota reservation allows to settle, plus 5 s. Cutting a coach call short would leave its
 * worst-case reservation held (docs/API.md §10.2). Render must wait at least this long before
 * it kills the process: `maxShutdownDelaySeconds` in render.yaml (its default is 30 s).
 * Requests that are already done exit at once; this is only the upper bound.
 */
export const SHUTDOWN_TIMEOUT_MS =
  Math.max(...Object.values(COACH_ENDPOINTS).map((e) => e.deadlineMs)) + SETTLE_MARGIN_MS + 5_000;

export interface StartOptions {
  config: Config;
  migrationsFolder: string;
  /** Wait between attempts to prepare the database. */
  retryMs?: number;
  /** Postgres connect timeout (tests shorten it). */
  connectTimeoutMs?: number;
  logger?: BuildAppOptions['logger'];
  /** Called when preparing the database fails for good. Defaults to exiting the process. */
  onFatal?: (err: unknown) => void;
}

export interface RunningServer {
  app: FastifyInstance;
  /** True once migrations ran and the janitor started. */
  databaseReady(): boolean;
  /** Stops retries and the janitor, closes the server, then the pool. */
  close(): Promise<void>;
}

/** Preparation failures worth retrying: nothing reachable yet, or the connection dropped. */
export function isRetryableBootError(err: unknown): boolean {
  return err instanceof DatabaseNotReadyError || isDatabaseUnavailable(err);
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const { config } = options;
  const retryMs = options.retryMs ?? DB_RETRY_MS;
  const handle = config.databaseUrl
    ? connectPostgres(config.databaseUrl, { connectionTimeoutMillis: options.connectTimeoutMs })
    : null;
  const app = await buildApp({ config, db: handle?.db ?? null, logger: options.logger });
  for (const warning of config.warnings) app.log.warn(warning);

  let janitor: JanitorHandle | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;

  const fatal =
    options.onFatal ??
    ((err: unknown) => {
      app.log.fatal({ err }, 'database setup failed');
      process.exit(1);
    });

  /** Migrations and the server epoch; then the janitor. Retries while Postgres is not there. */
  const prepareDatabase = async (h: NonNullable<typeof handle>): Promise<void> => {
    try {
      await runMigrations(h.directClient(), options.migrationsFolder);
      await ensureServerEpoch(h.db);
      if (stopped) return;
      janitor = startJanitor(h.db, { log: app.log });
      app.log.info('database ready');
    } catch (err) {
      if (!isRetryableBootError(err)) throw err;
      if (stopped) return;
      const cause = err instanceof DatabaseNotReadyError ? err.cause : err;
      app.log.warn(
        { code: (cause as { code?: unknown } | null)?.code },
        'database unavailable, retrying',
      );
      retry = setTimeout(() => void prepareDatabase(h).catch(fatal), retryMs);
      retry.unref();
    }
  };

  if (handle) await prepareDatabase(handle);
  await app.listen({ host: config.host, port: config.port });

  return {
    app,
    databaseReady: () => janitor !== null,
    close: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      janitor?.stop();
      try {
        await app.close();
      } finally {
        await handle?.close();
      }
    },
  };
}
