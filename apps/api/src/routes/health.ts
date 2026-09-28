/**
 * GET /health (public; also Render's health check). Never shows secrets: only which features
 * are on and why the others are off.
 *
 * What it reads from Postgres (ping, server epoch, AI kill switch and budget, the sign-in email
 * cap) is cached for `HEALTH_PROBE_TTL_MS` behind one in-flight probe, so a flood of health
 * checks costs no queries. The route has its own generous per-IP limit, far above what Render's
 * checker or the desktop app need, and never resolves a session (app.ts).
 */
import type { HealthResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { API_VERSION, deriveCapabilities } from '../config';
import { signInEmailBudgetExhausted } from '../auth/email-limits';
import { isCoachBreakerOpen } from '../coach/breaker';
import { readAiRuntime } from '../coach/budget';
import { meta } from '../db/schema';

export const HEALTH_PROBE_TTL_MS = 10_000;
export const HEALTH_PER_IP_PER_MINUTE = 300;

interface Probe {
  db: HealthResponse['db'];
  serverEpoch: string | null;
  aiKillSwitch: boolean;
  aiBudgetExhausted: boolean;
  emailBudgetExhausted: boolean;
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  /** One pass over the database. Never throws: any failure reads as `db: down`. */
  const probe = async (): Promise<Probe> => {
    const out: Probe = {
      db: 'unconfigured',
      serverEpoch: null,
      aiKillSwitch: false,
      aiBudgetExhausted: false,
      emailBudgetExhausted: false,
    };
    if (!ctx.db) return out;
    out.db = (await ctx.pingDb()) ? 'up' : 'down';
    if (out.db !== 'up') return out;
    try {
      const now = ctx.now();
      const rows = await ctx.db
        .select({ value: meta.value })
        .from(meta)
        .where(eq(meta.key, 'server_epoch'))
        .limit(1);
      out.serverEpoch = rows[0]?.value ?? null;
      const ai = await readAiRuntime(ctx.db, ctx.config, now);
      out.aiKillSwitch = ai.aiKillSwitch;
      out.aiBudgetExhausted = ai.aiBudgetExhausted;
      if (ctx.config.email) {
        out.emailBudgetExhausted = await signInEmailBudgetExhausted(ctx.db, ctx.config, now);
      }
    } catch {
      return { ...out, db: 'down', serverEpoch: null };
    }
    return out;
  };

  let cached: { atMs: number; value: Probe } | null = null;
  let inFlight: Promise<Probe> | null = null;
  const currentProbe = (): Promise<Probe> => {
    const nowMs = ctx.now().getTime();
    if (cached && nowMs >= cached.atMs && nowMs - cached.atMs < HEALTH_PROBE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    inFlight ??= probe()
      .then((value) => {
        cached = { atMs: ctx.now().getTime(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  app.get<{ Reply: HealthResponse }>(
    '/health',
    { config: { rateLimit: { max: HEALTH_PER_IP_PER_MINUTE, timeWindow: '1 minute' } } },
    async () => {
      const p = await currentProbe();
      return {
        ok: true,
        version: API_VERSION,
        now: ctx.now().toISOString(),
        db: p.db,
        serverEpoch: p.serverEpoch,
        capabilities: deriveCapabilities(ctx.config, {
          dbUp: p.db === 'unconfigured' ? null : p.db === 'up',
          aiKillSwitch: p.aiKillSwitch,
          // In memory, so read now rather than through the cached probe.
          aiBreakerOpen: isCoachBreakerOpen(ctx.coachModel, ctx.now()),
          aiBudgetExhausted: p.aiBudgetExhausted,
          emailBudgetExhausted: p.emailBudgetExhausted,
        }),
      };
    },
  );
};
