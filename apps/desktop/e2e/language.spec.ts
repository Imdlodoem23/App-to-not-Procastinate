/**
 * Language (Ajustes › Idioma): «Sistema» follows the OS language, «English» and «Español»
 * switch every surface at once, without a restart: the main window, the open detail window
 * and its title, the main window title and the tray (tooltip and menu).
 */
import { launchApp, type LaunchedApp } from './support/app';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

test('an English system shows the app in English (--harness-lang=en)', async () => {
  app = await launchApp({ state: 'one-block', show: true, args: ['--harness-lang=en'] });
  const main = await app.page('main');
  await expect(main.locator('html')).toHaveAttribute('lang', 'en');
  await expect(main.getByRole('heading', { name: /^Block: YouTube/ })).toBeVisible();
  await expect.poll(() => app?.harness.windowTitle()).toMatch(/^Céntrate · \d+ min left/);
  await expect.poll(() => app?.harness.trayTooltip()).toContain('left');
  const labels = (await app.harness.trayMenu()).map((item) => item.label);
  expect(labels).toContain('Quit (blocks stay active)');
});

test('«Idioma» switches every surface live, and back', async () => {
  app = await launchApp({ state: 'one-block', show: true });
  const main = await app.page('main');
  await expect(main.locator('html')).toHaveAttribute('lang', 'es');
  await expect(main.getByRole('heading', { name: /^Bloqueo: YouTube/ })).toBeVisible();

  await app.harness.openDetail('ajustes');
  const detail = await app.page('detail');
  await detail.getByRole('radio', { name: 'English' }).click();

  await expect(detail.getByRole('radio', { name: 'English' })).toBeChecked();
  await expect(detail.getByText('General: system theme')).toBeVisible();
  await expect(main.getByRole('heading', { name: /^Block: YouTube/ })).toBeVisible();
  await expect(main.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => app?.harness.windowTitle()).toMatch(/min left/);
  await expect.poll(() => app?.harness.trayTooltip()).toContain('left');
  await expect
    .poll(async () => (await app?.harness.trayMenu())?.map((item) => item.label))
    .toContain('Quick block');
  await expect
    .poll(() =>
      app?.electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.getTitle()),
      ),
    )
    .toContain('Settings');

  await detail.getByRole('radio', { name: 'Español' }).click();
  await expect(detail.getByText('General: tema del sistema')).toBeVisible();
  await expect(main.getByRole('heading', { name: /^Bloqueo: YouTube/ })).toBeVisible();
  await expect.poll(() => app?.harness.windowTitle()).toMatch(/quedan?/);
});
