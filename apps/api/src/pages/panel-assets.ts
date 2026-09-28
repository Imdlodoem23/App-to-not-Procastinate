/**
 * Static assets of the dashboard and the partner inbox (owner: CLIENT), served from
 * /cuenta/assets/ like every page asset (layout.ts registry, CORE's route):
 * - `panel.css`: charts, figures, lists and tables. Colors only from the design tokens.
 * - `panel.js`: «Quitar» a device, delete the uploaded stats, «Descargar mis datos», «Borrar
 *   mi cuenta» (typed confirmation; sign in again when the session is not fresh).
 * - `avisos.js`: «Aprobar» / «Rechazar» a pending emergency request.
 * Plain ES2017 without modules, no inline code (CSP in app.ts). User-visible text only through
 * `textContent`; the scripts never build HTML from strings.
 */
import { registerPageAsset } from './layout';

export const PANEL_CSS = `.card > h2:first-child {
  margin-top: 0;
}
h3 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--font-size-15);
  line-height: var(--line-height-15);
  font-weight: var(--font-weight-semibold);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: var(--space-2);
  margin: 0;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--tile-2);
}
.kpi dt {
  color: var(--fg-muted);
  font-size: var(--font-size-12);
  line-height: var(--line-height-12);
}
.kpi dd {
  margin: 0;
  font-size: var(--font-size-20);
  line-height: var(--line-height-20);
  font-weight: var(--font-weight-semibold);
}
.kpi .kpi-sub {
  color: var(--fg-muted);
  font-size: var(--font-size-12);
  line-height: var(--line-height-12);
  font-weight: var(--font-weight-normal);
}
.chart {
  margin: var(--space-4) 0 0;
}
.chart figcaption {
  margin: 0 0 var(--space-2);
}
.chart figcaption strong {
  font-weight: var(--font-weight-semibold);
}
.chart-svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
  font-family: var(--font-sans);
}
.chart-narrow {
  display: none;
}
@media (max-width: 480px) {
  .chart-wide {
    display: none;
  }
  .chart-narrow {
    display: block;
  }
}
.chart-narrow .chart-tick {
  font-size: 12.5px;
}
.chart-narrow .chart-value {
  font-size: 13px;
}
.chart-tick {
  fill: var(--fg-muted);
  font-size: var(--font-size-11);
  font-variant-numeric: tabular-nums;
}
.chart-value {
  fill: var(--fg);
  font-size: var(--font-size-12);
  font-weight: var(--font-weight-semibold);
}
.chart-baseline {
  stroke: var(--control);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.slot-hit {
  fill: transparent;
}
.slot:hover .slot-hit {
  fill: var(--tile-2);
}
.bar-green {
  fill: var(--green);
}
.bar-red {
  fill: var(--red);
}
.chart-summary {
  margin: var(--space-2) 0 0;
  color: var(--fg-muted);
  font-size: var(--font-size-13);
  line-height: var(--line-height-13);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0 0 var(--space-2);
  padding: 0;
  list-style: none;
  color: var(--fg-muted);
  font-size: var(--font-size-13);
  line-height: var(--line-height-13);
}
.swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: var(--space-2);
  border-radius: 2px;
}
.swatch-green {
  background: var(--green);
}
.swatch-red {
  background: var(--red);
}
details.data {
  margin: var(--space-4) 0 0;
}
details.data summary {
  color: var(--blue);
  cursor: pointer;
}
.table-scroll {
  overflow-x: auto;
  margin-top: var(--space-2);
}
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-13);
  line-height: var(--line-height-13);
  font-variant-numeric: tabular-nums;
}
.data-table th,
.data-table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: var(--size-border) solid var(--border);
  text-align: right;
  white-space: nowrap;
}
.data-table th:first-child,
.data-table td:first-child {
  text-align: left;
}
.data-table th {
  color: var(--fg-muted);
  font-weight: var(--font-weight-semibold);
}
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.list > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) 0;
  border-top: var(--size-border) solid var(--border);
}
.list > li:first-child {
  border-top: 0;
  padding-top: 0;
}
.item-text {
  display: flex;
  flex: 1 1 240px;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.item-text p {
  margin: 0;
}
.item-meta {
  color: var(--fg-muted);
  font-size: var(--font-size-13);
  line-height: var(--line-height-13);
}
.decision {
  display: flex;
  flex: 1 1 100%;
  flex-direction: column;
  gap: var(--space-2);
}
.decision .actions {
  margin: 0;
}
.button[data-armed='true'] {
  border-color: var(--red);
  color: var(--red-text);
}
.danger-zone {
  margin-top: var(--space-4);
  padding-top: var(--space-2);
  border-top: var(--size-border) solid var(--border);
}
`;

