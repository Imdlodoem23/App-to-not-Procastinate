/**
 * PLATFORM's surfaces and services in the real app (docs/DESKTOP.md §15, PROMPT §10):
 *
 * - the mini timer: 180×44, frameless, always on top, off the taskbar, remembered where dropped;
 * - the OSD: never focusable, centred 300 DIP above the bottom of the work area, gone after 2 s;
 *   shown after the tray's «Ampliar ▸» instead of the main window;
 * - the Nuclear overlay: every display covered, cannot be closed while Nuclear lasts;
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
  expect(overlay?.focusable).toBe(false);
  expect(overlay?.alwaysOnTop).toBe(true);
  expect(overlay?.outer).toEqual(bounds);
  await app.electron.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().includes('window=nuclear')) w.close();
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await surfaces(app.electron, 'nuclear'))[0]?.visible).toBe(true);
  const page = await surfacePage(app.electron, 'nuclear');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', 'nuclear');

  // Another fixture without Nuclear: the overlay goes away.
  await app.harness.load('idle');
  await expect
    .poll(async () => (await surfaces(app!.electron, 'nuclear'))[0]?.visible ?? false)
    .toBe(false);
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
