/**
 * Authentication (owner: CORE). better-auth 1.7 with the drizzle adapter, Google (when
 * configured), email one-time codes through Resend (`emailOTP`, the email also carries a
 * sign-in link) and `bearer`. Only the endpoints our pages use are reachable under
 * /api/auth/*; everything else better-auth offers answers 404. See docs/API.md §4.
 *
 * Privacy: no telemetry, no IP or user agent stored, no Google picture, and the Google tokens
 * are dropped before they reach the database (we never call Google APIs). The profile row
 * (every sharing switch off) is created with the user; the Google first name only seeds its
 * display name and is then cleared from `user.name`.
 *
 * Account linking: a Google sign-in joins an existing account with the same address only when
 * Google says the address is verified (`email_verified`). Google is deliberately not a
 * «trusted provider»: that would skip the check and let an unverified Google address take
 * over the account.
 */
import { betterAuth } from 'better-auth';
import type { BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { emailOTP } from 'better-auth/plugins/email-otp';
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { deriveCapabilities } from '../config';
import type { AppContext, Mailer, SessionResolver } from '../context';
import { authSchema } from '../db/schema';
import { ApiError } from '../lib/errors';
import { ensureProfile, firstNameOnly } from '../lib/profile';
import { SIGN_IN_CODE_MINUTES, signInCodeEmail } from './email';
import { reserveSignInEmail } from './email-limits';
import {
  COOKIE_PREFIX,
  SESSION_TTL_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  createSessionResolver,
} from './session';

export interface AuthModule {
  resolveSession: SessionResolver;
  /** Registers /api/auth/* on the root instance. */
  routes: FastifyPluginAsync;
}

/** What better-auth may log through; messages are scrubbed of email addresses. */
type AuthLog = Pick<FastifyBaseLogger, 'warn' | 'error'>;

const EMAIL_RE = /[^\s@<>"']+@[^\s@<>"']+/g;
/** Shape check before anything is counted; better-auth validates the address again. */
const EMAIL_SHAPE = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[^\s@<>"',;.]{2,63}$/;

/** Null when accounts are off (no database, secret, URL or login method). */
export function createAuth(ctx: AppContext, log?: AuthLog): AuthModule | null {
  const { config } = ctx;
  if (!ctx.db || !config.auth || !deriveCapabilities(config).accounts.enabled) return null;
  const db = ctx.db;
  const authConfig = config.auth;
  const mailer = ctx.mailer;
  const emailOn = Boolean(config.email && mailer);

  const auth = betterAuth({
    appName: 'Céntrate',
    baseURL: authConfig.url,
    basePath: '/api/auth',
    secret: authConfig.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    trustedOrigins: [new URL(authConfig.url).origin, ...config.appOrigins],
    telemetry: { enabled: false },
    // Fastify's limiter covers these routes (app.ts and the routes below).
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // No cookie cache: revoking a session takes effect on the next request.
      cookieCache: { enabled: false },
    },
    account: {
      encryptOAuthTokens: true,
      // No `trustedProviders`: a Google identity joins an existing account only when Google
      // reports the address as verified (see the header).
      accountLinking: { enabled: true },
    },
    socialProviders: config.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            // openid email profile, no offline access (so no refresh token).
            scope: ['openid', 'email', 'profile'],
            prompt: 'select_account',
          },
        }
      : {},
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: authConfig.url.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      ipAddress: { disableIpTracking: true },
    },
    onAPIError: { errorURL: `${authConfig.url}/cuenta` },
    logger: {
      level: 'warn',
      log: (level, message) => {
        const scrubbed = String(message).replace(EMAIL_RE, '[email]').slice(0, 200);
        if (level === 'error') log?.error({ source: 'better-auth' }, scrubbed);
        else if (level === 'warn') log?.warn({ source: 'better-auth' }, scrubbed);
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Keep only a first name and never the picture. `ensureProfile` copies the name into
          // the display name (which the user can change) and then clears `user.name`.
          before: async (u) => ({ data: { ...u, name: firstNameOnly(u.name), image: null } }),
          after: async (u) => {
            await ensureProfile(db, u.id);
          },
        },
        update: {
          // Names and pictures are never stored after sign-up.
          before: async (u) => ({
            data: {
              ...u,
              ...('image' in u ? { image: null } : {}),
              ...(typeof u.name === 'string' ? { name: '' } : {}),
            },
          }),
        },
      },
      session: {
        create: {
          before: async (s) => ({ data: { ...s, ipAddress: null, userAgent: null } }),
        },
      },
      account: {
        create: {
          before: async (a) => ({ data: { ...a, ...NO_PROVIDER_TOKENS } }),
        },
        update: {
          before: async (a) => ({ data: { ...a, ...NO_PROVIDER_TOKENS } }),
        },
      },
    },
    plugins: [
      bearer(),
      ...(emailOn && mailer ? [emailCodePlugin(authConfig.url, mailer)] : []),
    ] as BetterAuthPlugin[],
  });

  const forward = (request: FastifyRequest, reply: FastifyReply) =>
    forwardToAuth(auth.handler, authConfig.url, request, reply);

  const routes: FastifyPluginAsync = async (app) => {
    app.get('/api/auth/get-session', forward);
    app.post('/api/auth/sign-out', forward);
    if (config.google) {
      app.post('/api/auth/sign-in/social', forward);
      app.get('/api/auth/callback/google', forward);
    }
    if (emailOn) {
      app.post(
        '/api/auth/email-otp/send-verification-otp',
        // The per-IP limit runs as a preHandler; the Postgres caps run after it, in the
        // handler, so a request refused by IP never counts against a mailbox.
        { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
        async (request, reply) => {
          const body = (request.body ?? {}) as { email?: unknown; type?: unknown };
          if (body.type !== 'sign-in' || typeof body.email !== 'string') {
            throw new ApiError(400, 'validation_failed', 'Only sign-in codes can be requested');
          }
          if (!EMAIL_SHAPE.test(body.email.trim())) {
            throw new ApiError(400, 'validation_failed', 'Not an email address');
          }
          // Mailbox and global caps, in Postgres (email-limits.ts).
          await reserveSignInEmail(db, config, authConfig.secret, body.email, ctx.now());
          return forward(request, reply);
        },
      );
      app.post(
        '/api/auth/sign-in/email-otp',
        { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
        forward,
      );
    }
  };

  return {
    resolveSession: createSessionResolver(db, authConfig.secret, ctx.now),
    routes,
  };
}

const NO_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

function emailCodePlugin(baseUrl: string, mailer: Mailer): BetterAuthPlugin {
  return emailOTP({
    otpLength: 6,
    expiresIn: SIGN_IN_CODE_MINUTES * 60,
    allowedAttempts: 5,
    storeOTP: 'hashed',
    // Sign-in creates the account on first use (it is still an explicit action by the user).
    disableSignUp: false,
    sendVerificationOTP: async ({ email, otp, type }) => {
      if (type !== 'sign-in') return;
      // Not awaited: the answer must not reveal how long sending took. The mailer logs failures.
      void mailer.send(signInCodeEmail(baseUrl, email, otp)).catch(() => undefined);
    },
  }) as BetterAuthPlugin;
}

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
]);

/** Hands a Fastify request to better-auth's fetch handler and copies the answer back. */
async function forwardToAuth(
  handler: (request: Request) => Promise<Response>,
  baseUrl: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const url = new URL(request.url, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  let body: string | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = JSON.stringify(request.body ?? {});
    headers.set('content-type', 'application/json');
  }
  const response = await handler(new Request(url, { method: request.method, headers, body }));
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key)) reply.header(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  return reply.send(await response.text());
}
