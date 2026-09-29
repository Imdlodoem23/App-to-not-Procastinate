/**
 * Sessions (owner: CORE). docs/API.md §4.1 and §5.1.
 *
 * Browser (cookie) sessions last 14 days from sign-in; desktop ones are the devices
 * (routes/me.ts). These routes let the user see their open browser sessions and end every
 * other one, for instance after signing in on a shared or lost computer. Only dates are shown:
 * no IP address or browser name is ever stored.
 */
import type {
  RevokeOtherSessionsRequest,
  RevokeOtherSessionsResponse,
  SessionsResponse,
} from '@centrate/shared/cloud-api';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listBrowserSessions, revokeOtherSessions } from '../auth/session';
import { parseBody, requireDb, requireFreshSession, requireUser } from '../lib/guards';

const RevokeSchema = z
  .object({ includeDevices: z.boolean().optional() })
  .strict() satisfies z.ZodType<RevokeOtherSessionsRequest>;

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  const { ctx } = app;

  app.get<{ Reply: SessionsResponse }>('/sessions', async (request) => {
    const db = requireDb(ctx);
    const me = requireUser(request);
    const rows = await listBrowserSessions(db, me.userId, ctx.now());
    return {
      browser: rows.map((r) => ({
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        current: r.id === me.sessionId,
      })),
    };
  });

  // Cookie or bearer; a cookie request passes the Origin rule first (app.ts). Signing out the
  // user's computers as well is the heavier action and needs a fresh session (§4.3), so an old
  // session left somewhere cannot disconnect them.
  app.post<{ Body: RevokeOtherSessionsRequest; Reply: RevokeOtherSessionsResponse }>(
    '/sessions/revoke-others',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request) => {
      const db = requireDb(ctx);
      const me = requireUser(request);
      const { includeDevices = false } = parseBody(RevokeSchema, request);
      const now = ctx.now();
      if (includeDevices) requireFreshSession(me, now);
      return revokeOtherSessions(db, me, includeDevices, now);
    },
  );
};
