/**
 * Helpers for CORE's tests: browser cookies signed like better-auth's, the PKCE pair the
 * desktop app would create, and an app wired to the real session resolver.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE } from '../../src/auth/session';
import type { Db } from '../../src/db/client';
import { buildTestApp, fakeMailer, testConfig } from './app';
import type { FakeClock } from './app';
import type { Config } from '../../src/config';

export const TEST_ORIGIN = 'http://localhost:3000';

/** `Cookie` header value for a session token, signed with the auth secret. */
export function sessionCookie(token: string, config: Config = testConfig()): string {
  const secret = config.auth?.secret ?? '';
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return `${SESSION_COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface CoreApp {
  app: FastifyInstance;
  mailer: ReturnType<typeof fakeMailer>;
}

/** The app with the real resolver (better-auth cookies and bearer tokens). */
export async function buildCoreApp(
  db: Db,
  clock: FakeClock,
  config: Config = testConfig(),
): Promise<CoreApp> {
  const mailer = fakeMailer();
  const app = await buildTestApp({ db, clock, config, mailer, resolveSession: undefined });
  return { app, mailer };
}
