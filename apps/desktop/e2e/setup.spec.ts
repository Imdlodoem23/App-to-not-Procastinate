/**
 * Ajustes (complete) and the onboarding (PROMPT §9 «Ajustes», «Onboarding»; §10 «Ventanas de
 * detalle › Ajustes», «Onboarding»; docs/DESKTOP.md §15):
 *
 * - `ajustes-full`: every group, each settings row 48 px, nothing clipped, axe and the keyboard
 *   audit clean in both themes and in English;
 * - weakening changes wait: a lower daily goal or penalties off go to the guardian whole
 *   (`settings:put`) and come back pending («Pasará a 30 min en 24 h», «Se aplicará en 24 h»);
 * - «Atajo global» records a combination in place (Esc stops without closing the window), the
 *   punishment level asks «¿Seguro?» before Nuclear, updates and «Exportar a CSV» answer in
 *   their rows, «Empezar de nuevo» brings the first steps back;
 * - onboarding: the five steps («Guardián · paso 2 de 5» · «No instalado»), the code at 32 px,
 *   the focus on the step's first action, «Omitir» to the app, and step 5's phrase becoming
 *   the confirmation card with Enter (and the block with the next Enter).
 */
import type { Locator, Page } from '@playwright/test';
import type { RecordedGuardianCall } from '../src/main/contracts';
import type { HarnessStateId } from '../src/shared/fixtures';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, probeLayout, settleWindow } from './support/checks';
import { auditKeyboard, auditProblems, focusInfo } from './support/keyboard';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

function callsOf(calls: RecordedGuardianCall[], method: RecordedGuardianCall['method']) {
  return calls.filter((c) => c.method === method);
}

/** The body of the last `settings:put` (the whole settings object). */
async function lastPut(launched: LaunchedApp): Promise<Record<string, unknown> | null> {
  const puts = callsOf(await launched.harness.guardianCalls(), 'updateSettings');
  return (puts.at(-1)?.body as Record<string, unknown> | undefined) ?? null;
}

async function openAjustes(
  state: HarnessStateId,
): Promise<{ launched: LaunchedApp; detail: Page; main: Page }> {
  const launched = await launchApp({ state, show: true });
  app = launched;
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(true);
  const detail = await launched.page('detail');
  const main = await launched.page('main');
  await expect(detail.locator('.aj')).toBeVisible();
  await expect(detail.locator('.aj[data-loading]')).toHaveCount(0);
  return { launched, detail, main };
}

async function expectAjustesClean(launched: LaunchedApp, page: Page, label: string) {
  await settleWindow(launched, 'detail');
  await expect(page.locator('.aj[data-loading]')).toHaveCount(0);
  // The guardian settings are there (goal tiles, punishment level).
  await expect(
    page.getByRole('radiogroup', { name: /^(Objetivo diario|Daily goal)$/ }),
  ).toBeVisible();
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.c-settings-row')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => `${row.textContent?.slice(0, 40)}: ${row.getBoundingClientRect().height}`),
  );
  expect(heights.length).toBeGreaterThan(20);
  for (const h of heights) expect(h, `${label}: settings row`).toMatch(/: 48$/);
  const violations = await axeViolations(page);
  expect(violations, `${label}\n${formatViolations(violations)}`).toEqual([]);
  const problems = auditProblems(await auditKeyboard(page));
  expect(problems, `${label}\n${problems.join('\n')}`).toEqual([]);
  // Every row fits: nothing clipped anywhere in the window (scrolled through).
  const total = await page.evaluate(
    () => document.querySelector('.detail-shell')?.scrollHeight ?? 0,
  );
  for (let y = 0; y < total; y += 300) {
    await page.evaluate((top) => document.querySelector('.detail-shell')?.scrollTo(0, top), y);
    const layout = await probeLayout(page);
    expect(layout.clipped, `${label} @${y}: ${JSON.stringify(layout.clipped)}`).toEqual([]);
  }
  // Scrolled to the end, the rows above are out of view: still named, still clean.
  const scrolled = await axeViolations(page);
  expect(scrolled, `${label} (scrolled)\n${formatViolations(scrolled)}`).toEqual([]);
}

