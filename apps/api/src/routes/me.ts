/**
 * Account, consent, devices and GDPR (owner: CORE). docs/API.md §5.1.
 */
import type {
  CloudDevice,
  CloudExport,
  DeleteAccountRequest,
  DevicesResponse,
  MeResponse,
  PatchDeviceRequest,
  PatchMeRequest,
} from '@centrate/shared/cloud-api';
import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from '../lib/errors';

const gdprLimit = { rateLimit: { max: 3, timeWindow: '1 hour' } };

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: MeResponse }>('/me', async () => notImplemented());
  app.patch<{ Body: PatchMeRequest; Reply: MeResponse }>('/me', async () => notImplemented());
  app.get<{ Reply: CloudExport }>('/me/export', { config: gdprLimit }, async () =>
    notImplemented(),
  );
  app.delete<{ Body: DeleteAccountRequest }>('/me', { config: gdprLimit }, async () =>
    notImplemented(),
  );

  app.get<{ Reply: DevicesResponse }>('/devices', async () => notImplemented());
  app.patch<{ Params: { id: string }; Body: PatchDeviceRequest; Reply: CloudDevice }>(
    '/devices/:id',
    async () => notImplemented(),
  );
  // Removes the device, its stats and its session. 204.
  app.delete<{ Params: { id: string } }>('/devices/:id', async () => notImplemented());
};
