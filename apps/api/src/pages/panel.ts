/**
 * Owner: CLIENT. docs/API.md §11.
 * - /cuenta/panel: the web dashboard. Charts of the last 12 ISO weeks (focus and study time,
 *   points won and lost, days that met the goal) with a text summary and a table each, the
 *   connected computers with «Quitar», «Descargar mis datos» and «Borrar mi cuenta».
 * - /cuenta/avisos: a partner's inbox on the web, to approve or deny an emergency request
 *   from the phone when the email arrives.
 *
 * The pages are rendered on the server from what the JSON API answers to the same session
 * (`GET /v1/me`, `/v1/stats`, `/v1/accountability/inbox` through `app.inject`): the same
 * checks, the same numbers, no second copy of the queries. Charts are SVG built from numbers
 * (panel-charts.ts). Actions go through registered scripts (panel-assets.ts) that call the
 * JSON API with the browser's cookie session (same origin, CSRF rule of auth/csrf.ts).
 * Without a session both pages send the browser to /cuenta and back.
 */
import type {
  CloudDevice,
  CloudErrorBody,
  InboxItem,
  InboxResponse,
  MeResponse,
  StatsResponse,
} from '@centrate/shared/cloud-api';
import { addDays, localDayIn } from '@centrate/shared/cloud-api';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { deriveCapabilities } from '../config';
import { registerPanelAssets } from './panel-assets';
import {
  PANEL_WEEKS,
  responsiveChart,
  formatInt,
  formatMinutes,
  formatSignedPoints,
  longDay,
  minuteTicks,
  panelMondays,
  pointTicks,
  shortDay,
  weekAxisLabels,
  weeklyTotals,
} from './panel-charts';
import type { WeekTotals } from './panel-charts';
import { ASSET_PREFIX, PRIVACY_URL, html, page } from './layout';
import type { SafeHtml } from './layout';

// ---------------------------------------------------------------------------------------
// Reading the JSON API as the caller
// ---------------------------------------------------------------------------------------

type ApiRead<T> =
  { ok: true; data: T } | { ok: false; status: number; error: CloudErrorBody['error'] | null };

/** GET `url` on this app with the caller's credentials (cookie or bearer), in process. */
async function readApi<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  url: string,
): Promise<ApiRead<T>> {
  const headers: Record<string, string> = {};
  const { cookie, authorization } = request.headers;
  if (typeof cookie === 'string') headers.cookie = cookie;
  if (typeof authorization === 'string') headers.authorization = authorization;
  const res = await app.inject({ method: 'GET', url, headers });
  let body: unknown;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  if (res.statusCode >= 200 && res.statusCode < 300 && body !== null) {
    return { ok: true, data: body as T };
  }
  const error = (body as Partial<CloudErrorBody> | null)?.error ?? null;
  return { ok: false, status: res.statusCode, error };
}

// ---------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------

const STATUS = html`<p class="status" id="status" role="status" aria-live="polite"></p>`;

function send(
  reply: FastifyReply,
  status: number,
  title: string,
  body: SafeHtml,
  scripts: string[] = [],
) {
  return reply.status(status).type('text/html; charset=utf-8').send(page({ title, body, scripts }));
}

/** The panel's own styles (a body-level stylesheet: layout.ts links only the shared ones). */
const PANEL_STYLES = html`<link rel="stylesheet" href="${ASSET_PREFIX}panel.css" />`;

const unavailableBody = html`<section class="card">
  <h1>Cuentas no disponibles</h1>
  <p>
    Este servidor no tiene las cuentas activadas ahora mismo. Céntrate funciona igual sin cuenta:
    tus bloqueos, estadísticas y puntos siguen en tu ordenador.
  </p>
</section>`;

const loadFailedBody = html`<section class="card">
  <h1>No se ha podido cargar</h1>
  <p>
    El servidor no ha respondido bien. Recarga la página en un momento. Si acaba de despertarse,
    puede tardar hasta un minuto.
  </p>
  <div class="actions"><a class="button" href="/cuenta">Tu cuenta</a></div>
</section>`;

function signInRedirect(reply: FastifyReply, path: string) {
  return reply.redirect(`/cuenta?${new URLSearchParams({ volver: path }).toString()}`, 303);
}

const PLATFORMS: Record<CloudDevice['platform'], string> = {
  win: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
};

