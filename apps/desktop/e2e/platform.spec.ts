/**
 * PLATFORM's surfaces and services in the real app (docs/DESKTOP.md §15, PROMPT §10):
 *
 * - the mini timer: 180×44, frameless, always on top, off the taskbar, remembered where dropped;
 * - the OSD: never focusable, centred 300 DIP above the bottom of the work area, gone after 2 s;
 *   shown after the tray's «Ampliar ▸» instead of the main window;
 * - the Nuclear overlay: every display covered, cannot be closed while Nuclear lasts; focusable
 *   so Tab reaches «Salida de emergencia»; «Salir» (tray, footer) and «Reiniciar para
 *   actualizar» refused while it lasts, the tray's «Salida de emergencia…» instead; Emergencia
 *   above it only while it shows Emergencia;
 * - the schedule guards of the fake guardian in Bloqueos (`schedule_starting_soon`,
 *   `schedule_in_progress` with the guardian's words);
 * - `harness.openSurface` for each surface, and the tray's «Mini temporizador» checkbox.
 *
 * Surfaces are drawn by SURFACES's views; a missing view renders nothing, which these checks
 * do not depend on (they read the windows, not their pixels).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { HARNESS_GLOBAL } from '../src/main/contracts';
import { OSD_LAYOUT } from '../src/shared/platform';
import type { SurfaceKind } from '../src/shared/ui-state';
import { launchApp, type LaunchedApp } from './support/app';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

interface SurfaceInfo {
  url: string;
  visible: boolean;
  focusable: boolean;
  alwaysOnTop: boolean;
  content: { x: number; y: number; width: number; height: number };
  outer: { x: number; y: number; width: number; height: number };
  skipTaskbar: boolean;
  title: string;
}

/** Every open surface window of `kind`. */
function surfaces(electron: ElectronApplication, kind: SurfaceKind): Promise<SurfaceInfo[]> {
  return electron.evaluate(({ BrowserWindow }, want) => {
    return BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents.getURL().includes(`window=${want}`))
      .map((w) => ({
        url: w.webContents.getURL(),
        visible: w.isVisible(),
        focusable: w.isFocusable(),
        alwaysOnTop: w.isAlwaysOnTop(),
        content: w.getContentBounds(),
        outer: w.getBounds(),
        // Not readable in Electron: the window was created with it (checked by the list).
        skipTaskbar: true,
        title: w.getTitle(),
      }));
  }, kind);
}

function openSurface(electron: ElectronApplication, kind: SurfaceKind): Promise<void> {
  return electron.evaluate(
    async (_e, input) => {
      const api = (globalThis as Record<string, unknown>)[input.key] as {
        openSurface(kind: string): Promise<void>;
      };
      await api.openSurface(input.kind);
    },
    { key: HARNESS_GLOBAL, kind },
  );
}

async function surfacePage(electron: ElectronApplication, kind: SurfaceKind): Promise<Page> {
  await expect
    .poll(() => electron.windows().some((p) => p.url().includes(`window=${kind}`)), {
      timeout: 15_000,
    })
    .toBe(true);
  const page = electron.windows().find((p) => p.url().includes(`window=${kind}`));
  if (!page) throw new Error(`no ${kind} page`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test('the mini timer: 180×44, on top, rendered for its fixture', async () => {
  app = await launchApp({ state: 'mini-timer' });
  await openSurface(app.electron, 'mini-timer');
  const [timer] = await surfaces(app.electron, 'mini-timer');
  expect(timer?.visible).toBe(true);
  expect(timer?.alwaysOnTop).toBe(true);
  expect(timer?.content.width).toBe(180);
  expect(timer?.content.height).toBe(44);
  expect(timer?.title).toBe('Mini temporizador');
  const page = await surfacePage(app.electron, 'mini-timer');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', 'mini-timer');
  await expect(page.locator('html')).toHaveAttribute('data-window', 'mini-timer');
});

test('the mini timer remembers where it is dropped and hides from the tray', async () => {
  app = await launchApp({ state: 'mini-timer' });
  await expect
    .poll(async () => (await surfaces(app!.electron, 'mini-timer'))[0]?.visible)
    .toBe(true);
  const menu = await app.harness.trayMenu();
  expect(menu.find((i) => i.id === 'mini-timer')).toMatchObject({
    type: 'checkbox',
    checked: true,
  });
  // A drag ends where the user leaves it: main keeps that place in the prefs.
  await app.electron.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('window=mini-timer'),
    );
    if (!win) throw new Error('no mini timer');
    win.setPosition(400, 300);
    win.emit('moved');
    win.emit('move');
  });
  await expect
    .poll(async () => (await app?.harness.snapshot())?.prefs.miniTimer.position, { timeout: 5_000 })
    .toEqual({ x: 400, y: 300 });

  await app.harness.clickTrayItem('mini-timer');
  await expect
    .poll(async () => (await surfaces(app!.electron, 'mini-timer'))[0]?.visible)
    .toBe(false);
  expect((await app.harness.snapshot()).prefs.miniTimer.visible).toBe(false);
});

