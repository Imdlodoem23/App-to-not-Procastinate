/**
 * The account pages (/cuenta, /cuenta/codigo) and their assets: escaping, `volver` handling,
 * the CSP (no inline scripts or styles) and the shared tokens.
 */
import { Script } from 'node:vm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { safeVolver } from '../src/pages/account';
import { ACCOUNT_JS, PAGES_CSS } from '../src/pages/assets';
import { createTestUser, fakeClock } from './helpers/app';
import type { FakeClock } from './helpers/app';
import { buildCoreApp, sessionCookie } from './helpers/core';
import type { CoreApp } from './helpers/core';
import { createTestDb, resetDb, type TestDb } from './helpers/db';

let t: TestDb;
let clock: FakeClock;
let core: CoreApp;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await resetDb(t.db);
  clock = fakeClock('2026-09-28T10:00:00.000Z');
  core = await buildCoreApp(t.db, clock);
  return async () => {
    await core.app.close();
  };
});

describe('safeVolver', () => {
  it('accepts only relative /cuenta paths', () => {
    expect(safeVolver('/cuenta')).toBe('/cuenta');
    expect(safeVolver('/cuenta/conectar?port=5000')).toBe('/cuenta/conectar?port=5000');
    for (const bad of [
      'https://evil.example/cuenta',
      '//evil.example/cuenta',
      '/cuenta//evil.example',
      '/cuentas',
      '/cuenta\\@evil',
      '/i/ABCDE',
      '/cuenta\n',
      42,
    ]) {
      expect(safeVolver(bad), String(bad)).toBeNull();
    }
  });
});

describe('/cuenta', () => {
  it('offers Google and the email code, with the age notice and no inline code', async () => {
    const res = await core.app.inject({ method: 'GET', url: '/cuenta' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.body).toContain('<html lang="es">');
    expect(res.body).toContain('Continuar con Google');
    expect(res.body).toContain('Recibir un código por email');
    expect(res.body).toContain('al menos 14 años');
    expect(res.body).toContain('<meta name="referrer" content="same-origin" />');
    expect(res.body).toContain('src="/cuenta/assets/cuenta.js"');
    expect(res.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(res.body).not.toMatch(/\sstyle=/);
    expect(res.body).not.toMatch(/\son[a-z]+=/);
  });

  it('keeps a valid volver (escaped) and drops anything else', async () => {
    const volver = '/cuenta/conectar?state="><script>x</script>';
    const res = await core.app.inject({
      method: 'GET',
      url: `/cuenta?volver=${encodeURIComponent(volver)}`,
    });
    expect(res.body).toContain('data-volver="/cuenta/conectar?state=&quot;&gt;&lt;script&gt;');
    expect(res.body).not.toContain('<script>x</script>');
    const evil = await core.app.inject({
      method: 'GET',
      url: `/cuenta?volver=${encodeURIComponent('https://evil.example')}`,
    });
    expect(evil.body).toContain('data-volver="/cuenta"');
  });

  it('shows the account when signed in and follows volver', async () => {
    const u = await createTestUser(t.db, { now: clock.now(), email: 'ana<b>@example.com' });
    const cookie = sessionCookie(u.token);
    const res = await core.app.inject({ method: 'GET', url: '/cuenta', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ana&lt;b&gt;@example.com');
    expect(res.body).toContain('id="sign-out"');
    const back = await core.app.inject({
      method: 'GET',
      url: '/cuenta?volver=%2Fcuenta%2Fpanel',
      headers: { cookie },
    });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/cuenta/panel');
  });

  it('shows a notice after a failed Google sign-in', async () => {
    const res = await core.app.inject({ method: 'GET', url: '/cuenta?error=access_denied' });
    expect(res.body).toContain('No se ha podido iniciar sesión');
  });

  it('says accounts are unavailable when the server has none', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    for (const url of ['/cuenta', '/cuenta/codigo', '/cuenta/conectar']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(503);
      expect(res.body).toContain('Céntrate funciona igual sin cuenta');
    }
    await app.close();
  });
});

describe('/cuenta/codigo', () => {
  it('asks for a click before using the code from the link', async () => {
    const res = await core.app.inject({ method: 'GET', url: '/cuenta/codigo' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="link-form"');
    expect(res.body).toContain('Entrar');
  });
});

describe('/cuenta/assets', () => {
  it('serves the tokens, the styles and a script that parses', async () => {
    const tokens = await core.app.inject({ method: 'GET', url: '/cuenta/assets/tokens.css' });
    expect(tokens.statusCode).toBe(200);
    expect(tokens.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(tokens.body).toContain('--bg:');
    const css = await core.app.inject({ method: 'GET', url: '/cuenta/assets/pages.css' });
    expect(css.body).toBe(PAGES_CSS);
    // Colors only through the design tokens.
    expect(PAGES_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const js = await core.app.inject({ method: 'GET', url: '/cuenta/assets/cuenta.js' });
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(() => new Script(ACCOUNT_JS)).not.toThrow();
    expect(
      (await core.app.inject({ method: 'GET', url: '/cuenta/assets/nope.js' })).statusCode,
    ).toBe(404);
    expect(
      (await core.app.inject({ method: 'GET', url: '/cuenta/assets/..%2Fserver.ts' })).statusCode,
    ).toBe(404);
  });
});
