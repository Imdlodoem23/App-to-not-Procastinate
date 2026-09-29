/**
 * The error envelope `{ error: { code, message, …extras } }` (see `CloudErrorBody`). Route code
 * throws `ApiError` (or one of the helpers below); the error handler in app.ts turns anything
 * else into a safe 4xx/5xx without leaking internals.
 */
import type {
  CloudConsent,
  CloudDisabledReason,
  CloudErrorBody,
  CloudErrorCode,
  CloudFeature,
  CloudValidationIssue,
} from '@centrate/shared/cloud-api';
import type { ZodError } from 'zod';

type Extras = Omit<CloudErrorBody['error'], 'code' | 'message'>;

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: CloudErrorCode;
  readonly extras: Extras;

  constructor(statusCode: number, code: CloudErrorCode, message: string, extras: Extras = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.extras = extras;
  }

  toBody(): CloudErrorBody {
    return { error: { code: this.code, message: this.message, ...this.extras } };
  }
}

export const notImplemented = (what = 'This endpoint'): never => {
  throw new ApiError(501, 'not_implemented', `${what} is not implemented yet`);
};

export const unauthorized = (message = 'Sign in first'): ApiError =>
  new ApiError(401, 'unauthorized', message);

export const forbidden = (message = 'Not allowed'): ApiError =>
  new ApiError(403, 'forbidden', message);

export const reauthRequired = (): ApiError =>
  new ApiError(403, 'reauth_required', 'This action needs a recent sign-in');

export const consentRequired = (consent: CloudConsent): ApiError =>
  new ApiError(403, 'consent_required', `Turn on sharing.${consent} first`, { consent });

export const notFound = (message = 'Not found'): ApiError =>
  new ApiError(404, 'not_found', message);

export const conflict = (
  code: Extract<
    CloudErrorCode,
    'conflict' | 'profile_incomplete' | 'limit_reached' | 'deadline_passed' | 'already_decided'
  >,
  message: string,
): ApiError => new ApiError(409, code, message);

export const featureDisabled = (feature: CloudFeature, reason: CloudDisabledReason): ApiError =>
  new ApiError(503, 'feature_disabled', `The ${feature} feature is not available`, {
    feature,
    reason,
  });

export const databaseUnavailable = (): ApiError =>
  new ApiError(503, 'database_unavailable', 'The database does not answer');

export const quotaExceeded = (resetsAt: Date): ApiError =>
  new ApiError(429, 'quota_exceeded', 'Daily quota used up', {
    resetsAt: resetsAt.toISOString(),
  });

export const validationFailed = (issues: CloudValidationIssue[], message = 'Invalid request') =>
  new ApiError(400, 'validation_failed', message, { issues });

/** Maps a zod error to a 400 without echoing the rejected values. */
export function fromZodError(error: ZodError, where: 'body' | 'query' | 'params'): ApiError {
  const issues = error.issues.slice(0, 20).map((i) => ({
    path: [where, ...i.path.map(String)].join('.'),
    message: i.message,
  }));
  return validationFailed(issues);
}

/** Socket errors: the database host is down, unreachable or dropped the connection. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE',
]);

/** Postgres SQLSTATEs that mean «not now», not «wrong query». */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  '53300', // too many connections
  '57014', // statement cancelled (statement_timeout: the database is too slow right now)
  '57P01', // admin shutdown
  '57P02', // crash shutdown
  '57P03', // cannot connect now
]);

/**
 * node-postgres and pg-pool connection failures that carry no `code`: a connect that timed out
 * («Connection terminated due to connection timeout», «timeout expired»), a pool with every
 * connection busy past `connectionTimeoutMillis` («timeout exceeded when trying to connect»),
 * a server that went away («Connection terminated unexpectedly») and the client-side
 * `query_timeout` («Query read timeout»).
 */
const PG_CONNECTION_MESSAGE =
  /^(Connection terminated|timeout exceeded when trying to connect|timeout expired$|Query read timeout$|Client has encountered a connection error)/;

/** Connection-level Postgres failures: the database is down, unreachable or overloaded. */
export function isDatabaseUnavailable(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code)) return true;
    if (code.startsWith('08')) return true; // connection exception class
  } else if (
    code === undefined &&
    err instanceof Error &&
    PG_CONNECTION_MESSAGE.test(err.message)
  ) {
    return true;
  }
  // Drizzle wraps driver errors (`DrizzleQueryError`, the original in `cause`).
  const cause = (err as { cause?: unknown }).cause;
  return depth < 3 && cause !== undefined && isDatabaseUnavailable(cause, depth + 1);
}
