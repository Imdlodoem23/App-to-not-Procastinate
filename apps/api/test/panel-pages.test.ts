/**
 * /cuenta/panel and /cuenta/avisos (owner: CLIENT): gates (accounts off, signed out), what the
 * pages show from the JSON API, escaping of user text, CSP-safe markup, the registered assets,
 * and the pure chart and format helpers behind them.
 */
import type { CloudMergedDay } from '@centrate/shared/cloud-api';
import { addDays } from '@centrate/shared/cloud-api';
import type { FastifyInstance } from 'fastify';
import { Script } from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { devices } from '../src/db/schema';
import { AVISOS_JS, PANEL_CSS, PANEL_JS } from '../src/pages/panel-assets';
import {
  columnChart,
  formatMinutes,
  formatSignedPoints,
  minuteTicks,
  panelMondays,
  pointTicks,
  weekAxisLabels,
  weeklyTotals,
} from '../src/pages/panel-charts';
import { whenText } from '../src/pages/panel';
import { buildTestApp, createTestUser, fakeClock } from './helpers/app';
import type { FakeClock, TestUser } from './helpers/app';
import { buildCoreApp, sessionCookie } from './helpers/core';
import { createTestDb, resetDb, type TestDb } from './helpers/db';
import { addDay, befriend, linkPartners } from './helpers/social';

// Monday 2026-09-28, 12:00 in Madrid.
const NOW = '2026-09-28T10:00:00.000Z';
const TODAY = '2026-09-28';
const MINUS = '−';

/** No inline scripts, no inline styles, no event-handler attributes (the CSP forbids them). */
function expectCspSafe(body: string): void {
  expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(body).not.toMatch(/\sstyle=/);
  expect(body).not.toMatch(/\son[a-z]+=/);
  expect(body).not.toMatch(/<style/);
}

