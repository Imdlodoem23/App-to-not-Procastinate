/**
 * Sessions (owner: CORE). better-auth writes the `session` rows for browser sign-ins; the desktop
 * login (routes/app-auth.ts) writes its own row with `createSessionRow`. Both are read here, on
 * every request that carries credentials, straight from the table: no cookie cache, so a revoked
 * or deleted session stops working at once. docs/API.md §4.
 *
 * - Bearer (`Authorization: Bearer <token>`): the desktop app. The raw session token, or the
 *   signed `token.signature` form better-auth's `bearer` plugin hands out.
 * - Cookie: better-auth's signed session cookie (`centrate.session_token`, `__Secure-` prefixed
 *   over https). When a bearer header is present the cookie is ignored.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { eq } from 'drizzle-orm';
import type { AuthedUser, SessionResolver } from '../context';
import type { Db } from '../db/client';
import { devices, session } from '../db/schema';

/** Sessions last 60 days and slide: used once a day or more, they never expire. */
export const SESSION_TTL_SECONDS = 60 * 86_400;
/** A session's expiry is pushed forward at most once per this period. */
export const SESSION_UPDATE_AGE_SECONDS = 86_400;

export const COOKIE_PREFIX = 'centrate';
export const SESSION_COOKIE = `${COOKIE_PREFIX}.session_token`;
/** Both spellings: better-auth adds `__Secure-` when the base URL is https. */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE, `__Secure-${SESSION_COOKIE}`] as const;

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random `[A-Za-z0-9]` string (the alphabet better-auth uses for ids and tokens). */
export function randomAlphanumeric(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  return out;
}

const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** True when the request authenticates with a bearer header (exempt from the Origin check). */
export function hasBearer(headers: IncomingHttpHeaders): boolean {
  const h = headers.authorization;
  return typeof h === 'string' && h.slice(0, 7).toLowerCase() === 'bearer ';
}

/** Parses a Cookie header into a map (first value wins, values URL-decoded). */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (out.has(key)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; it will fail the signature check.
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Checks better-call's signed value `token.base64(HMAC-SHA256(secret, token))` and returns the
 * token, or null.
 */
export function verifySignedToken(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const token = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = createHmac('sha256', secret).update(token).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return RAW_TOKEN_RE.test(token) ? token : null;
}

/** The session token a request carries (bearer first, then the cookie), or null. */
export function sessionTokenFrom(headers: IncomingHttpHeaders, secret: string): string | null {
  if (hasBearer(headers)) {
    let value = String(headers.authorization).slice(7).trim();
    if (value.includes('%')) {
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
    }
    if (value.includes('.')) return verifySignedToken(value, secret);
    return RAW_TOKEN_RE.test(value) ? value : null;
  }
  const cookies = parseCookieHeader(headers.cookie);
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (value) return verifySignedToken(value, secret);
  }
  return null;
}

/** Reads the session behind a request from the database, sliding its expiry once a day. */
export function createSessionResolver(db: Db, secret: string, now: () => Date): SessionResolver {
  return async (headers): Promise<AuthedUser | null> => {
    const token = sessionTokenFrom(headers, secret);
    if (!token) return null;
    const rows = await db
      .select({
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        deviceId: devices.id,
      })
      .from(session)
      .leftJoin(devices, eq(devices.sessionId, session.id))
      .where(eq(session.token, token))
      .limit(1);
    const row = rows[0];
    const at = now();
    if (!row || row.expiresAt.getTime() <= at.getTime()) return null;
    const refreshBelowMs = (SESSION_TTL_SECONDS - SESSION_UPDATE_AGE_SECONDS) * 1000;
    if (row.expiresAt.getTime() - at.getTime() < refreshBelowMs) {
      await db
        .update(session)
        .set({ expiresAt: new Date(at.getTime() + SESSION_TTL_SECONDS * 1000), updatedAt: at })
        .where(eq(session.id, row.id));
    }
    return {
      userId: row.userId,
      sessionId: row.id,
      sessionCreatedAt: row.createdAt,
      deviceId: row.deviceId ?? null,
    };
  };
}

export interface NewSession {
  id: string;
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Inserts a session row the same shape better-auth writes (32-char ids and tokens), without IP
 * or user agent. Used by the desktop login; the token is the app's bearer token.
 */
export async function createSessionRow(db: Db, userId: string, at: Date): Promise<NewSession> {
  const row: NewSession = {
    id: randomAlphanumeric(32),
    token: randomAlphanumeric(32),
    createdAt: at,
    expiresAt: new Date(at.getTime() + SESSION_TTL_SECONDS * 1000),
  };
  await db.insert(session).values({
    ...row,
    userId,
    updatedAt: at,
    ipAddress: null,
    userAgent: null,
  });
  return row;
}