test('Ajustes: every group in both themes and in English, 48 px rows, clean', async () => {
  test.setTimeout(90_000);
  const { launched, detail } = await openAjustes('ajustes-full');
  for (const title of [
    'General: tema del sistema',
    'Bloqueo: Normal por defecto',
    'Sistema: hay una versión nueva',
    'Datos: en este ordenador',
  ]) {
    await expect(detail.getByRole('heading', { name: title })).toBeAttached();
  }
  // No Study Mode in this wave: no group, no camera row (hidden, never greyed out).
  await expect(detail.locator('[data-section="aj-study"]')).toHaveCount(0);
  await expect(detail.locator('#aj-camera')).toHaveCount(0);
  // Pending weakening changes say when they apply; the refused shortcut says so.
  await expect(detail.locator('#aj-goal-row-desc')).toHaveText('Pasará a 45 min en 24 h');
  await expect(detail.getByText('Se desactivará en 22 h')).toBeAttached();
  await expect(detail.getByText('Otra app ya usa este atajo: elige otro')).toBeAttached();
  await expect(detail.getByRole('textbox', { name: 'Atajo: mostrar Céntrate' })).toHaveValue(
    'Ctrl+Alt+C',
  );
  await expect(detail.getByText('Intento bloqueado')).toBeAttached();
  await expect(detail.getByText('−10; si repites en 5 min, −20, −40… hasta −80')).toBeAttached();
  await expect(detail.getByRole('button', { name: 'Descargar ya' })).toBeAttached();

  for (const theme of ['light', 'dark'] as const) {
    await launched.harness.load('ajustes-full', { theme });
    await expect(detail.locator('.aj')).toBeVisible();
    // axe as the window opens: at the top (a scrolled-out row must still be named).
    await detail.evaluate(() => document.querySelector('.detail-shell')?.scrollTo(0, 0));
    await expectAjustesClean(launched, detail, `ajustes-full ${theme}`);
  }

  // English: same checks (another copy, other lengths).
  await detail.evaluate(() => document.querySelector('.detail-shell')?.scrollTo(0, 0));
  await detail.getByRole('radio', { name: 'English' }).click();
  await expect(detail.getByText('General: system theme')).toBeVisible();
  await expectAjustesClean(launched, detail, 'ajustes-full en');
  await expect(detail.locator('#aj-goal-row-desc')).toHaveText('Changes to 45 min in 24 h');
});

test('Ajustes: a lower goal and penalties off wait 24 h; a higher goal applies at once', async () => {
  const { launched, detail } = await openAjustes('ajustes');
  const goal = detail.getByRole('radiogroup', { name: 'Objetivo diario' });
  await expect(goal.getByRole('radio', { name: '60 min' })).toBeChecked();

  await goal.getByRole('radio', { name: '30 min' }).click();
  await expect.poll(async () => (await lastPut(launched))?.['dailyGoalMinutes']).toBe(30);
  // The whole settings object went (the rest unchanged).
  expect(await lastPut(launched)).toMatchObject({
    attemptPenalties: true,
    timezone: 'Europe/Madrid',
  });
  await expect(
    detail.getByText(/^Se aplicará en 24 h: los cambios que protegen menos/),
  ).toBeVisible();
  await detail.mouse.move(0, 0);
  await expect(detail.locator('#aj-goal-row-desc')).toHaveText('Pasará a 30 min en 24 h');
  // The tiles show what was asked for; 60 applies until then and cancels the wait.
  await expect(goal.getByRole('radio', { name: '30 min' })).toBeChecked();

  // Back to 60: the pending change is cancelled.
  await goal.getByRole('radio', { name: '60 min' }).click();
  await expect
    .poll(async () => callsOf(await launched.harness.guardianCalls(), 'updateSettings').length)
    .toBe(2);
  await expect(detail.locator('#aj-goal-row-desc')).not.toHaveText('Pasará a 30 min en 24 h');

  // Higher: at once.
  await goal.getByRole('radio', { name: '90 min' }).click();
  await expect(goal.getByRole('radio', { name: '90 min' })).toBeChecked();

  // Penalties off: pending («Se desactivará en 24 h»); pressing again cancels the wait.
  const penalties = detail.getByRole('switch', { name: 'Penalizaciones' });
  await expect(penalties).toHaveAttribute('aria-checked', 'true');
  await penalties.click();
  await expect.poll(async () => (await lastPut(launched))?.['attemptPenalties']).toBe(false);
  await expect(detail.locator('#aj-attemptPenalties-desc')).toHaveText('Se desactivará en 24 h');
  await expect(penalties).toHaveAttribute('aria-checked', 'false');
  await penalties.click();
  await expect.poll(async () => (await lastPut(launched))?.['attemptPenalties']).toBe(true);
  await expect(detail.locator('#aj-attemptPenalties-desc')).toHaveText(
    'Cada intento resta puntos; quitarlas tarda 24 h',
  );
  await expect(penalties).toHaveAttribute('aria-checked', 'true');
});

