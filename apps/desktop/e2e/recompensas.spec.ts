/**
 * Recompensas, Logros and the Progreso doors (PROMPT §7, §10 «Progreso», «Ventanas de detalle ›
 * Recompensas / Logros»; docs/DESKTOP.md §15):
 *
 * - Progreso: the mascot glyph as the header icon, the three 40 px doors with their Alt +
 *   letters, none clipped, each opening its detail view (click and Alt + letter);
 * - `rewards`: «Recompensas: 1.240 puntos», the mascot in large, the shop rows «15 min de
 *   YouTube · 150 pts · Canjear»; «Canjear» confirms in place («¿Seguro? Canjear» with the
 *   consequence in red) and the second press redeems through the guardian once, with its
 *   `Idempotency-Key`; axe and the keyboard audit clean in both themes and in English;
 * - `rewards-short-points`: «Canjear» disabled with «Te faltan 40 puntos» on the help line;
 * - `logros`: «Logros: 3 de 8», the 4-column grid (reached ones selected in green), the help
 *   line «… · 12 de 30», names on two lines at most; axe and the keyboard audit clean.
 */
import type { Locator, Page } from '@playwright/test';
import type { HarnessStateId } from '../src/shared/fixtures';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, probeLayout, settleWindow } from './support/checks';
import { auditKeyboard, auditProblems, liveEvents, watchLiveRegions } from './support/keyboard';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

const SURE = /^¿Seguro\?/;

/**
 * Arms an in-place «¿Seguro?». Another app taking the OS focus (parallel workers share one X
 * display) blurs the button, which disarms it by design: arm again then, as a user would.
 */
