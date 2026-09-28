/**
 * GET /health (public; also Render's health check). Never shows secrets: only which features
 * are on and why the others are off.
 */
import type { HealthResponse } from '@centrate/shared/cloud-api';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { API_VERSION, deriveCapabilities } from '../config';
import { isGlobalBudgetExhausted } from '../coach/budget';
import { meta } from '../db/schema';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: HealthResponse }>('/health', { config: { rateLimit: false } }, async () => {
    const { ctx } = app;
    const now = ctx.now();
    let db: HealthResponse['db'] = 'unconfigured';
    let serverEpoch: string | null = null;
    let aiBudgetExhausted = false;
    if (ctx.db) {
      db = (await ctx.pingDb()) ? 'up' : 'down';
      if (db === 'up') {
        try {
          const rows = await ctx.db
            .select({ value: meta.value })
            .from(meta)
            .where(eq(meta.key, 'server_epoch'))
            .limit(1);
          serverEpoch = rows[0]?.value ?? null;
          aiBudgetExhausted = await isGlobalBudgetExhausted(ctx.db, ctx.config, now);
        } catch {
          db = 'down';
        }
      }
    }
    return {
      ok: true,
      version: API_VERSION,
      now: now.toISOString(),
      db,
      serverEpoch,
      capabilities: deriveCapabilities(ctx.config, {
        dbUp: db === 'unconfigured' ? null : db === 'up',
        aiBudgetExhausted,
      }),
    };
  });
};