test('Ajustes: «Atajo global» records a combination in place', async () => {
  const { launched, detail } = await openAjustes('ajustes');
  const field = detail.getByRole('textbox', { name: 'Atajo: mini temporizador' });
  await expect(field).toHaveValue('');
  await field.click();
  await expect(field).toHaveAttribute('placeholder', 'Pulsa las teclas');
  await expect(
    detail.getByText('Pulsa la combinación · Retroceso lo quita · Esc cancela'),
  ).toBeVisible();

  // A plain letter is not a global shortcut.
  await detail.keyboard.press('m');
  await expect(detail.getByText('Usa Ctrl o Alt con una tecla')).toBeVisible();

  await detail.keyboard.press('Control+Alt+M');
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.shortcuts['toggle-mini-timer'])
    .toBe('CommandOrControl+Alt+M');
  await expect(field).toHaveValue('Ctrl+Alt+M');

  // The same combination for another action is refused.
  const extend = detail.getByRole('textbox', { name: 'Atajo: ampliar 15 min' });
  await extend.click();
  await detail.keyboard.press('Control+Alt+M');
  await expect(detail.getByText('Ya lo usa «Atajo: mini temporizador»')).toBeVisible();

  // Esc stops recording and does not close the window; Enter records again; Backspace removes.
  await detail.keyboard.press('Escape');
  await expect(extend).toHaveAttribute('placeholder', 'Sin atajo');
  expect((await launched.harness.bounds()).detail?.visible).toBe(true);
  await field.focus();
  await detail.keyboard.press('Escape');
  await detail.keyboard.press('Enter');
  await detail.keyboard.press('Backspace');
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.shortcuts['toggle-mini-timer'])
    .toBeNull();
});

/** Presses a tile until it shows «¿Seguro? …» (a focus change elsewhere disarms it). */
async function arm(tile: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tile.click();
    const armed = await expect(tile)
      .toHaveText(/^¿Seguro\?/, { timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (armed) return;
  }
  await expect(tile).toHaveText(/^¿Seguro\?/);
}

test('Ajustes: the punishment level asks «¿Seguro?» before Nuclear', async () => {
  const { launched, detail } = await openAjustes('ajustes');
  // The level lives in the Study Mode group, which only exists with its flag.
  test.skip(
    !(await launched.harness.snapshot()).features.study,
    'Study Mode flag off: no punishment level in this wave',
  );
  const levels = detail.getByRole('radiogroup', { name: 'Nivel de castigo' });
  await expect(levels.getByRole('radio', { name: '1 · Distracciones' })).toBeChecked();
  await expect(detail.locator('#aj-punishment-help')).toHaveText(
    'Nivel 1: se bloquean todas las webs y apps que distraen',
  );

  const nuclear = levels.getByRole('radio', { name: /Nuclear$/ });
  await arm(nuclear);
  await expect(detail.locator('#aj-punishment-help')).toHaveText(
    'En un castigo no podrás usar el ordenador, salvo la salida de emergencia',
  );
  expect(callsOf(await launched.harness.guardianCalls(), 'updateSettings')).toHaveLength(0);
  await nuclear.click();
  await expect
    .poll(async () => (await lastPut(launched))?.['punishment'])
    .toEqual({ level: 'nuclear', minutes: 60 });
  await expect(levels.getByRole('radio', { name: 'Nuclear' })).toBeChecked();
  await expect(detail.getByText(/ningún bloqueo es 100 % imposible de saltar/)).toBeVisible();

  // Level 2 applies at once (punishment changes never wait).
  await levels.getByRole('radio', { name: '2 · Lista blanca' }).click();
  await expect
    .poll(async () => (await lastPut(launched))?.['punishment'])
    .toEqual({ level: 'whitelist', minutes: 60 });
});

test('Ajustes: updates, CSV export and the first steps again', async () => {
  const { launched, detail, main } = await openAjustes('ajustes-full');
  await detail.getByRole('button', { name: 'Descargar ya' }).click();
  await expect(detail.getByRole('button', { name: 'Reiniciar y actualizar' })).toBeVisible();

  await detail.getByRole('button', { name: /^Exportar eventos/ }).click();
  await expect(
    detail.getByText(/^Guardado: centrate-eventos-\d{4}-\d\d-\d\d\.csv \(\d+ filas\)$/),
  ).toBeVisible();

  await detail.getByRole('button', { name: 'Empezar de nuevo' }).click();
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.onboarding.done)
    .toBe(false);
  await expect(main.getByRole('heading', { name: 'Bienvenida · paso 1 de 5' })).toBeVisible();
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(false);
});

