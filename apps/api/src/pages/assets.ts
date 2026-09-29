/**
 * Static assets of the account pages (owner: CORE), served at /cuenta/assets/:name:
 * - `tokens.css`: the shared design tokens (the only source of colors), read from
 *   @centrate/shared at startup;
 * - `pages.css`: the layout every page (account, panel, invite) shares;
 * - `cuenta.js`: sign in (Google, email code), sign out, the email-link page.
 * No inline scripts or styles anywhere (CSP in app.ts).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { registerPageAsset } from './layout';

/** Reads tokens.css from @centrate/shared (null when the file cannot be found). */
export function readTokensCss(): string | null {
  try {
    const resolveFromHere = createRequire(import.meta.url);
    return readFileSync(resolveFromHere.resolve('@centrate/shared/design/tokens.css'), 'utf8');
  } catch {
    return null;
  }
}

export const PAGES_CSS = `*,
*::before,
*::after {
  box-sizing: border-box;
}
html {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--font-size-15);
  line-height: var(--line-height-15);
}
body {
  margin: 0;
  min-height: 100vh;
}
[hidden] {
  display: none !important;
}
.page {
  max-width: var(--layout-detail-width);
  margin: 0 auto;
  padding: calc(var(--space-4) * 2) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.card {
  background: var(--tile);
  border: var(--size-border) solid var(--border);
  border-radius: var(--radius-lg);
  padding: calc(var(--space-4) * 1.5);
}
.brand {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--font-size-13);
  font-weight: var(--font-weight-semibold);
}
h1 {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-28);
  line-height: var(--line-height-28);
  font-weight: var(--font-weight-semibold);
}
h2 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--font-size-20);
  line-height: var(--line-height-20);
  font-weight: var(--font-weight-semibold);
}
p {
  margin: 0 0 var(--space-3);
}
a {
  color: var(--blue);
}
.muted {
  color: var(--fg-muted);
}
.fine {
  color: var(--fg-muted);
  font-size: var(--font-size-13);
  line-height: var(--line-height-13);
}
.stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-4) 0;
}
.or {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
  color: var(--fg-muted);
  font-size: var(--font-size-13);
}
.or::before,
.or::after {
  content: '';
  flex: 1;
  border-top: var(--size-border) solid var(--border);
}
label {
  font-size: var(--font-size-13);
  font-weight: var(--font-weight-semibold);
}
.field {
  height: var(--size-field);
  padding: 0 var(--space-3);
  border: var(--size-border) solid var(--control);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
}
.field-code {
  font-size: var(--font-size-20);
  letter-spacing: 0.3em;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--size-field);
  padding: 0 var(--space-4);
  border: var(--size-border) solid var(--control);
  border-radius: var(--radius-md);
  background: var(--tile);
  color: var(--fg);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  cursor: pointer;
  transition: background var(--duration-hover);
}
.button:hover {
  background: var(--tile-hover);
}
.button:active {
  background: var(--tile-active);
}
.button-primary,
.button-primary:hover,
.button-primary:active {
  border-color: var(--blue);
  background: var(--blue);
  color: var(--on-accent);
}
.button-danger {
  border-color: var(--red);
  color: var(--red-text);
}
.button:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.link-button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--blue);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.notice {
  margin: 0 0 var(--space-4);
  padding: var(--space-3);
  border: var(--size-border) solid var(--border);
  border-radius: var(--radius-md);
  background: var(--tile-2);
}
.notice-error {
  border-color: var(--red);
}
.status {
  min-height: var(--line-height-15);
  margin: var(--space-2) 0 0;
  color: var(--fg-muted);
}
.status[data-tone='error'] {
  color: var(--red-text);
}
code {
  font-family: ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace;
}
.invite-code-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.invite-code {
  font-size: var(--font-size-32);
  line-height: var(--line-height-32);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.08em;
}
.steps,
.sessions {
  margin: 0 0 var(--space-3);
  padding-left: 1.4em;
}
.steps li,
.sessions li {
  margin-bottom: var(--space-1);
}
`;

