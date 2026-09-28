/**
 * CSRF rules (owner: CORE). docs/API.md §4.1.
 *
 * - Cookie sessions: besides `SameSite=Lax`, a state-changing request (not GET/HEAD/OPTIONS)
 *   authenticated by a cookie must come from our own pages: its `Origin` is the API origin or
 *   one in APP_ORIGINS, or the browser vouches for it with `Sec-Fetch-Site: same-origin` (a
 *   header pages cannot forge). Bearer requests are exempt: the desktop token is not an ambient
 *   credential.
 * - Sign-in routes (every POST under /api/auth): the same Origin rule, **with or without a
 *   cookie**, and JSON only. They create sessions, so a cross-site form must not reach them:
 *   a signed-out browser carries no cookie, and without this rule a page elsewhere could sign
 *   the visitor into the attacker's account (login CSRF) or make visitors' browsers request
 *   sign-in emails. A plain HTML form can only send urlencoded, multipart or text/plain bodies,
 *   never `application/json`.
 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { forbidden } from '../lib/errors';
import { hasBearer } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origins allowed to send cookie-authenticated writes. */
export function allowedOrigins(config: Config): string[] {
  const out = new Set<string>(config.appOrigins);
  if (config.auth) out.add(new URL(config.auth.url).origin);
  return [...out];
}

/** The request comes from one of our pages (or an APP_ORIGINS client), as the browser says. */
export function fromAllowedOrigin(request: FastifyRequest, config: Config): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && allowedOrigins(config).includes(origin)) {
    return true;
  }
  return request.headers['sec-fetch-site'] === 'same-origin';
}

/** True when the request passes the rule (or the rule does not apply to it). */
export function cookieRequestAllowed(request: FastifyRequest, config: Config): boolean {
  if (!request.user) return true;
  if (SAFE_METHODS.has(request.method)) return true;
  if (hasBearer(request.headers)) return true;
  return fromAllowedOrigin(request, config);
}

/** Throws 403 forbidden when a cookie-authenticated write comes from elsewhere. */
export function assertCookieOrigin(request: FastifyRequest, config: Config): void {
  if (!cookieRequestAllowed(request, config)) {
    throw forbidden('Cookie requests must come from this site');
  }
}

/** True for `application/json`, with or without parameters (`; charset=utf-8`). */
export function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * Sign-in routes: a POST must be JSON from an allowed origin, cookie or not. Throws 403
 * forbidden before anything is counted, created or forwarded to better-auth.
 */
export function assertSignInRequest(request: FastifyRequest, config: Config): void {
  if (SAFE_METHODS.has(request.method)) return;
  if (!isJsonContentType(request.headers['content-type']) || !fromAllowedOrigin(request, config)) {
    throw forbidden('Sign-in requests must come from this site');
  }
}
