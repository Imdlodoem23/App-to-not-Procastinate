/**
 * Owner: CORE. docs/API.md §4 and §11.
 * - /cuenta: sign in (Google, or a 6-digit email code) and sign out.
 * - /cuenta/codigo: landing of the link in the sign-in email (the code travels in the URL
 *   fragment, which never reaches the server; a button signs in).
 * - /cuenta/conectar: «¿Conectar este ordenador?» for the desktop loopback login.
 * - /cuenta/assets/:name: tokens.css (from @centrate/shared), pages.css and registered assets.
 *
 * `?volver=` only accepts relative /cuenta paths, so no page can send the browser elsewhere.
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { deriveCapabilities } from '../config';
import { user } from '../db/schema';
import { notFound } from '../lib/errors';
import { hasControlChars } from '../lib/profile';
import { CHALLENGE_RE, STATE_RE } from '../routes/app-auth';
import { registerAccountAssets } from './assets';
import { html, page, pageAssets, PRIVACY_URL } from './layout';
import type { SafeHtml } from './layout';

const SCRIPTS = ['cuenta.js'];

/** A relative /cuenta path (no scheme, no host, no backslashes), else null. */
export function safeVolver(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (!/^\/cuenta(?:[/?#]|$)/.test(value)) return null;
  if (value.includes('//') || value.includes('\\') || hasControlChars(value)) return null;
  return value;
}

function sendPage(reply: FastifyReply, status: number, title: string, body: SafeHtml) {
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .send(page({ title, body, scripts: SCRIPTS }));
}

const statusLine = html`<p class="status" id="status" role="status" aria-live="polite"></p>`;

const unavailableBody = html`<section class="card">
  <h1>Cuentas no disponibles</h1>
  <p>
    Este servidor no tiene las cuentas activadas ahora mismo. Céntrate funciona igual sin cuenta:
    tus bloqueos, estadísticas y puntos siguen en tu ordenador.
  </p>
</section>`;

function signInBody(options: {
  volver: string;
  google: boolean;
  email: boolean;
  error: boolean;
}): SafeHtml {
  return html`<section class="card" data-volver="${options.volver}">
    <h1>Entrar en Céntrate</h1>
    <p class="muted">
      La cuenta es opcional: Céntrate funciona igual sin ella. Sirve para ver tus estadísticas en
      otros ordenadores, tener amigos y usar el coach, y solo compartes lo que actives.
    </p>
    ${
      options.error &&
      html`<p class="notice notice-error" role="alert">
        No se ha podido iniciar sesión. Vuelve a intentarlo.
      </p>`
    }
    ${
      options.google &&
      html`<div class="actions">
        <button type="button" class="button button-primary" id="google">
          Continuar con Google
        </button>
      </div>`
    }
    ${options.google && options.email && html`<p class="or">o</p>`}
    ${
      options.email &&
      html`<form id="email-form" class="stack" novalidate>
          <label for="email">Tu email</label>
          <input
            class="field"
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            maxlength="254"
            required
          />
          <button type="submit" class="button">Recibir un código por email</button>
        </form>
        <form id="code-form" class="stack" hidden>
          <p>
            Te hemos enviado un código de 6 cifras a <strong id="code-email"></strong>. Caduca en 10
            minutos.
          </p>
          <label for="otp">Código</label>
          <input
            class="field field-code"
            id="otp"
            name="otp"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            required
          />
          <button type="submit" class="button button-primary">Entrar</button>
          <button type="button" class="link-button" id="code-back">Usar otro email</button>
        </form>`
    }
    ${statusLine}
    <p class="fine">
      Para crear una cuenta debes tener al menos 14 años.
      <a href="${PRIVACY_URL}">Cómo tratamos tus datos</a>.
    </p>
  </section>`;
}

function signedInBody(email: string): SafeHtml {
  return html`<section class="card">
    <h1>Tu cuenta</h1>
    <p>Has iniciado sesión como <strong>${email}</strong>.</p>
    <div class="actions">
      <a class="button button-primary" href="/cuenta/panel">Ver mis estadísticas</a>
      <a class="button" href="/cuenta/avisos">Avisos de tus compañeros</a>
    </div>
    <p class="muted">
      Para conectar un ordenador, inicia sesión desde la aplicación de Céntrate en ese ordenador.
    </p>
    <div class="actions">
      <button type="button" class="button" id="sign-out">Cerrar sesión</button>
    </div>
    ${statusLine}
    <p class="fine"><a href="${PRIVACY_URL}">Cómo tratamos tus datos</a></p>
  </section>`;
}

const codeBody = html`<section class="card">
  <h1>Entrar con tu código</h1>
  <form id="link-form" class="stack">
    <label for="email">Email</label>
    <input
      class="field"
      id="email"
      name="email"
      type="email"
      autocomplete="email"
      maxlength="254"
      required
    />
    <label for="otp">Código</label>
    <input
      class="field field-code"
      id="otp"
      name="otp"
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength="6"
      required
    />
    <button type="submit" class="button button-primary">Entrar</button>
  </form>
  ${statusLine}
  <p class="fine">
    Comprueba que el email es el tuyo antes de pulsar «Entrar». ¿Ha caducado?
    <a href="/cuenta">Pide un código nuevo</a>.
  </p>
</section>`;

const badLinkBody = html`<section class="card">
  <h1>Este enlace de conexión no es válido</h1>
  <p>Vuelve a la aplicación de Céntrate y pulsa otra vez «Iniciar sesión».</p>
</section>`;

function connectBody(form: {
  challenge: string;
  state: string;
  port: number;
  device: string;
  email: string;
}): SafeHtml {
  return html`<section class="card">
    <h1>Conectar este ordenador</h1>
    <p>¿Conectar este ordenador («${form.device}») a tu cuenta <strong>${form.email}</strong>?</p>
    <p class="muted">
      La aplicación solo subirá lo que actives en sus ajustes (por ejemplo, tus totales diarios,
      solo números). Puedes desconectarlo cuando quieras.
    </p>
    <form method="post" action="/v1/app-auth/authorize" class="actions">
      <input type="hidden" name="challenge" value="${form.challenge}" />
      <input type="hidden" name="state" value="${form.state}" />
      <input type="hidden" name="port" value="${String(form.port)}" />
      <input type="hidden" name="device" value="${form.device}" />
      <button type="submit" class="button button-primary">Conectar</button>
      <a class="button" href="/cuenta">Cancelar</a>
    </form>
    <p class="fine">
      ¿No es tu cuenta?
      <button type="button" class="link-button" id="sign-out">Cerrar sesión</button>
    </p>
    ${statusLine}
  </section>`;
}

/** The device name the app sent, cleaned for display (it is escaped anyway). */
function deviceLabel(value: unknown): string {
  if (typeof value !== 'string') return 'este ordenador';
  const cleaned = value.replace(/\s+/g, ' ').trim().slice(0, 40);
  return cleaned && !hasControlChars(cleaned) ? cleaned : 'este ordenador';
}

export const accountPages: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  registerAccountAssets();
  const caps = deriveCapabilities(ctx.config);
  const accountsOn = Boolean(ctx.db) && caps.accounts.enabled;

  const emailOf = async (request: FastifyRequest): Promise<string | null> => {
    if (!ctx.db || !request.user) return null;
    const rows = await ctx.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, request.user.userId))
      .limit(1);
    return rows[0]?.email ?? null;
  };

  app.get<{ Querystring: Record<string, unknown> }>('/cuenta', async (request, reply) => {
    if (!accountsOn) return sendPage(reply, 503, 'Cuenta', unavailableBody);
    const volver = safeVolver(request.query.volver);
    const email = await emailOf(request);
    if (email && volver) return reply.redirect(volver, 303);
    if (email) return sendPage(reply, 200, 'Tu cuenta', signedInBody(email));
    return sendPage(
      reply,
      200,
      'Entrar',
      signInBody({
        volver: volver ?? '/cuenta',
        google: caps.googleLogin.enabled,
        email: caps.emailLogin.enabled && Boolean(ctx.mailer),
        error: typeof request.query.error === 'string',
      }),
    );
  });

  app.get('/cuenta/codigo', async (_request, reply) => {
    if (!accountsOn || !caps.emailLogin.enabled) {
      return sendPage(reply, 503, 'Cuenta', unavailableBody);
    }
    return sendPage(reply, 200, 'Entrar con tu código', codeBody);
  });

  app.get<{ Querystring: Record<string, unknown> }>('/cuenta/conectar', async (request, reply) => {
    if (!accountsOn) return sendPage(reply, 503, 'Cuenta', unavailableBody);
    const q = request.query;
    const port = typeof q.port === 'string' && /^\d{4,5}$/.test(q.port) ? Number(q.port) : NaN;
    const valid =
      typeof q.challenge === 'string' &&
      CHALLENGE_RE.test(q.challenge) &&
      typeof q.state === 'string' &&
      STATE_RE.test(q.state) &&
      port >= 1024 &&
      port <= 65_535;
    if (!valid) return sendPage(reply, 400, 'Conectar', badLinkBody);
    const device = deviceLabel(q.device);
    const email = await emailOf(request);
    if (!email) {
      const back = new URLSearchParams({
        challenge: String(q.challenge),
        state: String(q.state),
        port: String(port),
        device,
      });
      const volver = `/cuenta/conectar?${back.toString()}`;
      return reply.redirect(`/cuenta?${new URLSearchParams({ volver }).toString()}`, 303);
    }
    return sendPage(
      reply,
      200,
      'Conectar este ordenador',
      connectBody({
        challenge: String(q.challenge),
        state: String(q.state),
        port,
        device,
        email,
      }),
    );
  });

  app.get<{ Params: { name: string } }>('/cuenta/assets/:name', async (request, reply) => {
    const asset = pageAssets.get(request.params.name);
    if (!asset) throw notFound('No such asset');
    return reply
      .type(asset.contentType)
      .header('cache-control', 'public, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .send(asset.body);
  });
};