async function armInPlace(button: Locator, help?: { line: Locator; text: string }): Promise<void> {
  const shows = async (): Promise<boolean> => {
    if (!SURE.test((await button.textContent()) ?? '')) return false;
    if (!help) return true;
    const [text, tone] = await Promise.all([
      help.line.textContent(),
      help.line.getAttribute('data-tone'),
    ]);
    return text === help.text && tone === 'red';
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!SURE.test((await button.textContent()) ?? '')) await button.click();
    const armed = await expect
      .poll(shows, { timeout: 1_000 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (armed) return;
  }
  await expect(button).toHaveText(SURE);
  if (help) {
    await expect(help.line).toHaveText(help.text);
    await expect(help.line).toHaveAttribute('data-tone', 'red');
  }
}

/** The second press; re-armed first when a focus change disarmed it meanwhile. */
async function confirmInPlace(button: Locator, done: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await armInPlace(button);
    await button.click();
    const ok = await expect(done)
      .toBeVisible({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
}

test.afterEach(async () => {
  await app?.close();
  app = null;
});

async function detailWindow(
  state: HarnessStateId,
  root: '.rwd' | '.lgr',
): Promise<{ launched: LaunchedApp; detail: Page }> {
  const launched = await launchApp({ state, show: true });
  app = launched;
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(true);
  const detail = await launched.page('detail');
  await expect(detail.locator(root)).toBeVisible();
  await expect(detail.locator(`${root}[data-loading]`)).toHaveCount(0);
  return { launched, detail };
}

async function expectClean(launched: LaunchedApp, page: Page, root: string): Promise<void> {
  await settleWindow(launched, 'detail');
  await expect(page.locator(`${root}[data-loading]`)).toHaveCount(0);
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
  const problems = auditProblems(await auditKeyboard(page));
  expect(problems, problems.join('\n')).toEqual([]);
  const layout = await probeLayout(page);
  expect(layout.clipped, JSON.stringify(layout.clipped)).toEqual([]);
}

test('Progreso: mascot icon and three 40 px doors that fit and open their windows', async () => {
  const launched = await launchApp({ state: 'idle', show: true });
  app = launched;
  const main = await launched.page('main');
  const section = main.locator('[data-section="progreso"]');
  await expect(section.getByRole('heading', { name: 'Nivel 7 · 1.240 puntos' })).toBeVisible();
  // The header icon is the mascot in its phase (42 of 60 min: a plant).
  await expect(section.locator('.c-section-icon [data-glyph="mascot:plant"]')).toHaveCount(1);

  const doors = section.getByRole('group', { name: 'Tu progreso' }).getByRole('button');
  await expect(doors).toHaveText(['Estadísticas…', 'Recompensas…', 'Logros…']);
  await expect(doors.nth(0)).toHaveAttribute('aria-keyshortcuts', 'Alt+C');
  await expect(doors.nth(1)).toHaveAttribute('aria-keyshortcuts', 'Alt+W');
  await expect(doors.nth(2)).toHaveAttribute('aria-keyshortcuts', 'Alt+G');
  for (const i of [0, 1, 2]) {
    const box = await doors.nth(i).boundingBox();
    expect(Math.round(box?.height ?? 0)).toBe(40);
  }
  // No door label is cut (the footer's labels are SURFACES').
  const cut = await section
    .locator('.c-tile-label')
    .evaluateAll((labels) =>
      labels
        .filter((l) => l.scrollWidth > l.clientWidth + 1)
        .map((l) => `${l.textContent}: ${l.scrollWidth} > ${l.clientWidth}`),
    );
  expect(cut).toEqual([]);

  // The help line says what is behind each door.
  await doors.nth(2).hover();
  await expect(section.locator('#progreso-puertas-help')).toHaveText(
    '3 de 8 conseguidos: mira cómo lograr el resto',
  );

  await doors.nth(1).click();
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(true);
  const detail = await launched.page('detail');
  await expect(detail.locator('.rwd')).toBeVisible();

  await main.bringToFront();
  await main.locator('body').focus();
  await main.keyboard.press('Alt+g');
  await expect(detail.locator('.lgr')).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Logros: 3 de 8' })).toBeVisible();
});

test('Progreso: «Números rojos» in red with the wilted mascot', async () => {
  const launched = await launchApp({ state: 'negative-points', show: true });
  app = launched;
  const main = await launched.page('main');
  const section = main.locator('[data-section="progreso"]');
  await expect(section.getByRole('heading', { name: 'Nivel 3 · −340 puntos' })).toHaveAttribute(
    'data-tone',
    'red',
  );
  await expect(section.getByText('Números rojos')).toBeVisible();
  await expect(section.locator('[data-glyph="mascot:wilted"]')).toHaveCount(1);
});

test('rewards: the shop in rows, the mascot, and «Canjear» confirmed in place', async () => {
  const { launched, detail } = await detailWindow('rewards', '.rwd');
  const shop = detail.locator('[data-section="rwd-shop"]');
  await expect(shop.getByRole('heading', { name: 'Recompensas: 1.240 puntos' })).toBeVisible();
  await expect(detail.locator('.rwd-mascot .c-mascot[data-mascot="plant"]')).toBeVisible();
  await expect(detail.locator('.rwd-mascot')).toContainText('18 min más hoy y será un árbol');

  const rows = detail.locator('.rwd-offer');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('15 min de YouTube');
  await expect(rows.nth(0)).toContainText('150 pts');
  const redeem = rows.nth(0).getByRole('button', { name: 'Canjear' });
  await expect(redeem).toBeFocused();
  await expect(redeem).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
  await expect(
    detail.getByText(/^TikTok, Twitch, Netflix, Discord y Roblox no están/),
  ).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    await launched.harness.load('rewards', { theme });
    await expect(detail.locator('.rwd-offer')).toHaveCount(3);
    await expectClean(launched, detail, '.rwd');
  }

  // First press: «¿Seguro? Canjear», the consequence in red; nothing is sent yet.
  await watchLiveRegions(detail);
  const help = detail.locator('#rewards-help');
  const button = detail.locator('.rwd-offer').nth(0).locator('.c-tile');
  await detail.bringToFront();
  // The consequence in red on the help line while armed.
  await armInPlace(button, { line: help, text: '−150 puntos: YouTube abierto hasta las 17:15' });
  expect(
    (await launched.harness.guardianCalls()).filter((c) => c.method === 'redeemReward'),
  ).toEqual([]);

  // Second press within 3 s: redeemed once, with its key; the outcome on its own line (the
  // help line stays the help of the «Canjear» under the pointer) and said by the window.
  const result = detail.locator('#rwd-result');
  await confirmInPlace(button, result);
  await expect(result).toHaveText(
    'Canjeado: YouTube abierto hasta las 17:15 · te quedan 1.090 puntos',
  );
  await expect(result).toHaveAttribute('data-tone', 'green');
  await expect(detail.locator('[data-announcer]')).toHaveText(
    'Canjeado: YouTube abierto hasta las 17:15 · te quedan 1.090 puntos',
  );
  await expect(
    detail.locator('[data-section="rwd-shop"]').getByRole('heading', {
      name: 'Recompensas: 1.090 puntos',
    }),
  ).toBeVisible();
  await expect(detail.locator('[data-section="rwd-shop"] .c-section-datum')).toHaveText(
    'YouTube hasta las 17:15',
  );
  const calls = (await launched.harness.guardianCalls()).filter((c) => c.method === 'redeemReward');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.idempotencyKey).toBeTruthy();
  expect(calls[0]?.body).toEqual({ offerId: 'youtube-15' });
  // Every live region was there, empty, before it spoke.
  expect(await liveEvents(detail)).toEqual([]);

  // English.
  await launched.harness.load('rewards', { lang: 'en' });
  await expect(detail.getByRole('heading', { name: 'Rewards: 1,240 points' })).toBeVisible();
  await expect(detail.locator('.rwd-offer').nth(0)).toContainText('15 min of YouTube');
  await expectClean(launched, detail, '.rwd');
});

test('rewards-short-points: «Canjear» disabled with «Te faltan 40 puntos»', async () => {
  const { launched, detail } = await detailWindow('rewards-short-points', '.rwd');
  const first = detail.locator('.rwd-offer').nth(0).locator('.c-tile');
  await expect(first).toHaveAttribute('aria-disabled', 'true');
  await expect(first).toBeFocused();
  await expect(detail.locator('#rewards-help')).toHaveText('Te faltan 40 puntos');
  await first.click({ force: true });
  await expect(first).toHaveText('Canjear');
  expect(
    (await launched.harness.guardianCalls()).filter((c) => c.method === 'redeemReward'),
  ).toEqual([]);
  await expectClean(launched, detail, '.rwd');
});

test('rewards during a punishment: the shop is closed and says why', async () => {
  const launched = await launchApp({ state: 'punishment', show: true });
  app = launched;
  await launched.harness.openDetail('recompensas');
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(true);
  const detail = await launched.page('detail');
  await expect(detail.locator('.rwd[data-loading]')).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: 'Recompensas: cerradas' })).toBeVisible();
  await expect(detail.locator('#rewards-help')).toHaveText('Durante un castigo no se canjea nada');
  const buttons = detail.locator('.rwd-offer .c-tile');
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const b of await buttons.all()) await expect(b).toHaveAttribute('aria-disabled', 'true');
  await expectClean(launched, detail, '.rwd');
});