describe('pure helpers', () => {
  it('formats minutes and signed points in Spanish', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(440)).toBe('7 h 20 min');
    expect(formatMinutes(1240 * 60)).toBe('1.240 h');
    expect(formatSignedPoints(1240)).toBe('+1.240');
    expect(formatSignedPoints(-40)).toBe(`${MINUS}40`);
    expect(formatSignedPoints(0)).toBe('0');
  });

  it('lists the last 12 Mondays, the current week last', () => {
    const mondays = panelMondays('2027-01-03'); // Sunday of 2026-W53
    expect(mondays).toHaveLength(12);
    expect(mondays[11]).toBe('2026-12-28');
    expect(mondays[0]).toBe('2026-10-12');
    expect(weekAxisLabels(mondays).filter((l) => l !== null)).toHaveLength(4);
    expect(weekAxisLabels(mondays)[11]).toBe('28 dic');
  });

  it('sums merged days into weeks and counts goal days', () => {
    const mondays = panelMondays(TODAY);
    const d = (day: string, focus: number, goalMet: boolean | null): CloudMergedDay => ({
      day,
      focusMinutes: focus,
      studyMinutes: Math.floor(focus / 2),
      blocksCompleted: 0,
      studySessions: 0,
      attempts: 0,
      emergencyUnlocks: 0,
      punishments: 0,
      pointsEarned: 10,
      pointsLost: 3,
      goalMet,
    });
    const weeks = weeklyTotals(
      [
        d('2026-09-21', 60, true),
        d('2026-09-27', 30, false),
        d(TODAY, 90, true),
        d('2026-06-01', 999, true), // before the 12 weeks
      ],
      mondays,
      TODAY,
      true,
    );
    expect(weeks).toHaveLength(12);
    expect(weeks[10]).toMatchObject({
      from: '2026-09-21',
      to: '2026-09-27',
      daysElapsed: 7,
      focusMinutes: 90,
      studyMinutes: 45,
      pointsEarned: 20,
      pointsLost: 6,
      goalDays: 1,
    });
    expect(weeks[11]).toMatchObject({ from: TODAY, to: TODAY, daysElapsed: 1, goalDays: 1 });
    expect(weeks.reduce((t, w) => t + w.focusMinutes, 0)).toBe(180);
    expect(weeklyTotals([], mondays, TODAY, false)[0]?.goalDays).toBeNull();
  });

  it('builds round ticks', () => {
    expect(minuteTicks(0).map((t) => t.label)).toEqual(['0', '30 min']);
    expect(minuteTicks(440).map((t) => t.label)).toEqual(['0', '2 h', '4 h', '6 h', '8 h']);
    const points = pointTicks(120, 40);
    expect(points.map((t) => t.label)).toEqual([`${MINUS}50`, '0', '+50', '+100', '+150']);
    expect(pointTicks(0, 0).map((t) => t.value)).toEqual([0, 10]);
  });

  it('draws columns up and down from one baseline and escapes its text', () => {
    const svg = columnChart({
      ariaLabel: 'Puntos <b>',
      ticks: pointTicks(100, 50),
      slots: [
        {
          label: '6 jul',
          title: 'Semana "x" <y>',
          bars: [
            { value: 100, tone: 'green' },
            { value: -50, tone: 'red' },
          ],
        },
        { label: null, title: 'vacía', bars: [{ value: 0, tone: 'green' }] },
      ],
    }).value;
    expect(svg.match(/<path class="bar bar-green"/g)).toHaveLength(1);
    expect(svg.match(/<path class="bar bar-red"/g)).toHaveLength(1);
    expect(svg).toContain('aria-label="Puntos &lt;b&gt;"');
    expect(svg).toContain('<title>Semana &quot;x&quot; &lt;y&gt;</title>');
    expect(svg).toContain('role="img"');
    expectCspSafe(svg);
  });

  it('writes times in the viewer zone', () => {
    const now = new Date(NOW);
    expect(whenText('2026-09-28T08:05:00.000Z', 'Europe/Madrid', now)).toBe('hoy a las 10:05');
    expect(whenText('2026-09-27T16:40:00.000Z', 'Europe/Madrid', now)).toBe('ayer a las 18:40');
    expect(whenText('2026-09-20T16:40:00.000Z', 'America/New_York', now)).toBe(
      '20 sept a las 12:40',
    );
  });

  it('ships scripts that parse', () => {
    expect(() => new Script(PANEL_JS)).not.toThrow();
    expect(() => new Script(AVISOS_JS)).not.toThrow();
    expect(PANEL_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe('without accounts', () => {
  it('answers both pages with the «not available» page', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    for (const url of ['/cuenta/panel', '/cuenta/avisos']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Cuentas no disponibles');
    }
    await app.close();
  });
});

describe('with the real app', () => {
  let t: TestDb;
  let clock: FakeClock;
  let app: FastifyInstance;
  let ana: TestUser;

  beforeAll(async () => {
    t = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    clock = fakeClock(NOW);
    app = await buildTestApp({ db: t.db, clock });
    ana = await createTestUser(t.db, {
      now: clock.now(),
      displayName: 'Ana',
      email: 'ana@example.com',
      dailyGoalMinutes: 60,
      sharing: { syncStats: true },
    });
    return async () => {
      await app.close();
    };
  });

  async function addDevice(who: TestUser, name: string, installId: string): Promise<string> {
    const [row] = await t.db
      .insert(devices)
      .values({ userId: who.userId, installId, name, platform: 'linux', appVersion: '1.2.0' })
      .returning({ id: devices.id });
    return row?.id ?? '';
  }

  const get = (url: string, who: TestUser | null = ana) =>
    app.inject({ method: 'GET', url, headers: who ? who.headers : {} });

  it('sends a signed-out browser to sign in and back', async () => {
    for (const path of ['/cuenta/panel', '/cuenta/avisos']) {
      const res = await get(path, null);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/cuenta?volver=${encodeURIComponent(path)}`);
    }
    const revoked = await app.inject({
      method: 'GET',
      url: '/cuenta/panel',
      headers: { authorization: 'Bearer not-a-session' },
    });
    expect(revoked.statusCode).toBe(303);
  });

  it('shows the charts, the devices and the data actions', async () => {
    const laptop = await addDevice(ana, '<script>alert("x")</script>', 'install-ana-000000001');
    const desktop = await addDevice(ana, 'Sobremesa', 'install-ana-000000002');
    // Today on both computers (merged, capped at 1440), a day last week and one 11 weeks ago.
    await addDay(t.db, ana, laptop, TODAY, { focusMinutes: 1000, studyMinutes: 200 });
    await addDay(t.db, ana, desktop, TODAY, {
      focusMinutes: 800,
      pointsEarned: 120,
      pointsLost: 40,
    });
    await addDay(t.db, ana, laptop, '2026-09-22', { focusMinutes: 45, pointsLost: 10 });
    await addDay(t.db, ana, laptop, addDays(TODAY, -77), { focusMinutes: 30 });
    await addDay(t.db, ana, laptop, addDays(TODAY, -78), { focusMinutes: 999 }); // too old

    const res = await get('/cuenta/panel');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    const body = res.body;
    expectCspSafe(body);
    expect(body).toContain('<script src="/cuenta/assets/panel.js" defer></script>');
    expect(body).toContain('href="/cuenta/assets/panel.css"');
    expect(body).toContain('ana@example.com');

    // This week: 1440 min (capped), goal met 1 of 1 day, +120 / −50 points.
    expect(body).toContain('<dd>24 h</dd>');
    expect(body).toContain('1 de 1 días');
    expect(body).toMatch(new RegExp(`\\+120\\s*·\\s*${MINUS}40`));
    // Twelve weeks: from Monday 2026-07-13 to today.
    expect(body).toContain('Del 13 de julio al 28 de septiembre');
    expect(body).toContain('En 12 semanas: 25 h 15 min.');
    expect(body.match(/<svg class="chart-svg chart-wide"/g)).toHaveLength(4);
    expect(body.match(/<svg class="chart-svg chart-narrow"/g)).toHaveLength(4);
    expect(body).toContain(`Perdidos: ${MINUS}50.`);
    expect(body).toContain('Lo cumpliste 1 de 78 días.');
    expect(body).not.toContain('16 h 39 min'); // the day before the 12 weeks

    // Devices: escaped names, «Quitar» wired by id, never raw user markup.
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(body).toContain(`data-remove-device="${laptop}"`);
    expect(body).toContain(`data-remove-device="${desktop}"`);
    expect(body).toContain('Linux · Céntrate 1.2.0');

    expect(body).toContain('href="/v1/me/export"');
    expect(body).toContain('id="delete-account"');
    expect(body).toContain('id="reauth" hidden');
  });

  it('explains an empty panel, sync off and a missing goal', async () => {
    const bea = await createTestUser(t.db, { now: clock.now(), displayName: 'Bea' });
    const res = await get('/cuenta/panel', bea);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Aún no hay estadísticas en la nube');
    expect(res.body).toContain('La sincronización de estadísticas está desactivada');
    expect(res.body).toContain('Ningún ordenador está conectado');
    expect(res.body).not.toContain('<svg');

    const device = await addDevice(bea, 'Portátil', 'install-bea-000000001');
    await addDay(t.db, bea, device, TODAY, { focusMinutes: 25 });
    const withData = await get('/cuenta/panel', bea);
    expect(withData.body).toContain('Lo que ya subiste sigue aquí hasta que lo borres.');
    expect(withData.body).toContain('Pon un objetivo diario en la app');
    expect(withData.body.match(/<svg class="chart-svg chart-wide"/g)).toHaveLength(3);
  });

  it('works with a browser cookie session', async () => {
    const core = await buildCoreApp(t.db, clock);
    const res = await core.app.inject({
      method: 'GET',
      url: '/cuenta/panel',
      headers: { cookie: sessionCookie(ana.token) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Tu panel');
    await core.app.close();
  });

  it('serves the page assets', async () => {
    for (const [name, type] of [
      ['panel.css', 'text/css'],
      ['panel.js', 'text/javascript'],
      ['avisos.js', 'text/javascript'],
    ] as const) {
      const res = await get(`/cuenta/assets/${name}`, null);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(type);
    }
  });

  it('lists a partner’s alerts and offers a decision on pending ones', async () => {
    const owner = await createTestUser(t.db, {
      now: clock.now(),
      displayName: '<b>Dani</b>',
      timeZone: 'Europe/Madrid',
    });
    const long = new Date('2026-09-01T00:00:00.000Z');
    await befriend(t.db, owner, ana, long);
    await linkPartners(t.db, owner, ana, { requireApproval: true, at: long });

    const post = async (at: string, kind: string, countdownMinutes: number | null) => {
      clock.set(at);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/accountability/events',
        headers: owner.headers,
        payload: {
          clientRef: `ref-${at.replace(/\D/g, '')}`,
          kind,
          occurredAt: at,
          sentAt: at,
          countdownEndsAt:
            countdownMinutes === null
              ? null
              : new Date(Date.parse(at) + countdownMinutes * 60_000).toISOString(),
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json<{ eventId: string }>().eventId;
    };
    const approved = await post('2026-09-27T16:40:00.000Z', 'emergency_requested', 10);
    const decided = await app.inject({
      method: 'POST',
      url: `/v1/accountability/events/${approved}/decision`,
      headers: ana.headers,
      payload: { decision: 'approve', note: 'Ánimo <3' },
    });
    expect(decided.statusCode).toBe(200);
    await post('2026-09-28T07:00:00.000Z', 'emergency_requested', 10); // never answered
    await post('2026-09-28T08:00:00.000Z', 'study_abandoned', null);
    const pending = await post(NOW, 'emergency_requested', 15);

    const res = await get('/cuenta/avisos');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expectCspSafe(body);
    expect(body).toContain('<script src="/cuenta/assets/avisos.js" defer></script>');
    expect(body).not.toContain('<b>Dani</b>');
    expect(body).toContain('&lt;b&gt;Dani&lt;/b&gt;');

    const [waiting, recent] = body.split('<h2>Recientes</h2>');
    expect(waiting).toContain('Esperan tu respuesta');
    expect(waiting).toContain(`data-event="${pending}"`);
    expect(waiting).toContain('data-decision="approve"');
    expect(waiting).toContain('data-decision="deny"');
    // The deadline ends 30 s before the 15-minute countdown (12:14:30).
    expect(waiting).toContain('Puedes responder hasta las 12:14');
    expect(recent).toContain('ha abandonado una sesión de estudio');
    expect(recent).toContain('Nadie respondió a tiempo, así que se aprobó solo.');
    expect(recent).toContain('ayer a las 18:40 · Lo aprobaste tú.');
    expect(recent).toContain('Tu nota: «Ánimo &lt;3»');
    expect(recent).not.toContain('data-event=');
  });

  it('still offers «Rechazar» on an approval, and no form to a partner who is only told', async () => {
    const owner = await createTestUser(t.db, { now: clock.now(), displayName: 'Dani' });
    const quick = await createTestUser(t.db, { now: clock.now(), displayName: 'Eva' });
    const told = await createTestUser(t.db, { now: clock.now(), displayName: 'Fer' });
    const long = new Date('2026-09-01T00:00:00.000Z');
    for (const p of [ana, quick, told]) await befriend(t.db, owner, p, long);
    await linkPartners(t.db, owner, ana, { requireApproval: true, at: long });
    await linkPartners(t.db, owner, quick, { requireApproval: true, at: long });
    await linkPartners(t.db, owner, told, { requireApproval: false, at: long });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/accountability/events',
      headers: owner.headers,
      payload: {
        clientRef: 'ref-000000000000001',
        kind: 'emergency_requested',
        occurredAt: NOW,
        sentAt: NOW,
        countdownEndsAt: '2026-09-28T10:15:00.000Z',
      },
    });
    const { eventId } = res.json<{ eventId: string }>();
    const decided = await app.inject({
      method: 'POST',
      url: `/v1/accountability/events/${eventId}/decision`,
      headers: quick.headers,
      payload: { decision: 'approve', note: null },
    });
    expect(decided.statusCode).toBe(200);

    const [waiting] = (await get('/cuenta/avisos')).body.split('<h2>Recientes</h2>');
    expect(waiting).toContain(`data-event="${eventId}"`);
    expect(waiting).toContain(
      'Lo aprobó otro compañero, pero aún puedes rechazarlo hasta las 12:14',
    );
    expect(waiting).toContain('data-decision="deny"');
    expect(waiting).not.toContain('data-decision="approve"');

    const toldPage = (await get('/cuenta/avisos', told)).body;
    expect(toldPage).not.toContain('Esperan tu respuesta');
    expect(toldPage).not.toContain('data-event=');
    expect(toldPage).toContain('Lo aprobó otro compañero.');
  });

  it('says so when there are no alerts', async () => {
    const res = await get('/cuenta/avisos');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No hay avisos en los últimos 30 días.');
    expect(res.body).not.toContain('Esperan tu respuesta');
  });
});
