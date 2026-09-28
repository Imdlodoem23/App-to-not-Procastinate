/**
 * `buildApp()`: the Fastify factory used by the server entry and by every test. It wires the
 * cross-cutting pieces (security headers, CORS, rate limits, sessions, error envelope, minimal
 * logs, /health) and registers each builder's route module. docs/API.md is the contract.
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import { createAuth } from './auth';
import { assertCookieOrigin } from './auth/csrf';
import type { Config } from './config';
import { deriveCapabilities } from './config';
import type { AppContext, Mailer, SessionResolver } from './context';
import type { CoachModel } from './coach/model';
import { createAnthropicCoachModel } from './coach/anthropic';
import { pingDb, type Db } from './db/client';
import { ApiError, featureDisabled, isDatabaseUnavailable } from './lib/errors';
import { InFlightWork } from './lib/in-flight';
import { clientKey, FixedWindowLimiter } from './lib/ip-limit';
import { createResendMailer } from './lib/mailer';
import { accountPages } from './pages/account';
import { panelPages } from './pages/panel';
import { socialPages } from './pages/social';
import { accountabilityRoutes } from './routes/accountability';
import { appAuthRoutes } from './routes/app-auth';
import { coachRoutes } from './routes/coach';
import { friendsRoutes } from './routes/friends';
import { healthRoutes } from './routes/health';
import { meRoutes } from './routes/me';
import { presenceRoutes } from './routes/presence';
import { rankingRoutes } from './routes/ranking';
import { sessionsRoutes } from './routes/sessions';
import { syncRoutes } from './routes/sync';

export interface BuildAppOptions {
  config: Config;
  /** Omit or null when DATABASE_URL is unset. */
  db?: Db | null;
  /** Defaults to a `select 1` with a 2 s timeout. */
  pingDb?: () => Promise<boolean>;
  /** Injected clock (tests use a fake one). */
  now?: () => Date;
  /** Defaults to Resend when configured (CORE: src/lib/mailer.ts), else null. */
  mailer?: Mailer | null;
  /** Defaults to the Anthropic client when configured (COACH), else null. */
  coachModel?: CoachModel | null;
  /**
   * Session lookup. Defaults to better-auth (cookie or bearer). Tests of SOCIAL and COACH can
   * inject the token lookup from test/helpers/app.ts.
   */
  resolveSession?: SessionResolver;
  /** `false` silences logs; a pino destination stream captures them in tests. */
  logger?: boolean | FastifyServerOptions['logger'];
}

/**
 * Session lookups (one Postgres query each) per client IP (/64 for IPv6) per minute, checked
 * before the lookup. Far above what the desktop app and the pages need (the per-user limit is
 * 120 a minute); it stops floods of made-up tokens from saturating the small pool.
 */
export const SESSION_LOOKUPS_PER_IP_PER_MINUTE = 300;

/** Routes that never read the session: requests to them cost no session lookup. */
const SESSIONLESS_ROUTES: ReadonlySet<string> = new Set(['/health']);

/**
 * Logs one line per request: id, method, route pattern, status, time. Nothing else. At debug
 * level it adds how many entries the X-Forwarded-For header had (a count, never the addresses),
 * which is how TRUST_PROXY_HOPS is checked on Render (docs/API.md §12).
 */
class MinimalLogController extends LogController {
  private readonly countProxyHops: boolean;
  constructor(countProxyHops: boolean) {
    super({ requestIdLogLabel: 'reqId' });
    this.countProxyHops = countProxyHops;
  }
  override incomingRequest(): void {}
  override requestCompleted(
    _error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const line: Record<string, unknown> = {
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    };
    if (this.countProxyHops) {
      const xff = request.headers['x-forwarded-for'];
      line.xffEntries = [xff ?? []]
        .flat()
        .join(',')
        .split(',')
        .filter((part) => part.trim() !== '').length;
    }
    reply.log.info(line, 'request');
  }
  override routeNotFound(): void {}
  override defaultErrorLog(): void {}
}

