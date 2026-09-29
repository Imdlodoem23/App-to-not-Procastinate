/**
 * Limits on sign-in code emails (owner: CORE). docs/API.md §12. Every code is a Resend email:
 * the free plan allows about 100 a day for everything we send (codes and partner alerts), and
 * bounces from made-up addresses hurt the sender domain. Checked, in this order, before
 * better-auth creates a code:
 *
 * 1. per IP (/64 for IPv6): 5 per 15 minutes, the Fastify route limit (in memory);
 * 2. per mailbox: 3 per hour and 10 per UTC day, in Postgres (survives restarts), keyed by an
 *    HMAC of the normalised address, so `ana+1@gmail.com` and `a.na@gmail.com` share Ana's
 *    counter and the table never holds an address;
 * 3. globally: `SIGNIN_EMAILS_PER_DAY` per UTC day, in Postgres. Past it the route answers
 *    503 `feature_disabled` (`emailLogin`, `budget`) and /health says so until 00:00 UTC.
 */
import { createHmac } from 'node:crypto';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { ApiError, featureDisabled } from '../lib/errors';
import { isCounterExhausted, takeFromCounter } from '../lib/counters';
import type { CounterLimit } from '../lib/counters';

export const EMAIL_CODES_PER_HOUR = 3;
export const EMAIL_CODES_PER_DAY = 10;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const GLOBAL_KEY = 'signin_email:global';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * One key per mailbox: lower case, the `+tag` removed, and for Gmail the dots removed and
 * googlemail.com read as gmail.com (both deliver to the same inbox).
 */
export function normalizeMailbox(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1).replace(/\.$/, '');
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '') || local;
  }
  return `${local}@${domain}`;
}

/** The counter key of a mailbox: an HMAC, so the table never holds an address. */
export function mailboxKey(email: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(normalizeMailbox(email)).digest('base64url');
  return `signin_email:mailbox:${mac}`;
}

const globalLimit = (config: Config): CounterLimit => ({
  key: GLOBAL_KEY,
  windowMs: DAY_MS,
  max: config.email?.signInCodesPerDay ?? 0,
});

/** True when today's sign-in emails reached `SIGNIN_EMAILS_PER_DAY` (for /health). */
export function signInEmailBudgetExhausted(db: Db, config: Config, now: Date): Promise<boolean> {
  return isCounterExhausted(db, globalLimit(config), now);
}

const tooMany = (retryAfterMs: number): ApiError =>
  new ApiError(429, 'rate_limited', 'Too many codes for this address', {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });

/**
 * Takes one sign-in email from the mailbox's and the global allowance, or throws 429
 * `rate_limited` (mailbox) or 503 `feature_disabled` (global cap).
 */
export async function reserveSignInEmail(
  db: Db,
  config: Config,
  secret: string,
  email: string,
  now: Date,
): Promise<void> {
  const global = globalLimit(config);
  // A spent global cap must not also use up the mailbox's allowance.
  if (await isCounterExhausted(db, global, now)) throw featureDisabled('emailLogin', 'budget');
  const key = mailboxKey(email, secret);
  for (const [windowMs, max] of [
    [HOUR_MS, EMAIL_CODES_PER_HOUR],
    [DAY_MS, EMAIL_CODES_PER_DAY],
  ] as const) {
    const result = await takeFromCounter(db, { key, windowMs, max }, now);
    if (!result.ok) throw tooMany(result.retryAfterMs);
  }
  const taken = await takeFromCounter(db, global, now);
  if (!taken.ok) throw featureDisabled('emailLogin', 'budget');
}
