/**
 * /i/:code: the public invite landing page (owner: SOCIAL). docs/API.md §11. It shows the
 * code to copy and how to add it in the app; it never looks the code up or shows who invited
 * (the page is public, anyone with the link can open it). A malformed code gets a 404 page.
 */
import type { FastifyPluginAsync } from 'fastify';
import { html, page, registerPageAsset } from './layout';
import { formatInviteCode, normalizeInviteCode } from '../social/codes';

/** The download page of the static site. */
export const DOWNLOAD_URL = 'https://centrate.onrender.com/descargar';

/**
 * «Copiar» (no inline scripts under the CSP). The button stays hidden without JavaScript or
 * clipboard access; the code is plain selectable text either way.
 */
const INVITE_JS = `'use strict';
(function () {
  var button = document.querySelector('[data-copy]');
  if (!button || !navigator.clipboard) return;
  var label = button.textContent;
  button.hidden = false;
  button.addEventListener('click', function () {
    navigator.clipboard.writeText(button.getAttribute('data-copy') || '').then(
      function () { button.textContent = 'Copiado'; },
      function () { button.textContent = 'No se ha podido copiar'; }
    );
    setTimeout(function () { button.textContent = label; }, 2000);
  });
})();
`;

function invitePage(code: string): string {
  return page({
    title: 'Te han invitado',
    scripts: ['invitacion.js'],
    body: html`<section class="card invite">
      <h1>Te han invitado a Céntrate</h1>
      <p>
        Alguien quiere ser tu amigo en Céntrate para ver quién está concentrado ahora y
        compararse en el ranking semanal. Solo verá lo que tú decidas compartir.
      </p>
      <p class="invite-code-row">
        <code class="invite-code" id="codigo">${code}</code>
        <button type="button" class="button" data-copy="${code}" hidden>Copiar</button>
      </p>
      <h2>Cómo añadirlo</h2>
      <ol class="steps">
        <li>Abre Céntrate en tu ordenador.</li>
        <li>Ve a <strong>Amigos</strong> y pulsa <strong>«Tengo un código»</strong>.</li>
        <li>Escribe o pega el código. Caduca a los 7 días.</li>
      </ol>
      <p class="muted">
        ¿Aún no tienes Céntrate? <a href="${DOWNLOAD_URL}">Descárgalo gratis</a>. Para usar
        amigos necesitas iniciar sesión en la app.
      </p>
    </section>`,
  });
}

function invalidPage(): string {
  return page({
    title: 'Invitación no válida',
    body: html`<section class="card invite">
      <h1>Este enlace de invitación no es válido</h1>
      <p>Revisa que lo has copiado entero o pide a tu amigo un código nuevo.</p>
      <p class="muted"><a href="${DOWNLOAD_URL}">Ir a la web de Céntrate</a></p>
    </section>`,
  });
}

export const socialPages: FastifyPluginAsync = async (app) => {
  registerPageAsset('invitacion.js', 'text/javascript; charset=utf-8', INVITE_JS);

  app.get<{ Params: { code: string } }>('/i/:code', async (request, reply) => {
    const code = normalizeInviteCode(request.params.code);
    reply.type('text/html; charset=utf-8');
    if (!code) return reply.status(404).send(invalidPage());
    return reply.send(invitePage(formatInviteCode(code)));
  });
};
