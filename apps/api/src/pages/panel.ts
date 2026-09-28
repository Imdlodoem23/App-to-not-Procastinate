/**
 * Owner: CLIENT. docs/API.md §11.
 * - /cuenta/panel: the web dashboard (charts of the synced stats, devices, «Descargar mis
 *   datos», «Borrar mi cuenta»).
 * - /cuenta/avisos: a partner's inbox on the web, to approve or deny from the phone when the
 *   email arrives.
 * Both are thin HTML shells (layout.ts) whose registered script calls the JSON API with the
 * browser's cookie session and draws SVG with DOM calls (no inline scripts or styles).
 *
 * TODO(CLIENT): implement.
 */
import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from '../lib/errors';

export const panelPages: FastifyPluginAsync = async (app) => {
  app.get('/cuenta/panel', async () => notImplemented('The dashboard'));
  app.get('/cuenta/avisos', async () => notImplemented('The partner inbox page'));
};
