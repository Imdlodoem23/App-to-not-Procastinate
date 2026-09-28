/**
 * Configuration comes only from environment variables (documented in `.env.example` and
 * docs/API.md §2). Nothing else in the API reads `process.env`.
 *
 * Rules:
 * - A missing key disables its feature cleanly (health says why, the routes answer
 *   503 `feature_disabled`); the process still starts.
 * - A key that is set but malformed (a short secret, a URL that is not a URL) is a
 *   deployment mistake: `loadConfig` throws `ConfigError` listing every problem.
 * - A pair with only one half set (Google id without secret) counts as missing and adds a
 *   warning that the server logs at boot.
 */
import { z } from 'zod';
import type {
  CloudCapabilities,
  CloudCapability,
  CloudDisabledReason,
  CloudFeature,
} from '@centrate/shared/cloud-api';

export const API_VERSION = '0.1.0';

/** Current models (claude-api skill, 2026-09): a fast cheap one and a capable one. */
export const DEFAULT_AI_MODELS = Object.freeze({
  interpret: 'claude-haiku-4-5',
  coach: 'claude-opus-5',
});

export interface AiLimits {
  userDailyInterpretRequests: number;
  userDailyCoachRequests: number;
  /** Input + output tokens per user per UTC day, all coach features together. */
  userDailyTokens: number;
  /** Global spend cap per UTC day, in US dollars (0 turns the AI off). */
  globalDailyBudgetUsd: number;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Reverse proxies in front of the service (Render: 1). 0 trusts no X-Forwarded-For. */
  trustProxyHops: number;
  databaseUrl: string | null;
  /** `null` when BETTER_AUTH_SECRET or BETTER_AUTH_URL is missing. */
  auth: { secret: string; url: string } | null;
  /** CORS allow-list; empty means no cross-origin access at all. */
  appOrigins: string[];
  google: { clientId: string; clientSecret: string } | null;
  /** Resend, used for sign-in codes and partner alerts. */
  email: { resendApiKey: string; from: string } | null;
  ai: {
    apiKey: string | null;
    /** Kill switch, `AI_ENABLED`. */
    enabled: boolean;
    models: { interpret: string; coach: string };
    limits: AiLimits;
  };
  /** Non-fatal problems to log once at boot (never contains secret values). */
  warnings: string[];
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// Empty strings count as unset: Render and .env files often carry `KEY=`.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional(),
  );

const intInRange = (min: number, max: number, fallback: number) =>
  optional(z.coerce.number().int().min(min).max(max)).transform((v) => v ?? fallback);

const bool = (fallback: boolean) =>
  optional(z.enum(['true', 'false', '1', '0', 'yes', 'no'])).transform((v) =>
    v === undefined ? fallback : v === 'true' || v === '1' || v === 'yes',
  );

const modelId = optional(z.string().regex(/^[a-z0-9][a-z0-9.-]{2,63}$/, 'must be a model id'));

const EnvSchema = z.object({
  NODE_ENV: optional(z.enum(['development', 'test', 'production'])).transform(
    (v) => v ?? 'development',
  ),
  HOST: optional(z.string()).transform((v) => v ?? '0.0.0.0'),
  PORT: intInRange(1, 65_535, 3000),
  LOG_LEVEL: optional(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  ).transform((v) => v ?? 'info'),
  TRUST_PROXY_HOPS: intInRange(0, 5, 0),

  DATABASE_URL: optional(
    z.string().regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL'),
  ),
  BETTER_AUTH_SECRET: optional(z.string().min(32, 'must be at least 32 characters')),
  BETTER_AUTH_URL: optional(
    z.url({ protocol: /^https?$/ }).transform((v) => v.replace(/\/+$/, '')),
  ),
  APP_ORIGINS: optional(z.string()),

  GOOGLE_CLIENT_ID: optional(z.string().min(1)),
  GOOGLE_CLIENT_SECRET: optional(z.string().min(1)),
  RESEND_API_KEY: optional(z.string().min(1)),
  EMAIL_FROM: optional(
    z.string().regex(/^(?:[^<>\r\n]{1,64} <[^\s<>@]+@[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/, {
      message: 'must be an email address or «Name <address>»',
    }),
  ),

  ANTHROPIC_API_KEY: optional(z.string().min(1)),
  AI_ENABLED: bool(true),
  AI_MODEL_INTERPRET: modelId,
  AI_MODEL_COACH: modelId,
  AI_USER_DAILY_INTERPRET_REQUESTS: intInRange(0, 1000, 30),
  AI_USER_DAILY_COACH_REQUESTS: intInRange(0, 1000, 10),
  AI_USER_DAILY_TOKENS: intInRange(0, 10_000_000, 150_000),
  AI_GLOBAL_DAILY_BUDGET_USD: optional(z.coerce.number().min(0).max(10_000)).transform(
    (v) => v ?? 2,
  ),
});

function parseOrigins(raw: string | undefined, issues: string[]): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    const url = URL.canParse(value) ? new URL(value) : null;
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
      issues.push(`APP_ORIGINS: «${value}» is not an origin like https://example.com`);
      continue;
    }
    out.push(url.origin);
  }
  return out;
}