test('logros: 3 of 8 in a 4-column grid, the help line says how to get them', async () => {
  const { launched, detail } = await detailWindow('logros', '.lgr');
  await expect(detail.getByRole('heading', { name: 'Logros: 3 de 8' })).toBeVisible();
  await expect(detail.locator('[data-section="lgr-grid"] .c-section-datum')).toHaveText(
    'Último: Una semana sin intentos',
  );
  const tiles = detail.getByRole('group', { name: 'Tus logros' }).getByRole('button');
  await expect(tiles).toHaveCount(8);
  await expect(detail.locator('.lgr-tile[aria-pressed="true"]')).toHaveCount(3);
  await expect(detail.locator('.lgr-tile[aria-pressed="true"][data-accent="green"]')).toHaveCount(
    3,
  );

  // The fixture's help focus: «30 días de racha», focused, «… · 12 de 30».
  const streak = detail.locator('[data-tile-id="streak-30"]');
  await expect(streak).toBeFocused();
  const help = detail.locator('#logros-help');
  await expect(help).toHaveText('Cumple tu objetivo diario 30 días seguidos · 12 de 30');
  await detail.locator('[data-tile-id="clean-week"]').hover();
  await expect(help).toHaveText('Conseguido el 24 de septiembre');
  await detail.mouse.move(1, 1);

  // Four columns: the first four tiles share a row, the fifth starts the next.
  const tops = await Promise.all(
    [0, 3, 4].map(async (i) => Math.round((await tiles.nth(i).boundingBox())?.y ?? -1)),
  );
  expect(tops[0]).toBe(tops[1]);
  expect(tops[2]).toBeGreaterThan(tops[0] ?? 0);

  // Alt + key focuses a tile (its help shows).
  await detail.keyboard.press('Alt+u');
  await expect(detail.locator('[data-tile-id="clean-week"]')).toBeFocused();

  for (const theme of ['light', 'dark'] as const) {
    await launched.harness.load('logros', { theme });
    await expect(tiles).toHaveCount(8);
    await expectClean(launched, detail, '.lgr');
  }

  await launched.harness.load('logros', { lang: 'en' });
  await expect(detail.getByRole('heading', { name: 'Achievements: 3 of 8' })).toBeVisible();
  await detail.locator('[data-tile-id="streak-30"]').focus();
  await expect(detail.locator('#logros-help')).toHaveText(
    'Meet your daily goal 30 days in a row · 12 of 30',
  );
  await expectClean(launched, detail, '.lgr');
});