// ---------------------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------------------

async function onboarding(state: HarnessStateId): Promise<{ launched: LaunchedApp; main: Page }> {
  const launched = await launchApp({ state, show: true });
  app = launched;
  const main = await launched.page('main');
  await expect(main.locator('.ob')).toBeVisible();
  await settleWindow(launched, 'main');
  return { launched, main };
}

test('onboarding: five steps, each clean, in both themes', async () => {
  test.setTimeout(90_000);
  const { launched, main } = await onboarding('onboarding-1');
  const titles = [
    ['onboarding-1', 'Bienvenida · paso 1 de 5', 'Unos 2 minutos'],
    ['onboarding-2', 'Guardián · paso 2 de 5', 'No instalado'],
    ['onboarding-3', 'Extensión · paso 3 de 5', 'Sin conectar'],
    ['onboarding-4', 'Cámara · paso 4 de 5', 'Llega con el Study Mode'],
    ['onboarding-5', 'Primer bloqueo · paso 5 de 5', 'Listo para crear'],
  ] as const;
  for (const theme of ['light', 'dark'] as const) {
    for (const [state, title, status] of titles) {
      await launched.harness.load(state, { theme });
      await expect(main.getByRole('heading', { name: title })).toBeVisible();
      await expect(main.locator('.ob .c-section-datum')).toHaveText(status);
      await settleWindow(launched, 'main');
      const violations = await axeViolations(main);
      expect(violations, `${state} ${theme}\n${formatViolations(violations)}`).toEqual([]);
      const problems = auditProblems(await auditKeyboard(main));
      expect(problems, `${state} ${theme}\n${problems.join('\n')}`).toEqual([]);
      const layout = await probeLayout(main);
      expect(layout.clipped, `${state} ${theme}`).toEqual([]);
      const column = layout.column;
      expect(column, `${state} ${theme}`).not.toBeNull();
      expect(column?.scrollHeight ?? 0, `${state} ${theme}`).toBeLessThanOrEqual(
        column?.clientHeight ?? 0,
      );
    }
  }
  // In English (Ajustes › Idioma; a load goes back to the fixture's language): nothing clipped.
  for (const [state, title] of [
    ['onboarding-1', 'Welcome · step 1 of 5'],
    ['onboarding-2', 'Guardian · step 2 of 5'],
    ['onboarding-3', 'Extension · step 3 of 5'],
    ['onboarding-4', 'Camera · step 4 of 5'],
    ['onboarding-5', 'First block · step 5 of 5'],
  ] as const) {
    await launched.harness.load(state, { theme: 'light' });
    await launched.harness.openDetail('ajustes');
    const detail = await launched.page('detail');
    await detail.getByRole('radio', { name: 'English' }).click();
    await expect(main.getByRole('heading', { name: title })).toBeVisible();
    await settleWindow(launched, 'main');
    const layout = await probeLayout(main);
    expect(layout.clipped, `${state} en`).toEqual([]);
    const problems = auditProblems(await auditKeyboard(main));
    expect(problems, `${state} en\n${problems.join('\n')}`).toEqual([]);
  }

  // Step 3: the code at 32 px.
  await launched.harness.load('onboarding-3', { theme: 'light' });
  const code = main.locator('.ob-code');
  await expect(code).toContainText('482913');
  expect(await code.evaluate((el) => getComputedStyle(el).fontSize)).toBe('32px');
});

test('onboarding: the focus goes to the step’s first action; «Empezar» and «Omitir»', async () => {
  const { launched, main } = await onboarding('onboarding-2');
  await launched.harness.hideMain();
  await launched.harness.showMain();
  await expect.poll(async () => (await focusInfo(main)).name).toBe('Instalar');

  await launched.harness.load('onboarding-1');
  await main.getByRole('button', { name: 'Empezar' }).click();
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.onboarding.step)
    .toBe('guardian');
  await expect(main.getByRole('heading', { name: 'Guardián · paso 2 de 5' })).toBeVisible();

  // The guardian answers in this fixture: nothing to install.
  await expect(main.getByRole('button', { name: 'Continuar' })).toBeVisible();

  // «Instalar»: the same elevation as «Reparar» (the fixture's installer says «installed»).
  await launched.harness.load('onboarding-2');
  await main.getByRole('button', { name: 'Instalar', exact: true }).click();
  await expect(main.getByText('Instalado: esperando a que responda…')).toBeVisible();

  // «Omitir» on the welcome step goes straight to the app.
  await launched.harness.load('onboarding-1');
  await main.keyboard.press('Alt+o');
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.onboarding.done)
    .toBe(true);
  await expect(main.getByRole('heading', { name: /^Bloqueo: ninguno/ })).toBeVisible();
});