test('the OSD never takes focus and sits 300 DIP above the bottom of the work area', async () => {
  app = await launchApp({ state: 'osd' });
  await openSurface(app.electron, 'osd');
  const [osd] = await surfaces(app.electron, 'osd');
  expect(osd?.visible).toBe(true);
  expect(osd?.focusable).toBe(false);
  expect(osd?.alwaysOnTop).toBe(true);
  const { workArea } = (await app.harness.bounds()).display;
  if (!osd) return;
  expect(osd.outer.y + osd.outer.height).toBe(
    workArea.y + workArea.height - OSD_LAYOUT.bottomOffset,
  );
  expect(
    Math.abs(osd.outer.x + osd.outer.width / 2 - (workArea.x + workArea.width / 2)),
  ).toBeLessThanOrEqual(1);
  const page = await surfacePage(app.electron, 'osd');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', 'osd');
});

test('the tray «Ampliar ▸» shows the OSD instead of the main window', async () => {
  app = await launchApp({ state: 'one-block' });
  await app.harness.clickTrayItem('extend:15');
  await expect
    .poll(async () => (await app?.harness.snapshot())?.osd?.text, { timeout: 5_000 })
    .toBe('+15 min · hasta las 17:57');
  const snapshot = await app.harness.snapshot();
  expect(snapshot.osd).toMatchObject({ icon: 'extend', tone: 'orange' });
  expect(snapshot.ops.extendQueue).toHaveLength(1);
  expect((await app.harness.bounds()).main?.visible).toBe(false);
  await expect.poll(async () => (await surfaces(app!.electron, 'osd'))[0]?.visible).toBe(true);
  // Cleared 2 s later (real time: the OSD is not on the frozen clock).
  await expect
    .poll(async () => (await app?.harness.snapshot())?.osd, { timeout: 5_000 })
    .toBeNull();
  await expect.poll(async () => (await surfaces(app!.electron, 'osd'))[0]?.visible).toBe(false);
});

test('the Nuclear overlay covers the display and cannot be closed', async () => {
  app = await launchApp({ state: 'nuclear' });
  await openSurface(app.electron, 'nuclear');
  const overlays = await surfaces(app.electron, 'nuclear');
  expect(overlays).toHaveLength(1);
  const [overlay] = overlays;
  const { bounds } = (await app.harness.bounds()).display;
  expect(overlay?.visible).toBe(true);
  // Focusable: keyboard and screen reader users must reach «Salida de emergencia».
  expect(overlay?.focusable).toBe(true);
  expect(overlay?.alwaysOnTop).toBe(true);
  expect(overlay?.outer).toEqual(bounds);
  // Named for screen readers when it takes the focus (WCAG 2.4.2).
  expect(overlay?.title).toBe('Céntrate · Castigo');
  await app.electron.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes('window=nuclear')) w.close();
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await surfaces(app.electron, 'nuclear'))[0]?.visible).toBe(true);
  const page = await surfacePage(app.electron, 'nuclear');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', 'nuclear');

  // Minimised by the window manager (Linux ignores `minimizable: false`): it comes back.
  await app.electron.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes('window=nuclear')) w.minimize();
    }
  });
  await expect
    .poll(() =>
      app!.electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => w.webContents.getURL().includes('window=nuclear'))
          .every((w) => w.isVisible() && !w.isMinimized()),
      ),
    )
    .toBe(true);

  // Another fixture without Nuclear: the overlay goes away.
  await app.harness.load('idle');
  await expect
    .poll(async () => (await surfaces(app!.electron, 'nuclear'))[0]?.visible ?? false)
    .toBe(false);
});