function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/** «hoy a las 18:40», «ayer a las 9:05», «27 sept a las 18:40», in the viewer's zone. */
export function whenText(iso: string, timeZone: string, now: Date): string {
  const at = new Date(iso);
  const day = localDayIn(timeZone, at);
  const today = localDayIn(timeZone, now);
  const time = clock(at, timeZone);
  if (day === today) return `hoy a las ${time}`;
  if (day === addDays(today, -1)) return `ayer a las ${time}`;
  return `${shortDay(day)} a las ${time}`;
}

// ---------------------------------------------------------------------------------------
// /cuenta/panel
// ---------------------------------------------------------------------------------------

interface PanelInput {
  me: MeResponse;
  stats: StatsResponse;
  today: string;
  now: Date;
  /** Sync is configured on this server (the capability), independent of the user's switch. */
  syncAvailable: boolean;
}

function sum(weeks: readonly WeekTotals[], key: 'focusMinutes' | 'studyMinutes'): number {
  return weeks.reduce((total, w) => total + w[key], 0);
}

function bestWeek(weeks: readonly WeekTotals[], key: 'focusMinutes' | 'studyMinutes') {
  let best = -1;
  weeks.forEach((w, i) => {
    if (w[key] > 0 && (best < 0 || w[key] > (weeks[best]?.[key] ?? 0))) best = i;
  });
  return best;
}

function minutesFigure(
  weeks: readonly WeekTotals[],
  mondays: readonly string[],
  key: 'focusMinutes' | 'studyMinutes',
  caption: string,
  noun: string,
  maxMinutes: number,
): SafeHtml {
  const total = sum(weeks, key);
  const best = bestWeek(weeks, key);
  const labels = weekAxisLabels(mondays);
  const summary =
    total === 0
      ? `Sin ${noun} en estas ${PANEL_WEEKS} semanas.`
      : `En ${PANEL_WEEKS} semanas: ${formatMinutes(total)}. ` +
        `Media: ${formatMinutes(total / PANEL_WEEKS)} por semana. ` +
        `Mejor semana: la del ${longDay(weeks[best]?.from ?? mondays[0] ?? '')}, ` +
        `con ${formatMinutes(weeks[best]?.[key] ?? 0)}.`;
  const chart = responsiveChart({
    ariaLabel: `${caption}. ${summary}`,
    ticks: minuteTicks(maxMinutes),
    slots: weeks.map((w, i) => ({
      label: labels[i] ?? null,
      title: `Semana del ${longDay(w.from)}: ${formatMinutes(w[key])}`,
      bars: [{ value: w[key], tone: 'green' as const }],
    })),
    labelSlot: best >= 0 ? { index: best, text: formatMinutes(weeks[best]?.[key] ?? 0) } : null,
  });
  return html`<figure class="chart">
    <figcaption><strong>${caption}</strong> · horas por semana</figcaption>
    ${chart}
    <p class="chart-summary">${summary}</p>
  </figure>`;
}

function pointsFigure(weeks: readonly WeekTotals[], mondays: readonly string[]): SafeHtml {
  const earned = weeks.reduce((t, w) => t + w.pointsEarned, 0);
  const lost = weeks.reduce((t, w) => t + w.pointsLost, 0);
  const labels = weekAxisLabels(mondays);
  const summary =
    earned === 0 && lost === 0
      ? `Sin puntos ganados ni perdidos en estas ${PANEL_WEEKS} semanas.`
      : `Ganados: ${formatSignedPoints(earned)}. Perdidos: ${formatSignedPoints(-lost)}. ` +
        `Balance: ${formatSignedPoints(earned - lost)}.`;
  const chart = responsiveChart({
    ariaLabel: `Puntos. ${summary}`,
    ticks: pointTicks(
      Math.max(0, ...weeks.map((w) => w.pointsEarned)),
      Math.max(0, ...weeks.map((w) => w.pointsLost)),
    ),
    slots: weeks.map((w, i) => ({
      label: labels[i] ?? null,
      title:
        `Semana del ${longDay(w.from)}: ${formatSignedPoints(w.pointsEarned)} ganados, ` +
        `${formatSignedPoints(-w.pointsLost)} perdidos`,
      bars: [
        { value: w.pointsEarned, tone: 'green' as const },
        { value: -w.pointsLost, tone: 'red' as const },
      ],
    })),
  });
  return html`<figure class="chart">
    <figcaption><strong>Puntos</strong> · por semana</figcaption>
    <ul class="legend">
      <li><span class="swatch swatch-green"></span>Ganados (hacia arriba)</li>
      <li><span class="swatch swatch-red"></span>Perdidos (hacia abajo)</li>
    </ul>
    ${chart}
    <p class="chart-summary">${summary}</p>
  </figure>`;
}