/** Shared by /cuenta, /cuenta/codigo and /cuenta/conectar. Plain ES2017, no modules. */
export const ACCOUNT_JS = `'use strict';
(function () {
  var OFFLINE = 'No hay conexión con el servidor. Inténtalo de nuevo en un momento.';
  var VOLVER_KEY = 'centrate.volver';
  var statusEl = document.getElementById('status');

  function say(text, tone) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }
  function busy(el, on) {
    if (!el) return;
    el.disabled = on;
    el.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return null; })
        .then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    });
  }
  // Only relative /cuenta paths, never another site.
  function safeVolver(value) {
    if (typeof value !== 'string' || !/^\\/cuenta(?:[/?#]|$)/.test(value)) return '/cuenta';
    if (value.indexOf('//') !== -1 || value.indexOf('\\\\') !== -1) return '/cuenta';
    return value;
  }
  var root = document.querySelector('[data-volver]');
  var volver = safeVolver(root ? root.getAttribute('data-volver') : null);
  function remember() {
    try { localStorage.setItem(VOLVER_KEY, volver); } catch (e) { /* private mode */ }
  }
  function recall() {
    try {
      var value = localStorage.getItem(VOLVER_KEY);
      localStorage.removeItem(VOLVER_KEY);
      return safeVolver(value);
    } catch (e) {
      return '/cuenta';
    }
  }
  function signIn(email, otp, button, target) {
    if (!email || !/^[0-9]{6}$/.test(otp)) {
      say('Escribe el código de 6 cifras que te hemos enviado.', 'error');
      return;
    }
    busy(button, true);
    say('Entrando…');
    post('/api/auth/sign-in/email-otp', { email: email, otp: otp }).then(
      function (r) {
        if (r.ok) {
          location.assign(target);
          return;
        }
        busy(button, false);
        say(
          r.status === 429
            ? 'Demasiados intentos. Espera unos minutos.'
            : 'El código no es correcto o ha caducado. Pide uno nuevo si hace falta.',
          'error'
        );
      },
      function () { busy(button, false); say(OFFLINE, 'error'); }
    );
  }

  var google = document.getElementById('google');
  if (google) {
    google.addEventListener('click', function () {
      busy(google, true);
      say('Abriendo Google…');
      post('/api/auth/sign-in/social', {
        provider: 'google',
        callbackURL: volver,
        errorCallbackURL: '/cuenta?error=google',
      }).then(
        function (r) {
          if (r.ok && r.data && typeof r.data.url === 'string' && /^https:\\/\\//.test(r.data.url)) {
            location.assign(r.data.url);
            return;
          }
          busy(google, false);
          say('No se ha podido abrir Google. Inténtalo de nuevo.', 'error');
        },
        function () { busy(google, false); say(OFFLINE, 'error'); }
      );
    });
  }

  var emailForm = document.getElementById('email-form');
  var codeForm = document.getElementById('code-form');
  var currentEmail = '';
  if (emailForm && codeForm) {
    emailForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var email = (emailForm.elements.namedItem('email').value || '').trim();
      if (!email) return;
      var button = emailForm.querySelector('button[type=submit]');
      busy(button, true);
      say('Enviando el código…');
      post('/api/auth/email-otp/send-verification-otp', { email: email, type: 'sign-in' }).then(
        function (r) {
          busy(button, false);
          if (r.ok) {
            currentEmail = email;
            remember();
            document.getElementById('code-email').textContent = email;
            emailForm.hidden = true;
            codeForm.hidden = false;
            codeForm.elements.namedItem('otp').focus();
            say('');
          } else if (r.status === 429) {
            say('Has pedido demasiados códigos. Espera unos minutos y vuelve a intentarlo.', 'error');
          } else if (r.status === 503 && r.data && r.data.error && r.data.error.code === 'feature_disabled') {
            say('Hoy ya no podemos enviar más códigos por email. Vuelve a intentarlo mañana.', 'error');
          } else if (r.status >= 500) {
            say(OFFLINE, 'error');
          } else {
            say('Revisa la dirección de email y vuelve a intentarlo.', 'error');
          }
        },
        function () { busy(button, false); say(OFFLINE, 'error'); }
      );
    });
    codeForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var otp = String(codeForm.elements.namedItem('otp').value || '').replace(/\\D/g, '');
      signIn(currentEmail, otp, codeForm.querySelector('button[type=submit]'), volver);
    });
    var back = document.getElementById('code-back');
    if (back) {
      back.addEventListener('click', function () {
        codeForm.hidden = true;
        emailForm.hidden = false;
        say('');
      });
    }
  }

  // /cuenta/codigo: the email and the code arrive in the URL fragment, which never reaches
  // the server. Nothing happens until «Entrar» is pressed (link scanners cannot use the code).
  var linkForm = document.getElementById('link-form');
  if (linkForm) {
    var params = new URLSearchParams(location.hash.replace(/^#/, ''));
    var emailInput = linkForm.elements.namedItem('email');
    var otpInput = linkForm.elements.namedItem('otp');
    if (params.get('email')) emailInput.value = params.get('email');
    if (params.get('otp')) otpInput.value = params.get('otp').replace(/\\D/g, '').slice(0, 6);
    if (location.hash) history.replaceState(null, '', location.pathname);
    linkForm.addEventListener('submit', function (event) {
      event.preventDefault();
      signIn(
        String(emailInput.value || '').trim(),
        String(otpInput.value || '').replace(/\\D/g, ''),
        linkForm.querySelector('button[type=submit]'),
        recall()
      );
    });
  }

  // /cuenta: end every other browser session (this one stays), then show the new list.
  var revokeOthers = document.getElementById('revoke-others');
  if (revokeOthers) {
    revokeOthers.addEventListener('click', function () {
      busy(revokeOthers, true);
      say('Cerrando las demás sesiones…');
      post('/v1/sessions/revoke-others', {}).then(
        function (r) {
          if (r.ok) {
            location.reload();
            return;
          }
          busy(revokeOthers, false);
          say(
            r.status === 401
              ? 'Tu sesión ha caducado. Recarga la página y vuelve a entrar.'
              : r.status === 429
                ? 'Demasiados intentos. Espera unos minutos.'
                : 'No se han podido cerrar las demás sesiones. Inténtalo de nuevo.',
            'error'
          );
        },
        function () { busy(revokeOthers, false); say(OFFLINE, 'error'); }
      );
    });
  }

  // /cuenta/conectar after an old sign-in: sign out, sign in again and come back (volver).
  var reauth = document.getElementById('reauth');
  if (reauth) {
    reauth.addEventListener('click', function () {
      busy(reauth, true);
      post('/api/auth/sign-out', {}).then(
        function () { location.assign('/cuenta?volver=' + encodeURIComponent(volver)); },
        function () { busy(reauth, false); say(OFFLINE, 'error'); }
      );
    });
  }

  var signOut = document.getElementById('sign-out');
  if (signOut) {
    signOut.addEventListener('click', function () {
      busy(signOut, true);
      post('/api/auth/sign-out', {}).then(
        function () { location.assign('/cuenta'); },
        function () { busy(signOut, false); say(OFFLINE, 'error'); }
      );
    });
  }
})();
`;

/** Registers tokens.css, pages.css and cuenta.js (idempotent). */
export function registerAccountAssets(): void {
  registerPageAsset('tokens.css', 'text/css; charset=utf-8', readTokensCss() ?? '');
  registerPageAsset('pages.css', 'text/css; charset=utf-8', PAGES_CSS);
  registerPageAsset('cuenta.js', 'text/javascript; charset=utf-8', ACCOUNT_JS);
}
