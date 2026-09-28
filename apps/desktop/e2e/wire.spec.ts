/**
 * The wire between the app and a guardian over real HTTP (docs/DESKTOP.md §12 «wire»,
 * docs/ARCHITECTURE.md §9.2, §17): the production bootstrap (no harness, no mock guardian)
 * reads `client.json` from a temporary `CENTRATE_DATA_DIR` and talks to a local server with
 * Node's `fetch` from the main process.
 *
 * - main's requests carry the token and **no `Origin`** (GET and POST);
 * - a 304 publishes nothing to the renderers;
 * - a rotated token (guardian restart) is picked up without the link going down;
 * - a stopped guardian shows section 1 within 5 s, and the warning goes once it is back.
 */
import type { Page } from '@playwright/test';
import { GUARDIAN_PATHS } from '@centrate/shared/guardian-api';
import { launchApp, type LaunchedApp } from './support/app';
import { startGuardianServer, type GuardianServer } from './support/guardian-server';
import { expect, test } from './support/test';

let server: GuardianServer | null = null;
let app: LaunchedApp | null = null;

test.beforeEach(async () => {
  server = await startGuardianServer();
  app = await launchApp({ state: null, guardian: 'http', sysDir: server.dataDir });
});

test.afterEach(async () => {
  await app?.close();
  await server?.dispose();
  app = null;
  server = null;
});

function requireServer(): GuardianServer {
  if (!server) throw new Error('no guardian server');
  return server;
}

async function mainPage(): Promise<Page> {
  if (!app) throw new Error('no app');
  const page = await app.page('main');
  await expect(page.getByRole('textbox', { name: '¿Qué quieres hacer?' })).toBeVisible({
    timeout: 15_000,
  });
  return page;
}

const stoppedWarning = (page: Page) => page.getByRole('heading', { name: /^Guardián detenido/ });

async function waitForState(status: 200 | 304): Promise<void> {
  const s = requireServer();
  await expect
    .poll(() => s.requests().some((r) => r.path === GUARDIAN_PATHS.state && r.status === status), {
      timeout: 10_000,
    })
    .toBe(true);
}

test('main sends the token and no Origin, on GET and POST', async () => {
  const s = requireServer();
  const main = await mainPage();
  await waitForState(200);
  await expect(main.getByText('Guardián activo')).toBeVisible();
  await expect(stoppedWarning(main)).toHaveCount(0);

  // A POST through main (Ajustes «Nuevo código» uses this channel).
  const result = await main.evaluate(() =>
    (
      window as unknown as { centrate: { invoke(c: string, p: null): Promise<{ ok: boolean }> } }
    ).centrate.invoke('pairing:new-code', null),
  );
  expect(result.ok).toBe(true);

  const requests = s.requests();
  const post = requests.find((r) => r.method === 'POST' && r.path === GUARDIAN_PATHS.pairingCode);
  expect(post?.status).toBe(201);
  expect(requests.length).toBeGreaterThan(2);
  for (const request of requests) {
    expect(request.headers['origin'], `${request.method} ${request.path}`).toBeUndefined();
    if (request.path !== GUARDIAN_PATHS.health) {
      expect(request.headers['authorization'], `${request.method} ${request.path}`).toBe(
        `Bearer ${s.token()}`,
      );
    }
  }
});

test('304 answers publish nothing', async () => {
  const s = requireServer();
  const main = await mainPage();
  await waitForState(304);
  await main.evaluate(async () => {
    const w = window as unknown as {
      centrate: {
        on(channel: string, listener: (payload: unknown) => void): () => void;
        invoke(channel: string, payload: null): Promise<unknown>;
      };
      __pushes: { rev: unknown; changed: string[] }[];
    };
    // Each push with what it changed against the snapshot before it, for the failure message.
    let last = (
      (await w.centrate.invoke('app:init', null)) as { snapshot: Record<string, unknown> }
    ).snapshot;
    const text = (v: unknown): string => (JSON.stringify(v) ?? 'undefined').slice(0, 200);
    w.__pushes = [];
    w.centrate.on('ui:snapshot', (payload) => {
      const next = payload as Record<string, unknown>;
      const changed = Object.keys(next)
        .filter((k) => k !== 'rev' && JSON.stringify(next[k]) !== JSON.stringify(last[k]))
        .map((k) => (k === 'state' ? k : `${k}: ${text(last[k])} → ${text(next[k])}`));
      w.__pushes.push({ rev: next['rev'], changed });
      last = next;
    });
  });
  const before = s.requests().filter((r) => r.status === 304).length;
  await main.waitForTimeout(5_000);
  const notModified = s.requests().filter((r) => r.status === 304).length - before;
  expect(notModified, '304s in 5 s (2 s poll while visible)').toBeGreaterThanOrEqual(2);
  const pushes = await main.evaluate(
    () => (window as unknown as { __pushes: { rev: unknown; changed: string[] }[] }).__pushes,
  );
  expect(
    pushes.map((p) => p.rev),
    `ui:snapshot pushes during 304s: ${JSON.stringify(pushes)}`,
  ).toEqual([]);
});

test('a rotated token (guardian restart) is picked up without a warning', async () => {
  const s = requireServer();
  const main = await mainPage();
  await waitForState(200);
  const rotatedAt = Date.now();
  const token = s.rotateToken();
  await expect
    .poll(
      () =>
        s
          .requests()
          .some(
            (r) =>
              r.at >= rotatedAt &&
              r.path === GUARDIAN_PATHS.state &&
              r.headers['authorization'] === `Bearer ${token}` &&
              (r.status === 200 || r.status === 304),
          ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await expect(stoppedWarning(main)).toHaveCount(0);
  await expect(main.getByText('Guardián activo')).toBeVisible();
});

test('a stopped guardian shows the warning within 5 s; it goes when the guardian is back', async () => {
  const s = requireServer();
  const main = await mainPage();
  await waitForState(200);
  await expect(stoppedWarning(main)).toHaveCount(0);

  await s.stop();
  const stoppedAt = Date.now();
  await expect(stoppedWarning(main)).toBeVisible({ timeout: 8_000 });
  const shownAfter = Date.now() - stoppedAt;
  test.info().annotations.push({ type: 'warning after ms', description: String(shownAfter) });
  expect(shownAfter).toBeLessThanOrEqual(5_000);

  await s.start();
  await expect(stoppedWarning(main)).toHaveCount(0, { timeout: 10_000 });
});