function goalFigure(
  weeks: readonly WeekTotals[],
  mondays: readonly string[],
  goal: number | null,
): SafeHtml {
  if (goal === null) {
    return html`<figure class="chart">
      <figcaption><strong>Objetivo diario</strong></figcaption>
      <p class="chart-summary">
        Pon un objetivo diario en la app (Ajustes → General) para ver aquí cuántos días lo cumples.
      </p>
    </figure>`;
  }
  const met = weeks.reduce((t, w) => t + (w.goalDays ?? 0), 0);
  const lived = weeks.reduce((t, w) => t + w.daysElapsed, 0);
  const labels = weekAxisLabels(mondays);
  const summary = `Objetivo: ${formatMinutes(goal)} al día. Lo cumpliste ${formatInt(met)} de ${formatInt(lived)} días.`;
  const chart = responsiveChart({
    ariaLabel: `Días con el objetivo cumplido. ${summary}`,
    ticks: [
      { value: 0, label: '0' },
      { value: 7, label: '7' },
    ],
    slots: weeks.map((w, i) => ({
      label: labels[i] ?? null,
      title: `Semana del ${longDay(w.from)}: ${w.goalDays ?? 0} de ${w.daysElapsed} días`,
      bars: [{ value: w.goalDays ?? 0, tone: 'green' as const }],
    })),
  });
  return html`<figure class="chart">
    <figcaption><strong>Días con el objetivo cumplido</strong> · de 7 por semana</figcaption>
    ${chart}
    <p class="chart-summary">${summary}</p>
  </figure>`;
}