/** Shared helpers of both scripts: JSON calls with the cookie session, status messages. */
const COMMON_JS = `  var OFFLINE = 'No hay conexión con el servidor. Inténtalo de nuevo en un momento.';
  function say(el, text, tone) {
    if (!el) return;
    el.textContent = text;
    if (tone) el.setAttribute('data-tone', tone);
    else el.removeAttribute('data-tone');
  }
  function busy(el, on) {
    if (!el) return;
    el.disabled = on;
    el.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  function api(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        var code = data && data.error && typeof data.error.code === 'string' ? data.error.code : null;
        return { ok: res.ok, status: res.status, code: code, data: data };
      });
    });
  }
  function failure(r) {
    if (r.status === 401) return 'Tu sesión ha caducado. Recarga la página y vuelve a iniciar sesión.';
    if (r.status === 429) return 'Demasiados intentos seguidos. Espera un poco y vuelve a intentarlo.';
    if (r.status >= 500) return 'El servidor no ha podido hacerlo ahora. Inténtalo de nuevo en un momento.';
    return 'No se ha podido hacer. Recarga la página y vuelve a intentarlo.';
  }
  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }
`;

export const PANEL_JS = `'use strict';
(function () {
${COMMON_JS}
  var statusEl = document.getElementById('status');

  // «¿Seguro?»: the first click arms the button, a second one within 4 s confirms.
  function confirmClick(button, armedLabel, action) {
    var label = button.textContent;
    var timer = null;
    function disarm() {
      clearTimeout(timer);
      button.removeAttribute('data-armed');
      button.textContent = label;
    }
    button.addEventListener('click', function () {
      if (button.getAttribute('data-armed') !== 'true') {
        button.setAttribute('data-armed', 'true');
        button.textContent = armedLabel;
        timer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      action();
    });
  }

  each('[data-remove-device]', function (button) {
    confirmClick(button, '¿Seguro? Quitar', function () {
      busy(button, true);
      say(statusEl, 'Quitando el ordenador…');
      var id = button.getAttribute('data-remove-device') || '';
      api('DELETE', '/v1/devices/' + encodeURIComponent(id)).then(
        function (r) {
          if (r.ok || r.status === 404) {
            var row = button.closest('li');
            if (row && row.parentNode) row.parentNode.removeChild(row);
            say(statusEl, 'Ordenador quitado. Sus estadísticas se han borrado de la nube.');
            return;
          }
          busy(button, false);
          say(statusEl, failure(r), 'error');
        },
        function () { busy(button, false); say(statusEl, OFFLINE, 'error'); }
      );
    });
  });

  var deleteStats = document.getElementById('delete-stats');
  if (deleteStats) {
    confirmClick(deleteStats, '¿Seguro? Borrar las estadísticas', function () {
      busy(deleteStats, true);
      say(statusEl, 'Borrando las estadísticas de la nube…');
      api('DELETE', '/v1/sync/days').then(
        function (r) {
          if (r.ok) { location.reload(); return; }
          busy(deleteStats, false);
          say(statusEl, failure(r), 'error');
        },
        function () { busy(deleteStats, false); say(statusEl, OFFLINE, 'error'); }
      );
    });
  }

  var exportLink = document.getElementById('export');
  if (exportLink && window.URL && typeof URL.createObjectURL === 'function') {
    exportLink.addEventListener('click', function (event) {
      event.preventDefault();
      say(statusEl, 'Preparando tus datos…');
      fetch('/v1/me/export', { credentials: 'same-origin' }).then(
        function (res) {
          if (!res.ok) {
            say(
              statusEl,
              res.status === 429
                ? 'Solo puedes descargar tus datos 3 veces por hora. Espera un poco.'
                : failure({ status: res.status }),
              'error'
            );
            return;
          }
          return res.blob().then(function (blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'centrate-datos.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
            say(statusEl, 'Listo: se ha descargado centrate-datos.json.');
          });
        },
        function () { say(statusEl, OFFLINE, 'error'); }
      );
    });
  }

  function showDeleted() {
    var main = document.querySelector('main');
    if (!main) { location.assign('/cuenta'); return; }
    while (main.firstChild) main.removeChild(main.firstChild);
    var card = document.createElement('section');
    card.className = 'card';
    var title = document.createElement('h1');
    title.textContent = 'Cuenta borrada';
    var text = document.createElement('p');
    text.textContent =
      'Hemos borrado tu cuenta y todos sus datos de la nube. Céntrate sigue funcionando en tus ordenadores sin cuenta, con todo lo que tenías guardado en ellos.';
    card.appendChild(title);
    card.appendChild(text);
    main.appendChild(card);
    title.setAttribute('tabindex', '-1');
    title.focus();
  }

  var form = document.getElementById('delete-account');
  var reauth = document.getElementById('reauth');
  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var input = form.elements.namedItem('confirm');
      if (String((input && input.value) || '').trim() !== 'BORRAR') {
        say(statusEl, 'Escribe BORRAR, en mayúsculas, para confirmar.', 'error');
        if (input) input.focus();
        return;
      }
      var button = form.querySelector('button[type=submit]');
      busy(button, true);
      say(statusEl, 'Borrando tu cuenta…');
      api('DELETE', '/v1/me', { confirm: 'BORRAR' }).then(
        function (r) {
          if (r.ok) { showDeleted(); return; }
          busy(button, false);
          if (r.code === 'reauth_required') {
            say(statusEl, 'Por seguridad, vuelve a iniciar sesión y repite el borrado.', 'error');
            if (reauth) reauth.hidden = false;
            return;
          }
          say(statusEl, failure(r), 'error');
        },
        function () { busy(button, false); say(statusEl, OFFLINE, 'error'); }
      );
    });
  }
  if (reauth) {
    reauth.addEventListener('click', function () {
      busy(reauth, true);
      var back = function () {
        location.assign('/cuenta?volver=' + encodeURIComponent('/cuenta/panel#datos'));
      };
      api('POST', '/api/auth/sign-out', {}).then(back, back);
    });
  }
})();
`;

