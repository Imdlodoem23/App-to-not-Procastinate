/**
 * What every route can reach: `app.ctx` (config, database, clock, mailer, coach model) and
 * `request.user` (the signed-in session, or null). Declared here so builders share one shape.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config';
import type { CoachModel } from './coach/model';
import type { Db } from './db/client';

/** A resolved session: a browser cookie or the desktop app's bearer token. */
export interface AuthedUser {
  userId: string;
  sessionId: string;
  sessionCreatedAt: Date;
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
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: AuthedUser | null;
  }
}