interface DetailInfo {
  visible: boolean;
  alwaysOnTop: boolean;
  title: string;
}

/** The detail window: shown, above others (`alwaysOnTop`), its title (the view). */
function detailInfo(electron: ElectronApplication): Promise<DetailInfo | null> {
  return electron.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (x) => !x.isDestroyed() && x.webContents.getURL().includes('window=detail'),
    );
    return w
      ? { visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop(), title: w.getTitle() }
      : null;
  });
}

test('the Nuclear overlay takes the focus, lands on the countdown and Tab reaches «Salida de emergencia»', async () => {
  app = await launchApp({ state: 'nuclear' });
  await openSurface(app.electron, 'nuclear');
  const page = await surfacePage(app.electron, 'nuclear');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', 'nuclear');
  const [overlay] = await surfaces(app.electron, 'nuclear');
  expect(overlay?.focusable).toBe(true);
  // The OS focus is on the overlay (not only CDP's keyboard reaching an unfocused page).
  await expect
    .poll(() =>
      app!.electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.isFocused() && w.webContents.getURL().includes('window=nuclear'),
        ),
      ),
    )
    .toBe(true);
  // A screen reader lands on the column: a named group, described by the countdown and cause.
  const column = page.getByRole('group', { name: /Castigo/ });
  await expect(column).toBeFocused();
  await expect(column).toHaveAttribute('tabindex', '-1');
  const described = await column.evaluate((el) =>
    (el.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .some((id) => document.getElementById(id)?.querySelector('[role="timer"]') != null),
  );
  expect(described).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /Salida de emergencia/ })).toBeFocused();
});

test('while Nuclear lasts «Salir» and the update install are refused; the tray offers the emergency exit', async () => {
  app = await launchApp({ state: 'nuclear' });
  await openSurface(app.electron, 'nuclear');
  const menu = await app.harness.trayMenu();
  expect(menu.some((i) => i.id === 'quit')).toBe(false);
  expect(menu.find((i) => i.id === 'emergency')?.label).toBe('Salida de emergencia…');

  // «Salir» from the footer (any window may send it): an OSD instead of a quit.
  const page = await surfacePage(app.electron, 'nuclear');
  await page.evaluate(() => {
    (window as unknown as { centrate: { send(c: string, p: null): void } }).centrate.send(
      'app:quit',
      null,
    );
  });
  await expect
    .poll(async () => (await app?.harness.snapshot())?.osd?.text, { timeout: 5_000 })
    .toBe('Nuclear en curso · usa la salida de emergencia');
  expect((await surfaces(app.electron, 'nuclear'))[0]?.visible).toBe(true);

  // «Reiniciar para actualizar»: refused with the reason.
  const install = await page.evaluate(() =>
    (
      window as unknown as { centrate: { invoke(c: string, r: null): Promise<unknown> } }
    ).centrate.invoke('updater:install', null),
  );
  expect(install).toMatchObject({ ok: false, error: { kind: 'rejected', code: 'nuclear_active' } });

  // The tray's «Salida de emergencia…»: Emergencia above the overlay.
  await app.harness.clickTrayItem('emergency');
  await expect
    .poll(async () => detailInfo(app!.electron), { timeout: 10_000 })
    .toMatchObject({ visible: true, alwaysOnTop: true });
  expect((await detailInfo(app.electron))?.title).toContain('Emergencia');
  const detail = await app.page('detail');

  // Closed, then Ajustes: not above the overlay any more.
  await detail.evaluate(() => {
    (window as unknown as { centrate: { send(c: string, p: null): void } }).centrate.send(
      'window:close-detail',
      null,
    );
  });
  await expect.poll(async () => (await detailInfo(app!.electron))?.visible).toBe(false);
  expect((await detailInfo(app.electron))?.alwaysOnTop).toBe(false);
  await app.harness.openDetail('ajustes');
  await expect.poll(async () => (await detailInfo(app!.electron))?.visible).toBe(true);
  expect(await detailInfo(app.electron)).toMatchObject({ alwaysOnTop: false });
  expect((await detailInfo(app.electron))?.title).toContain('Ajustes');

  // Without Nuclear, «Salir» is back.
  await app.harness.load('idle');
  expect((await app.harness.trayMenu()).some((i) => i.id === 'quit')).toBe(true);
});