export const AVISOS_JS = `'use strict';
(function () {
${COMMON_JS}
  var CONFLICT = {
    deadline_passed: 'Ya ha pasado la hora límite, así que se ha aprobado solo.',
    already_decided: 'Otro compañero ya ha respondido.',
    not_found: 'Este aviso ya no está disponible.'
  };

  each('form[data-event]', function (form) {
    var id = form.getAttribute('data-event') || '';
    var statusEl = form.querySelector('.status');
    var buttons = form.querySelectorAll('button[data-decision]');
    form.addEventListener('submit', function (event) { event.preventDefault(); });
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        var decision = button.getAttribute('data-decision');
        var noteInput = form.elements.namedItem('note');
        var note = String((noteInput && noteInput.value) || '').trim().slice(0, 140);
        Array.prototype.forEach.call(buttons, function (b) { busy(b, true); });
        say(statusEl, decision === 'approve' ? 'Aprobando…' : 'Rechazando…');
        api('POST', '/v1/accountability/events/' + encodeURIComponent(id) + '/decision', {
          decision: decision,
          note: note || null
        }).then(
          function (r) {
            if (r.ok) { location.reload(); return; }
            if (r.code && CONFLICT[r.code]) {
              say(statusEl, CONFLICT[r.code], 'error');
              setTimeout(function () { location.reload(); }, 3000);
              return;
            }
            Array.prototype.forEach.call(buttons, function (b) { busy(b, false); });
            say(statusEl, failure(r), 'error');
          },
          function () {
            Array.prototype.forEach.call(buttons, function (b) { busy(b, false); });
            say(statusEl, OFFLINE, 'error');
          }
        );
      });
    });
  });
})();
`;

/** Registers panel.css, panel.js and avisos.js (idempotent). */
export function registerPanelAssets(): void {
  registerPageAsset('panel.css', 'text/css; charset=utf-8', PANEL_CSS);
  registerPageAsset('panel.js', 'text/javascript; charset=utf-8', PANEL_JS);
  registerPageAsset('avisos.js', 'text/javascript; charset=utf-8', AVISOS_JS);
}
