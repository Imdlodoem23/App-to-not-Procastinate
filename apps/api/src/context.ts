/**
 * What every route can reach: `app.ctx` (config, database, clock, mailer, coach model) and
 * `request.user` (the signed-in session, or null). Declared here so builders share one shape.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config';
import type { CoachModel } from './coach/model';
import type { Db } from './db/client';
import type { InFlightWork } from './lib/in-flight';

/** A resolved session: a browser cookie or the desktop app's bearer token. */
export interface AuthedUser {
  userId: string;
  sessionId: string;
  /**
   * When the person last proved who they are: a browser session's creation (the sign-in), or
   * for a desktop session the sign-in behind the browser session that connected it. The
   * fresh-session rule (`requireFreshSession`) reads this, never the session's own age.
   */
  authenticatedAt: Date;
  /** The device row bound to this session (desktop bearer sessions), else null. */
  deviceId: string | null;
}

/** Reads the session from the request headers; null when there is none or it is invalid. */
export type SessionResolver = (headers: IncomingHttpHeaders) => Promise<AuthedUser | null>;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string | null;
  /** For counters and tests only; never logged with the address. */
  tag: 'sign_in_code' | 'partner_alert' | 'partner_link';
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface AppContext {
  config: Config;
  /** Null when DATABASE_URL is unset: every /v1 route answers 503 feature_disabled. */
  db: Db | null;
  pingDb: () => Promise<boolean>;
  now: () => Date;
  /** Null when Resend is not configured. */
  mailer: Mailer | null;
  /** Null when the coach is not configured (no key or kill switch). */
  coachModel: CoachModel | null;
  resolveSession: SessionResolver;
  /** Route handlers still running; `app.close()` waits for them (lib/in-flight.ts). */
  inFlight: InFlightWork;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: AuthedUser | null;
  }
}