/** Parses the environment. Throws `ConfigError` when a value is set but invalid. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only variable names and rule messages: never echo the values (they may be secrets).
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];
  const warnings: string[] = [];

  const appOrigins = parseOrigins(e.APP_ORIGINS, issues);

  if (
    e.NODE_ENV === 'production' &&
    e.BETTER_AUTH_URL &&
    !e.BETTER_AUTH_URL.startsWith('https://')
  ) {
    issues.push('BETTER_AUTH_URL: must use https in production');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const pair = (a: string, av: string | undefined, b: string, bv: string | undefined): boolean => {
    if (av && bv) return true;
    if (av || bv) warnings.push(`${av ? b : a} is missing, so ${av ? a : b} is ignored`);
    return false;
  };

  const auth =
    e.BETTER_AUTH_SECRET && e.BETTER_AUTH_URL
      ? { secret: e.BETTER_AUTH_SECRET, url: e.BETTER_AUTH_URL }
      : null;
  if (!auth && (e.BETTER_AUTH_SECRET || e.BETTER_AUTH_URL)) {
    warnings.push('BETTER_AUTH_SECRET and BETTER_AUTH_URL are both needed; accounts are off');
  }

  const google = pair(
    'GOOGLE_CLIENT_ID',
    e.GOOGLE_CLIENT_ID,
    'GOOGLE_CLIENT_SECRET',
    e.GOOGLE_CLIENT_SECRET,
  )
    ? { clientId: e.GOOGLE_CLIENT_ID as string, clientSecret: e.GOOGLE_CLIENT_SECRET as string }
    : null;
  const email = pair('RESEND_API_KEY', e.RESEND_API_KEY, 'EMAIL_FROM', e.EMAIL_FROM)
    ? { resendApiKey: e.RESEND_API_KEY as string, from: e.EMAIL_FROM as string }
    : null;

  return Object.freeze({
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    databaseUrl: e.DATABASE_URL ?? null,
    auth,
    appOrigins,
    google,
    email,
    ai: {
      apiKey: e.ANTHROPIC_API_KEY ?? null,
      enabled: e.AI_ENABLED,
      models: {
        interpret: e.AI_MODEL_INTERPRET ?? DEFAULT_AI_MODELS.interpret,
        coach: e.AI_MODEL_COACH ?? DEFAULT_AI_MODELS.coach,
      },
      limits: {
        userDailyInterpretRequests: e.AI_USER_DAILY_INTERPRET_REQUESTS,
        userDailyCoachRequests: e.AI_USER_DAILY_COACH_REQUESTS,
        userDailyTokens: e.AI_USER_DAILY_TOKENS,
        globalDailyBudgetUsd: e.AI_GLOBAL_DAILY_BUDGET_USD,
      },
    },
    warnings,
  });
}

/** Runtime facts that change capabilities after boot. */
export interface RuntimeState {
  /** `null` when DATABASE_URL is unset; `false` when Postgres does not answer. */
  dbUp: boolean | null;
  /** The global daily AI budget is spent. */
  aiBudgetExhausted: boolean;
  /** The runtime kill switch in Postgres is on (`meta.ai_kill_switch`, src/coach/budget.ts). */
  aiKillSwitch?: boolean;
}

const on: CloudCapability = Object.freeze({ enabled: true, reason: null });
const off = (reason: CloudDisabledReason): CloudCapability => ({ enabled: false, reason });

/**
 * What the server can do right now. `accounts` needs a database, the auth secret and URL and
 * at least one login method; every other feature needs `accounts`.
 */
export function deriveCapabilities(
  config: Config,
  state: RuntimeState = { dbUp: true, aiBudgetExhausted: false },
): CloudCapabilities {
  const loginMethods = Boolean(config.google) || Boolean(config.email);
  let accounts: CloudCapability;
  if (!config.databaseUrl || !config.auth || !loginMethods) accounts = off('missing_key');
  else if (state.dbUp === false) accounts = off('database_down');
  else accounts = on;

  const needs = (extra: boolean): CloudCapability =>
    !accounts.enabled ? accounts : extra ? on : off('missing_key');

  let coach: CloudCapability;
  if (!accounts.enabled) coach = accounts;
  else if (!config.ai.apiKey) coach = off('missing_key');
  else if (!config.ai.enabled || state.aiKillSwitch) coach = off('kill_switch');
  else if (config.ai.limits.globalDailyBudgetUsd <= 0 || state.aiBudgetExhausted) {
    coach = off('budget');
  } else coach = on;

  const caps: Record<CloudFeature, CloudCapability> = {
    accounts,
    googleLogin: needs(Boolean(config.google)),
    emailLogin: needs(Boolean(config.email)),
    sync: accounts,
    social: accounts,
    partnerEmails: needs(Boolean(config.email)),
    coach,
  };
  return caps;
}
