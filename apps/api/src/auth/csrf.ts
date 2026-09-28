/**
 * CSRF rule for cookie sessions (owner: CORE). Besides `SameSite=Lax`, a state-changing request
 * (not GET/HEAD/OPTIONS) authenticated by a cookie must come from our own pages: its `Origin`
 * is the API origin or one in APP_ORIGINS, or the browser vouches for it with
 * `Sec-Fetch-Site: same-origin` (a header pages cannot forge). Bearer requests are exempt: the
 * desktop token is not an ambient credential. docs/API.md §4.1.
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

/** True when the request passes the rule (or the rule does not apply to it). */
export function cookieRequestAllowed(request: FastifyRequest, config: Config): boolean {
  if (!request.user) return true;
  if (SAFE_METHODS.has(request.method)) return true;
  if (hasBearer(request.headers)) return true;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && allowedOrigins(config).includes(origin)) {
    return true;
  }
  return request.headers['sec-fetch-site'] === 'same-origin';
}

/** Throws 403 forbidden when a cookie-authenticated write comes from elsewhere. */
export function assertCookieOrigin(request: FastifyRequest, config: Config): void {
  if (!cookieRequestAllowed(request, config)) {
    throw forbidden('Cookie requests must come from this site');
  }
}