test('onboarding: step 5 leaves the first block typed; Enter, Enter creates it', async () => {
  const { launched, main } = await onboarding('onboarding-5');
  const field = main.getByRole('textbox', { name: '¿Qué quieres hacer?' });
  await expect(field).toHaveValue('no veo YouTube en 25 minutos');
  await field.focus();
  await main.keyboard.press('Enter');
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.onboarding.done)
    .toBe(true);
  const confirm = main.getByRole('button', { name: /^Bloquear hasta/ });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  await main.keyboard.press('Enter');
  await expect
    .poll(async () => callsOf(await launched.harness.guardianCalls(), 'createBlock').length)
    .toBe(1);
  const created = callsOf(await launched.harness.guardianCalls(), 'createBlock')[0]?.body as {
    targets?: { serviceIds?: string[] };
    durationMinutes?: number;
  };
  expect(created.targets?.serviceIds).toEqual(['youtube']);
  expect(created.durationMinutes).toBe(25);
});

test('onboarding: a new step takes the focus; Enter walks from step 4 to the card', async () => {
  const { launched, main } = await onboarding('onboarding-4');
  // Step 4 before Study Mode: one action, nothing greyed out.
  await expect(main.getByRole('button', { name: 'Probar cámara' })).toHaveCount(0);
  await expect(main.locator('.ob [aria-disabled="true"]')).toHaveCount(0);
  await launched.harness.hideMain();
  await launched.harness.showMain();
  await expect.poll(async () => (await focusInfo(main)).name).toBe('Continuar');

  // Enter on «Continuar»: step 5, with the keyboard on the typed phrase (not on a stale tile).
  await main.keyboard.press('Enter');
  await expect(main.getByRole('heading', { name: 'Primer bloqueo · paso 5 de 5' })).toBeVisible();
  const field = main.getByRole('textbox', { name: '¿Qué quieres hacer?' });
  await expect(field).toBeFocused();
  // Screen readers hear the new step once; the row's resting help is not repeated.
  await expect(main.getByTestId('ob-announcer')).toHaveText(
    'Primer bloqueo · paso 5 de 5. Te dejamos escrito tu primer bloqueo: Enter para revisarlo y otra vez Enter para empezar.',
  );
  const help = 'Revisa el bloqueo y confírmalo con Enter';
  const count = await main
    .locator('.ob')
    .evaluate((el, text) => (el.textContent ?? '').split(text).length - 1, help);
  expect(count).toBe(1);

  // Enter: the confirmation card, focus on its button; Enter again creates the block.
  await main.keyboard.press('Enter');
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.onboarding.done)
    .toBe(true);
  const confirm = main.getByRole('button', { name: /^Bloquear hasta/ });
  await expect(confirm).toBeFocused();
  await main.keyboard.press('Enter');
  await expect
    .poll(async () => callsOf(await launched.harness.guardianCalls(), 'createBlock').length)
    .toBe(1);
});

test('onboarding: «Empezar» moves the focus to step 2 and speaks it once', async () => {
  const { launched, main } = await onboarding('onboarding-1');
  await launched.harness.hideMain();
  await launched.harness.showMain();
  await expect.poll(async () => (await focusInfo(main)).name).toBe('Empezar');
  await main.keyboard.press('Enter');
  await expect(main.getByRole('heading', { name: 'Guardián · paso 2 de 5' })).toBeVisible();
  await expect.poll(async () => (await focusInfo(main)).name).not.toBe('Empezar');
  const focused = await focusInfo(main);
  expect(['Instalar', 'Reparar', 'Continuar']).toContain(focused.name);
  await expect(main.getByTestId('ob-announcer')).toHaveText(/^Guardián · paso 2 de 5\. /);
  // Every help of the step appears once in reading order (no resting copy in a live region).
  const texts = await main.locator('.ob').evaluate((el) => el.textContent ?? '');
  for (const help of ['Pide permiso de administrador una sola vez', 'Al siguiente paso']) {
    expect(texts.split(help).length - 1, help).toBeLessThanOrEqual(1);
  }
});