function loggerOptions(
  config: Config,
  logger: BuildAppOptions['logger'],
): FastifyServerOptions['logger'] {
  if (logger === false) return false;
  const base = {
    level: config.logLevel,
    // Never log bodies, query strings, headers, IPs or emails. Serializers keep only the
    // method and route pattern (codes and tokens can travel in raw URLs).
    serializers: {
      req: (req: { method?: string; routeOptions?: { url?: string } }) => ({
        method: req.method,
        route: req.routeOptions?.url,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      // Messages can quote values (a database error, a parse error): keep type, code, stack.
      // The stack keeps only its `at …` frames: its first lines repeat the message, and a
      // failed query's message lists the SQL parameters (tokens, emails).
      err: (err: {
        name?: string;
        code?: unknown;
        stack?: string;
        statusCode?: number;
        cause?: unknown;
      }) => ({
        type: err.name ?? 'Error',
        message: '',
        stack: (err.stack ?? '')
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .join('\n'),
        code: err.code ?? (err.cause as { code?: unknown } | undefined)?.code,
        statusCode: err.statusCode,
      }),
    },
    redact: {
      paths: ['req.headers', 'headers.authorization', 'headers.cookie', '*.email', '*.token'],
      remove: true,
    },
  };
  if (logger === undefined || logger === true) return base;
  return { ...base, ...logger };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const db = options.db ?? null;
  const now = options.now ?? (() => new Date());

  const app = Fastify({
    logger: loggerOptions(config, options.logger),
    logController: new MinimalLogController(
      config.logLevel === 'debug' || config.logLevel === 'trace',
    ),
    // Trust exactly N proxy hops (Render: 1) so request.ip is the client, not the proxy.
    trustProxy: config.trustProxyHops > 0 ? (_addr, hop) => hop < config.trustProxyHops : false,
    bodyLimit: CLOUD_LIMITS.bodyBytes,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    return503OnClosing: true,
  });

  const inFlight = new InFlightWork();
  const mailer =
    options.mailer === undefined
      ? createResendMailer(config.email, { log: app.log })
      : options.mailer;
  // `resolveSession` is set below, once the auth module (which needs this context) exists.
  const ctx: AppContext = {
    config,
    db,
    pingDb: options.pingDb ?? (db ? () => pingDb(db) : async () => false),
    now,
    // Emails go out without making the request wait (sign-in codes, partner alerts); closing
    // the app still waits for them, so a code asked for just before a deploy arrives.
    mailer: mailer ? { send: (message) => inFlight.track(mailer.send(message)) } : null,
    coachModel:
      options.coachModel === undefined ? createAnthropicCoachModel(config.ai) : options.coachModel,
    resolveSession: async () => null,
    inFlight,
  };
  const auth = createAuth(ctx, app.log);
  ctx.resolveSession = options.resolveSession ?? auth?.resolveSession ?? (async () => null);

  app.decorate('ctx', ctx);
  app.decorateRequest('user', null);

  // --- Security headers. The strict CSP matters for the HTML pages under /cuenta and /i:
  // no inline scripts or styles, forms may post to ourselves and redirect to the loopback app.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'http://127.0.0.1:*'],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: config.env === 'production' ? { maxAge: 63_072_000 } : false,
  });

  // --- CORS: closed unless APP_ORIGINS lists origins. The desktop app calls from its main
  // process (no CORS), so this is only for future web clients. Cookies never cross origins.
  await app.register(cors, {
    origin: config.appOrigins.length > 0 ? config.appOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });

  // --- Sessions: resolved once per request when credentials are present, so the rate limiter
  // can key by user and handlers can read `request.user`. The lookup is a Postgres query, so
  // it runs only for routes that exist and use sessions, and only after a per-IP gate: the
  // route limiter below runs later (it needs the user to pick its key).
  const sessionGate = new FixedWindowLimiter(SESSION_LOOKUPS_PER_IP_PER_MINUTE, 60_000);
  app.addHook('onRequest', async (request) => {
    const h = request.headers;
    if (!h.authorization && !h.cookie) return;
    if (request.is404 || SESSIONLESS_ROUTES.has(request.routeOptions.url ?? '')) return;
    const waitMs = sessionGate.hit(clientKey(request.ip), now().getTime());
    if (waitMs > 0) {
      throw new ApiError(429, 'rate_limited', 'Too many requests', {
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      });
    }
    request.user = await ctx.resolveSession(h);
    // Cookie sessions: state-changing requests must come from our own pages (CSRF).
    assertCookieOrigin(request, config);
  });

  // --- Rate limits (in memory: one instance; a restart after sleeping resets them. Durable
  // quotas, AI and emails, live in Postgres). Routes override with `config.rateLimit`.
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (request) =>
      request.user ? `u:${request.user.userId}` : `ip:${clientKey(request.ip)}`,
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, 'rate_limited', 'Too many requests', {
        retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
      }),
  });

  // Bodies are JSON everywhere. The one HTML form (the «Conectar» button) has its urlencoded
  // parser on its own route only (routes/app-auth.ts): a form elsewhere gets 415 → 400.

  // --- Shutting down (boot.ts): requests in flight finish, a coach call included (its quota
  // reservation settles), but their keep-alive connections must not hold the server open
  // afterwards (Fastify keeps idle ones for 72 s), so each answer sent while closing ends its
  // connection.
  let draining = false;
  app.addHook('preClose', async () => {
    draining = true;
  });
  // Closing the HTTP server waits for connections, not handlers: a coach call whose client
  // left goes on without one. Every async handler is tracked, and `close()` waits for the last
  // one before it resolves (Fastify runs this hook after the server closed; boot.ts closes the
  // pool only then), so its reservation settles instead of dying with the process.
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function tracked(this: FastifyInstance, request, reply) {
      const result: unknown = handler.call(this, request, reply);
      return result instanceof Promise ? ctx.inFlight.track(result) : result;
    };
  });
  app.addHook('onClose', async () => {
    await ctx.inFlight.drain();
  });

  // --- No caching of API answers anywhere (they carry personal data).
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    if (draining) reply.header('connection', 'close');
    return payload;
  });

  // --- Error envelope.
  app.setErrorHandler((error: FastifyError | ApiError | Error, request, reply) => {
    const apiError = toApiError(error, request.log);
    if (apiError.statusCode === 429 && apiError.extras.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(apiError.extras.retryAfterSeconds));
    }
    return reply.status(apiError.statusCode).send(apiError.toBody());
  });
  // @fastify/rate-limit only hooks real routes: unknown ones get the default limit here.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (_request, reply) =>
    reply.status(404).send(new ApiError(404, 'not_found', 'No such route').toBody()),
  );

  // --- Routes.
  await app.register(healthRoutes);
  if (auth) await app.register(auth.routes);

  const staticCaps = deriveCapabilities(config, {
    dbUp: db ? true : null,
    aiBudgetExhausted: false,
  });
  await app.register(
    async (v1) => {
      // Without a database, auth secret or login method, nothing under /v1 can work.
      v1.addHook('onRequest', async () => {
        if (!db || !staticCaps.accounts.enabled) {
          throw featureDisabled('accounts', staticCaps.accounts.reason ?? 'missing_key');
        }
      });
      await v1.register(appAuthRoutes);
      await v1.register(meRoutes);
      await v1.register(sessionsRoutes);
      await v1.register(syncRoutes);
      await v1.register(friendsRoutes);
      await v1.register(rankingRoutes);
      await v1.register(presenceRoutes);
      await v1.register(accountabilityRoutes);
      await v1.register(coachRoutes);
    },
    { prefix: '/v1' },
  );

  await app.register(accountPages);
  await app.register(panelPages);
  await app.register(socialPages);

  return app;
}

function toApiError(error: FastifyError | ApiError | Error, log: FastifyBaseLogger): ApiError {
  if (error instanceof ApiError) {
    const expected = ['not_implemented', 'feature_disabled'].includes(error.code);
    if (error.statusCode >= 500 && !expected) {
      log.warn({ code: error.code }, 'api error');
    }
    return error;
  }
  if (isDatabaseUnavailable(error)) {
    log.error({ code: (error as { code?: unknown }).code }, 'database unavailable');
    return new ApiError(503, 'database_unavailable', 'The database does not answer');
  }
  const status = (error as FastifyError).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors: bad JSON, wrong content type, body too large…
    if (status === 413) return new ApiError(413, 'payload_too_large', 'Request body too large');
    if (status === 429) return new ApiError(429, 'rate_limited', 'Too many requests');
    return new ApiError(400, 'validation_failed', 'Malformed request');
  }
  log.error({ err: error }, 'unhandled error');
  return new ApiError(500, 'internal_error', 'Something went wrong');
}
