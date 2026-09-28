/**
 * Owner: CORE. docs/API.md §4 and §11.
 * - /cuenta: sign in (Google, or a 6-digit email code) and sign out.
 * - /cuenta/codigo: landing of the link in the sign-in email (the code travels in the URL
 *   fragment, which never reaches the server; a button signs in).
 * - /cuenta/conectar: «¿Conectar este ordenador?» for the desktop loopback login.
 * - /cuenta/assets/:name: tokens.css (from @centrate/shared), pages.css and registered assets.
 *
 * TODO(CORE): implement. The routes below reserve the paths.
 */
import type { FastifyPluginAsync } from 'fastify';
import { notImplemented } from '../lib/errors';

export const accountPages: FastifyPluginAsync = async (app) => {
  app.get('/cuenta', async () => notImplemented('The sign-in page'));
  app.get('/cuenta/codigo', async () => notImplemented('The email link page'));
  app.get('/cuenta/conectar', async () => notImplemented('The connect page'));
  app.get('/cuenta/assets/:name', async () => notImplemented('Page assets'));
};