function dataTable(weeks: readonly WeekTotals[], hasGoal: boolean): SafeHtml {
  return html`<details class="data">
    <summary>Ver los datos en una tabla</summary>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col">Semana</th>
            <th scope="col">Concentrado</th>
            <th scope="col">Estudio</th>
            <th scope="col">Ganados</th>
            <th scope="col">Perdidos</th>
            ${hasGoal && html`<th scope="col">Objetivo</th>`}
          </tr>
        </thead>
        <tbody>
          ${[...weeks].reverse().map(
            (w) =>
              html`<tr>
                <th scope="row">${shortDay(w.from)}</th>
                <td>${formatMinutes(w.focusMinutes)}</td>
                <td>${formatMinutes(w.studyMinutes)}</td>
                <td>${formatSignedPoints(w.pointsEarned)}</td>
                <td>${formatSignedPoints(-w.pointsLost)}</td>
                ${hasGoal && html`<td>${w.goalDays ?? 0} de ${w.daysElapsed}</td>`}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </details>`;
}

function thisWeekCard(week: WeekTotals, hasGoal: boolean): SafeHtml {
  const net = week.pointsEarned - week.pointsLost;
  return html`<section class="card">
    <h2>Esta semana</h2>
    <dl class="kpis">
      <div class="kpi">
        <dt>Tiempo concentrado</dt>
        <dd>${formatMinutes(week.focusMinutes)}</dd>
      </div>
      <div class="kpi">
        <dt>Estudio</dt>
        <dd>${formatMinutes(week.studyMinutes)}</dd>
      </div>
      <div class="kpi">
        <dt>Puntos</dt>
        <dd>
          ${formatSignedPoints(net)}
          ${
            week.pointsLost > 0 &&
            week.pointsEarned > 0 &&
            html`<span class="kpi-sub"
              >${formatSignedPoints(week.pointsEarned)} ·
              ${formatSignedPoints(-week.pointsLost)}</span
            >`
          }
        </dd>
      </div>
      ${
        hasGoal &&
        html`<div class="kpi">
          <dt>Objetivo cumplido</dt>
          <dd>${week.goalDays ?? 0} de ${week.daysElapsed} días</dd>
        </div>`
      }
    </dl>
  </section>`;
}

function devicesCard(devices: readonly CloudDevice[], timeZone: string, now: Date): SafeHtml {
  return html`<section class="card">
    <h2>Ordenadores conectados</h2>
    ${
      devices.length === 0
        ? html`<p class="muted">
            Ningún ordenador está conectado. Para conectar uno, inicia sesión desde la app de
            Céntrate en ese ordenador.
          </p>`
        : html`<ul class="list">
            ${devices.map(
              (d) =>
                html`<li>
                  <div class="item-text">
                    <p><strong>${d.name}</strong></p>
                    <p class="item-meta">
                      ${PLATFORMS[d.platform] ?? d.platform} · Céntrate ${d.appVersion} ·
                      ${
                        d.lastSyncAt
                          ? `última sincronización ${whenText(d.lastSyncAt, timeZone, now)}`
                          : 'aún no ha subido estadísticas'
                      }
                    </p>
                  </div>
                  <button type="button" class="button" data-remove-device="${d.id}">Quitar</button>
                </li>`,
            )}
          </ul>`
    }
    <p class="fine">
      Quitar un ordenador borra sus estadísticas de la nube y cierra su sesión. En ese ordenador,
      Céntrate sigue funcionando igual, sin cuenta.
    </p>
  </section>`;
}

const dataCard = html`<section class="card" id="datos">
  <h2>Tus datos</h2>
  <p>Descarga en un archivo JSON todo lo que la nube guarda sobre ti.</p>
  <div class="actions">
    <a class="button" id="export" href="/v1/me/export" download="centrate-datos.json"
      >Descargar mis datos</a
    >
  </div>
  <h3>Borrar las estadísticas subidas</h3>
  <p class="muted">
    Borra de la nube los totales diarios de todos tus ordenadores. En tus ordenadores no se borra
    nada. Si la sincronización sigue activada, se volverán a subir.
  </p>
  <div class="actions">
    <button type="button" class="button" id="delete-stats">Borrar las estadísticas</button>
  </div>
  <div class="danger-zone">
    <h3>Borrar mi cuenta</h3>
    <p class="muted">
      Se borran para siempre tu cuenta, tus estadísticas, tus amigos y tus compañeros de la nube. Lo
      que hay en tus ordenadores no se toca: Céntrate sigue funcionando sin cuenta.
    </p>
    <form id="delete-account" class="stack" novalidate>
      <label for="confirm">Escribe BORRAR para confirmar</label>
      <input
        class="field"
        id="confirm"
        name="confirm"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="20"
        required
      />
      <div class="actions">
        <button type="submit" class="button button-danger">Borrar mi cuenta</button>
        <button type="button" class="button" id="reauth" hidden>Iniciar sesión otra vez</button>
      </div>
    </form>
  </div>
  ${STATUS}
  <noscript><p class="notice">Para estas acciones hace falta JavaScript.</p></noscript>
</section>`;

export function panelBody(input: PanelInput): SafeHtml {
  const { me, stats, today, now } = input;
  const goal = stats.dailyGoalMinutes;
  const mondays = panelMondays(today);
  const weeks = weeklyTotals(stats.days, mondays, today, goal !== null);
  const hasData = stats.days.length > 0;
  const current = weeks[weeks.length - 1];
  const maxMinutes = Math.max(0, ...weeks.map((w) => w.focusMinutes));
  const zone = me.profile.timeZone;

  return html`${PANEL_STYLES}
    <section class="card">
      <p class="brand">Céntrate</p>
      <h1>Tu panel</h1>
      <p class="muted">
        Sesión iniciada como <strong>${me.user.email}</strong>. Aquí ves lo que tus ordenadores han
        subido a la nube: solo números, nunca qué bloqueas ni por qué.
      </p>
      <div class="actions">
        <a class="button" href="/cuenta">Tu cuenta</a>
        <a class="button" href="/cuenta/avisos">Avisos de tus compañeros</a>
      </div>
    </section>
    ${
      !input.syncAvailable &&
      html`<p class="notice">Este servidor no tiene la sincronización activada ahora mismo.</p>`
    }
    ${
      input.syncAvailable &&
      !me.sharing.syncStats &&
      html`<p class="notice">
        La sincronización de estadísticas está desactivada. Actívala en la app, en los ajustes de tu
        cuenta, para ver aquí tus
        gráficas.${hasData ? ' Lo que ya subiste sigue aquí hasta que lo borres.' : ''}
      </p>`
    }
    ${hasData && current && thisWeekCard(current, goal !== null)}
    <section class="card">
      <h2>Últimas ${PANEL_WEEKS} semanas</h2>
      <p class="muted">
        Del ${longDay(mondays[0] ?? today)} al ${longDay(today)}, de lunes a domingo en tu zona
        horaria (${zone}). Suma todos tus ordenadores.
      </p>
      ${
        hasData
          ? html`${minutesFigure(weeks, mondays, 'focusMinutes', 'Tiempo concentrado', 'tiempo concentrado', maxMinutes)}
            ${minutesFigure(weeks, mondays, 'studyMinutes', 'Estudio', 'tiempo de estudio', maxMinutes)}
            ${pointsFigure(weeks, mondays)} ${goalFigure(weeks, mondays, goal)}
            ${dataTable(weeks, goal !== null)}`
          : html`<p>Aún no hay estadísticas en la nube para estas semanas.</p>`
      }
    </section>
    ${devicesCard(stats.devices, zone, now)} ${dataCard}`;
}

// ---------------------------------------------------------------------------------------
// /cuenta/avisos
// ---------------------------------------------------------------------------------------

const HEADLINES: Record<InboxItem['kind'], string> = {
  emergency_requested: 'ha pedido el desbloqueo de emergencia',
  emergency_confirmed: 'ha usado el desbloqueo de emergencia',
  emergency_cancelled: 'ha cancelado su petición de desbloqueo de emergencia',
  study_abandoned: 'ha abandonado una sesión de estudio',
  punishment_started: 'ha recibido un castigo en Study Mode',
};

const nameOf = (item: InboxItem): string => item.owner.displayName.trim() || 'Tu amigo';

function outcome(item: InboxItem): string | null {
  const a = item.approval;
  if (!a) return null;
  switch (a.status) {
    case 'approved':
      return item.decidedByMe ? 'Lo aprobaste tú.' : 'Lo aprobó otro compañero.';
    case 'denied':
      return item.decidedByMe ? 'Lo rechazaste tú.' : 'Lo rechazó otro compañero.';
    case 'expired':
      return 'Nadie respondió a tiempo, así que se aprobó solo.';
    default:
      return null;
  }
}

function pendingItem(item: InboxItem, timeZone: string, now: Date): SafeHtml {
  const name = nameOf(item);
  const deadline = item.approval ? clock(new Date(item.approval.deadline), timeZone) : '';
  const noteId = `nota-${item.eventId}`;
  return html`<li>
    <div class="item-text">
      <p><strong>${name}</strong> ${HEADLINES[item.kind]}</p>
      <p class="item-meta">${whenText(item.occurredAt, timeZone, now)}</p>
      <p class="muted">
        Puedes responder hasta las ${deadline}. Si nadie responde, se aprueba solo. Aprobarlo no
        acorta su cuenta atrás; rechazarlo cancela esta petición y el bloqueo sigue.
      </p>
    </div>
    <form class="decision" data-event="${item.eventId}" novalidate>
      <label for="${noteId}">Nota para ${name} (opcional)</label>
      <input class="field" id="${noteId}" name="note" maxlength="140" autocomplete="off" />
      <div class="actions">
        <button type="button" class="button button-primary" data-decision="approve">Aprobar</button>
        <button type="button" class="button" data-decision="deny">Rechazar</button>
      </div>
      <p class="status" role="status" aria-live="polite"></p>
    </form>
  </li>`;
}

function pastItem(item: InboxItem, timeZone: string, now: Date): SafeHtml {
  const result = outcome(item);
  const note = item.decidedByMe ? item.approval?.note : null;
  return html`<li>
    <div class="item-text">
      <p><strong>${nameOf(item)}</strong> ${HEADLINES[item.kind]}</p>
      <p class="item-meta">
        ${whenText(item.occurredAt, timeZone, now)}${result ? ` · ${result}` : ''}
      </p>
      ${note && html`<p class="item-meta">Tu nota: «${note}»</p>`}
    </div>
  </li>`;
}

export function avisosBody(options: {
  me: MeResponse;
  inbox: InboxResponse | null;
  now: Date;
}): SafeHtml {
  const { me, inbox, now } = options;
  const zone = me.profile.timeZone;
  const items = inbox?.items ?? [];
  const pending = items.filter((i) => i.approval?.status === 'pending');
  const past = items.filter((i) => i.approval?.status !== 'pending');
  return html`${PANEL_STYLES}
    <section class="card">
      <p class="brand">Céntrate</p>
      <h1>Avisos de tus compañeros</h1>
      <p class="muted">
        Si alguien te ha elegido como compañero de responsabilidad, aquí ves cuándo pide el
        desbloqueo de emergencia o abandona una sesión de estudio (últimos 30 días). Nunca ves qué
        tenía bloqueado ni por qué.
      </p>
      <div class="actions">
        <a class="button" href="/cuenta/avisos">Actualizar</a>
        <a class="button" href="/cuenta/panel">Tu panel</a>
      </div>
    </section>
    ${
      inbox === null
        ? html`<p class="notice">
            Los compañeros de responsabilidad no están disponibles en este servidor ahora mismo.
          </p>`
        : html`${
              pending.length > 0 &&
              html`<section class="card">
                <h2>Esperan tu respuesta</h2>
                <ul class="list">
                  ${pending.map((i) => pendingItem(i, zone, now))}
                </ul>
                <noscript>
                  <p class="notice">
                    Para responder desde la web hace falta JavaScript. También puedes hacerlo desde
                    la app, en Amigos.
                  </p>
                </noscript>
              </section>`
            }
            <section class="card">
              <h2>Recientes</h2>
              ${
                past.length === 0
                  ? html`<p class="muted">No hay avisos en los últimos 30 días.</p>`
                  : html`<ul class="list">
                      ${past.map((i) => pastItem(i, zone, now))}
                    </ul>`
              }
            </section>`
    }
    <p class="fine"><a href="${PRIVACY_URL}">Cómo tratamos tus datos</a></p>`;
}

// ---------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------

export const panelPages: FastifyPluginAsync = async (app) => {
  const { ctx } = app;
  registerPanelAssets();
  const caps = deriveCapabilities(ctx.config);
  const accountsOn = Boolean(ctx.db) && caps.accounts.enabled;

  /** The caller's account, or the reply already sent (sign-in redirect or error page). */
  async function account(
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ): Promise<{ me: MeResponse } | { sent: FastifyReply }> {
    if (!accountsOn) return { sent: send(reply, 503, 'Cuenta', unavailableBody) };
    if (!request.user) return { sent: signInRedirect(reply, path) };
    const me = await readApi<MeResponse>(app, request, '/v1/me');
    if (me.ok) return { me: me.data };
    if (me.status === 401) return { sent: signInRedirect(reply, path) };
    return { sent: send(reply, 503, 'No se ha podido cargar', loadFailedBody) };
  }

  app.get('/cuenta/panel', async (request, reply) => {
    const gate = await account(request, reply, '/cuenta/panel');
    if ('sent' in gate) return gate.sent;
    const { me } = gate;
    const now = ctx.now();
    const today = localDayIn(me.profile.timeZone, now);
    const from = panelMondays(today)[0] ?? today;
    const stats = await readApi<StatsResponse>(
      app,
      request,
      `/v1/stats?${new URLSearchParams({ from, to: today }).toString()}`,
    );
    if (!stats.ok) {
      if (stats.status === 401) return signInRedirect(reply, '/cuenta/panel');
      return send(reply, 503, 'No se ha podido cargar', loadFailedBody);
    }
    return send(
      reply,
      200,
      'Tu panel',
      panelBody({ me, stats: stats.data, today, now, syncAvailable: caps.sync.enabled }),
      ['panel.js'],
    );
  });

  app.get('/cuenta/avisos', async (request, reply) => {
    const gate = await account(request, reply, '/cuenta/avisos');
    if ('sent' in gate) return gate.sent;
    const { me } = gate;
    const inbox = await readApi<InboxResponse>(app, request, '/v1/accountability/inbox');
    if (!inbox.ok && inbox.error?.code !== 'feature_disabled') {
      if (inbox.status === 401) return signInRedirect(reply, '/cuenta/avisos');
      return send(reply, 503, 'No se ha podido cargar', loadFailedBody);
    }
    return send(
      reply,
      200,
      'Avisos',
      avisosBody({ me, inbox: inbox.ok ? inbox.data : null, now: ctx.now() }),
      ['avisos.js'],
    );
  });
};
