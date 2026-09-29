/**
 * «Mantener despierto» (ARCHITECTURE §5.11) against the fake guardian:
 *
 * - the tray's «Mantener despierto ▸» turns it on with one whole `PUT`; the footer chip
 *   («Despierto · hasta las 18:00», in the version's place), the tooltip and the display blocker follow; the running
 *   choice again sends nothing;
 * - the chip (keyboard) pops up the same choices; «Desactivar» turns it off and releases the
 *   display;
 * - the error chip and the Ajustes group are clean for axe and the keyboard audit; the Ajustes
 *   switch, the «pantalla» switch and the duration slider each send one change;
 * - when its end passes, «Ya no se mantiene despierto» is notified and everything lets go.
 */
import type { Page } from '@playwright/test';
import type { RecordedGuardianCall } from '../src/main/contracts';
import { advanceInSteps, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, settleMain, settleWindow } from './support/checks';
import { auditKeyboard, auditProblems } from './support/keyboard';
import { expect, test } from './support/test';

const MIN = 60_000;

function writes(calls: RecordedGuardianCall[]): unknown[] {
  return calls.filter((c) => c.method === 'setKeepAwake').map((c) => c.body);
}

async function expectClean(page: Page, label: string): Promise<void> {
  const violations = await axeViolations(page);
  expect(violations, `${label}: ${formatViolations(violations)}`).toEqual([]);
  const problems = auditProblems(await auditKeyboard(page));
  expect(problems, `${label}:\n${problems.join('\n')}`).toEqual([]);
}

async function mainOn(app: LaunchedApp, id: 'idle' | 'keep-awake' | 'keep-awake-error') {
  await app.harness.load(id, { theme: 'light', display: '1920x1080@100' });
  await app.harness.showMain();
  await settleMain(app);
  return app.page('main');
}

const chip = (page: Page) => page.locator('.footer-awake-chip');

test('the tray turns it on for 1 h: chip, tooltip and display follow; the same choice sends nothing', async ({
  apps,
}) => {
  const app = await apps.at(1);
  const main = await mainOn(app, 'idle');
  await expect(chip(main)).toHaveCount(0);
  expect(await app.harness.keepAwakeDisplay()).toBe(false);

  const menu = await app.harness.trayMenu();
  const submenu = menu.find((i) => i.id === 'keep-awake');
  expect(submenu?.label).toBe('Mantener despierto');
  expect(submenu?.submenu.map((i) => [i.label, i.checked])).toEqual([
    ['30 min', false],
    ['1 h', false],
    ['2 h', false],
    ['4 h', false],
    ['Hasta que lo desactive', false],
  ]);

  await app.harness.clickTrayItem('keep-awake:60');
  await expect(chip(main)).toHaveText('Despierto · hasta las 18:00');
  await expect(main.getByRole('button', { name: 'Despierto · hasta las 18:00' })).toHaveAttribute(
    'aria-haspopup',
    'menu',
  );
  expect(await app.harness.trayTooltip()).toBe(
    'Céntrate · sin bloqueos · 1.240 pts · despierto hasta las 18:00',
  );
  await expect.poll(() => app.harness.keepAwakeDisplay()).toBe(true);
  const after = await app.harness.trayMenu();
  const checked = after
    .find((i) => i.id === 'keep-awake')
    ?.submenu.filter((i) => i.checked)
    .map((i) => i.id);
  expect(checked).toEqual(['keep-awake:60']);
  expect(writes(await app.harness.guardianCalls())).toEqual([
    { on: true, durationMinutes: 60, display: true },
  ]);

  // Choosing the running duration again keeps the countdown: nothing is written.
  await app.harness.clickTrayItem('keep-awake:60');
  await app.harness.advance(0);
  expect(writes(await app.harness.guardianCalls())).toHaveLength(1);
  await expect(chip(main)).toHaveText('Despierto · hasta las 18:00');
  // It took the version's place.
  await expect(main.getByText('v0.1.0')).toHaveCount(0);
  await expectClean(main, 'keep-awake on');
});

