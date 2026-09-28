/**
 * Stats sync and read-back (owner: CORE). docs/API.md §7.
 */
import type {
  PutDaysRequest,
  PutDaysResponse,
  StatsResponse,
  SyncStateResponse,
} from '@centrate/shared/cloud-api';
import { CLOUD_LIMITS } from '@centrate/shared/cloud-api';
import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from '../lib/errors';

export const syncRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { deviceId: string }; Reply: SyncStateResponse }>(
    '/sync/state',
    async () => notImplemented(),
  );
  app.put<{ Body: PutDaysRequest; Reply: PutDaysResponse }>(
    '/sync/days',
    {
      bodyLimit: CLOUD_LIMITS.syncBodyBytes,
      config: { rateLimit: { max: 60, timeWindow: '1 hour' } },
    },
    async () => notImplemented(),
  );
  // Deletes the caller's cloud stats (all devices, or `?deviceId=`). 204.
  app.delete<{ Querystring: { deviceId?: string } }>('/sync/days', async () => notImplemented());
  app.get<{ Querystring: { from: string; to: string }; Reply: StatsResponse }>('/stats', async () =>
    notImplemented(),
  );
};