test('Bloqueos: the fake guardian refuses a delete 10 min before a start and any change while it runs', async () => {
  app = await launchApp({ state: 'schedules', show: true });
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  const section = detail.locator('[data-section="blq-schedules"]');
  await section
    .locator('.blq-editor')
    .getByRole('button', { name: /^Cancelar/ })
    .click();
  const first = section.getByRole('listitem').first();
  await expect(first).toContainText('Tardes de estudio');
  const invoke = (channel: string, req: unknown): Promise<unknown> =>
    detail.evaluate(
      ({ channel, req }) =>
        (
          window as unknown as { centrate: { invoke(c: string, r: unknown): Promise<unknown> } }
        ).centrate.invoke(channel, req),
      { channel, req },
    );
  const list = (await invoke('schedules:list', null)) as {
    ok: boolean;
    value: Array<{ id: string; nextOccurrence: { startsAt: string } | null }>;
  };
  const tardes = list.value[0];
  // Computed on the fake guardian's clock: today 18:00 Madrid.
  expect(tardes?.nextOccurrence?.startsAt).toBe('2026-09-28T16:00:00.000Z');

  // 17:52: the guardian refuses the delete with the start (409 `schedule_starting_soon`).
  await app.harness.advance(52 * 60_000);
  expect(await invoke('schedules:delete', { id: tardes?.id })).toMatchObject({
    ok: false,
    error: {
      kind: 'rejected',
      code: 'schedule_starting_soon',
      details: { startsAt: '2026-09-28T16:00:00.000Z' },
    },
  });
  await expect(first).toContainText('Empieza en menos de 10 min');

  // 18:01: the occurrence runs as a schedule block. The editor opened before still allows
  // «Guardar»; the guardian refuses it with the block's end, in the guardian's words.
  await first.getByRole('button', { name: /^Editar/ }).click();
  const editor = section.locator('.blq-editor');
  await editor.getByRole('checkbox', { name: 'sábado' }).check();
  await app.harness.advance(9 * 60_000);
  const running = (await app.harness.snapshot()).state?.blocks.find((b) => b.kind === 'schedule');
  expect(running).toMatchObject({ scheduleId: tardes?.id, endsAt: '2026-09-28T18:00:00.000Z' });
  await editor.getByRole('button', { name: /Guardar/ }).click();
  await expect(detail.locator('[data-announcer]')).toHaveText(
    'En curso hasta las 20:00: podrás cambiarlo cuando acabe',
  );
  expect(await invoke('schedules:delete', { id: tardes?.id })).toMatchObject({
    ok: false,
    error: {
      code: 'schedule_in_progress',
      details: { blockId: running?.id, endsAt: '2026-09-28T18:00:00.000Z' },
    },
  });
});

test('openSurface shows each surface on demand and loads switch them back', async () => {
  app = await launchApp({ state: 'one-block' });
  for (const kind of ['mini-timer', 'osd', 'nuclear'] as const) {
    await openSurface(app.electron, kind);
    expect(
      (await surfaces(app.electron, kind)).every((s) => s.visible),
      kind,
    ).toBe(true);
  }
  await app.harness.load('idle');
  for (const kind of ['mini-timer', 'osd', 'nuclear'] as const) {
    await expect
      .poll(async () => (await surfaces(app!.electron, kind)).some((s) => s.visible), {
        message: kind,
      })
      .toBe(false);
  }
});