test('the chip opens the same choices from the keyboard; «Desactivar» turns it off', async ({
  apps,
}) => {
  const app = await apps.at(1);
  const main = await mainOn(app, 'keep-awake');
  await expect(chip(main)).toHaveText('Despierto');
  await expect.poll(() => app.harness.keepAwakeDisplay()).toBe(true);

  await chip(main).focus();
  await main.keyboard.press('Enter');
  await expect
    .poll(async () =>
      (await app.harness.keepAwakeMenu())?.filter((i) => i.checked).map((i) => i.id),
    )
    .toEqual(['keep-awake:forever']);
  const popup = (await app.harness.keepAwakeMenu()) ?? [];
  expect(popup.at(-1)).toMatchObject({ id: 'keep-awake:off', label: 'Desactivar' });

  await app.harness.clickTrayItem('keep-awake:off');
  await expect(chip(main)).toHaveCount(0);
  await expect.poll(() => app.harness.keepAwakeDisplay()).toBe(false);
  expect(writes(await app.harness.guardianCalls())).toEqual([
    { on: false, durationMinutes: null, display: true },
  ]);
  expect(await app.harness.trayTooltip()).not.toContain('despierto');
});

test('the error chip says it in orange and stays accessible', async ({ apps }) => {
  const app = await apps.at(1);
  const main = await mainOn(app, 'keep-awake-error');
  await expect(chip(main)).toHaveText('Despierto: error');
  await expect(chip(main)).toHaveAttribute('data-tone', 'orange');
  // The help line under the buttons says why.
  await expect(main.locator('#pie-help')).toHaveText(
    'No se ha podido mantener despierto este equipo',
  );
  expect(await app.harness.trayTooltip()).toMatch(/· no se puede mantener despierto$/);
  await expectClean(main, 'keep-awake-error');
});

test('Ajustes: the switch, «pantalla» and the duration each send one change', async ({ apps }) => {
  const app = await apps.at(1);
  await app.harness.load('keep-awake-ajustes', { theme: 'light', display: '1920x1080@100' });
  await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await settleWindow(app, 'detail');
  const group = detail.locator('[data-section="aj-despierto"]');
  await expect(
    group.getByRole('heading', { name: 'Mantener despierto: hasta las 18:30' }),
  ).toBeVisible();
  await expect(group.getByText('cerrar la tapa sigue suspendiendo el equipo')).toBeVisible();
  await expectClean(detail, 'keep-awake-ajustes');

  const toggle = group.getByRole('switch', { name: 'Mantener despierto' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(
    group.getByRole('heading', { name: 'Mantener despierto: desactivado' }),
  ).toBeVisible();

  const display = group.getByRole('switch', { name: 'Mantener también la pantalla encendida' });
  await display.click();
  await expect(display).not.toBeChecked();

  const slider = group.getByRole('slider', { name: 'Duración' });
  await expect(slider).toHaveAttribute('aria-valuetext', '2 h');
  await slider.focus();
  await detail.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '4 h');

  await expect
    .poll(async () => writes(await app.harness.guardianCalls()))
    .toEqual([
      { on: false, durationMinutes: 120, display: true },
      { on: false, durationMinutes: 120, display: false },
      { on: false, durationMinutes: 240, display: false },
    ]);
});

test('Ajustes warns on a machine that cannot keep awake', async ({ apps }) => {
  const app = await apps.at(1);
  await app.harness.load('keep-awake-unsupported', { theme: 'dark', display: '1920x1080@100' });
  await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await settleWindow(app, 'detail');
  const group = detail.locator('[data-section="aj-despierto"]');
  await expect(group.getByText('Este equipo no permite mantenerlo despierto')).toBeVisible();
  await expectClean(detail, 'keep-awake-unsupported');
});

test('when its end passes: «Ya no se mantiene despierto», no chip, the display lets go', async ({
  apps,
}) => {
  const app = await apps.at(1);
  const main = await mainOn(app, 'idle');
  await app.harness.clickTrayItem('keep-awake:30');
  await expect(chip(main)).toHaveText('Despierto · hasta las 17:30');
  await expect.poll(() => app.harness.keepAwakeDisplay()).toBe(true);
  // Hidden, so the notification is not held back for a focused window.
  await app.harness.hideMain();
  await advanceInSteps(app, 31 * MIN, 2_500);
  await expect
    .poll(async () => (await app.harness.notifications()).map((n) => n.title))
    .toContain('Ya no se mantiene despierto');
  expect(await app.harness.keepAwakeDisplay()).toBe(false);
  expect((await app.harness.snapshot()).state?.keepAwake?.on).toBe(false);
  await expect(chip(main)).toHaveCount(0);
});
