/**
 * Daily limits («YouTube máximo 30 minutos al día»; ARCHITECTURE §5.10) against the fake
 * guardian:
 *
 * - main window: the phrase + Enter opens the «Límite diario» card (axe and the keyboard audit
 *   clean), Enter creates it with one `Idempotency-Key`, the card closes and the field says
 *   «Límite creado…»; Hardcore asks first; a limit block's header;
 * - Bloqueos › «Límites diarios» (`limits`): rows with today's use, «Bloqueado hasta mañana»
 *   and the pending change; accessible in both themes and in English; «Nuevo límite» opens the
 *   editor in place, «Guardar» creates it and the focus goes back; Esc closes the editor;
 *   «Cancelar cambio» re-sends the effective definition; a softening edit says it waits 24 h.
 */
import type { Page } from '@playwright/test';
import type { RecordedGuardianCall } from '../src/main/contracts';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, settleWindow, visibleText } from './support/checks';
import { auditKeyboard, auditProblems } from './support/keyboard';
import { expect, test } from './support/test';

const FIELD = '¿Qué quieres hacer?';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

function callsOf(calls: RecordedGuardianCall[], method: RecordedGuardianCall['method']) {
  return calls.filter((c) => c.method === method);
}

async function expectClean(page: Page, label: string): Promise<void> {
  const violations = await axeViolations(page);
  expect(violations, `${label}: ${formatViolations(violations)}`).toEqual([]);
  const problems = auditProblems(await auditKeyboard(page));
  expect(problems, `${label}:\n${problems.join('\n')}`).toEqual([]);
}

async function bloqueosWindow(
  state: 'limits' | 'limit-editor' | 'limits-unsupported',
): Promise<Page> {
  app = await launchApp({ state, show: true });
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await expect(detail.locator('.blq')).toBeVisible();
  await expect(detail.locator('.blq[data-loading]')).toHaveCount(0);
  return detail;
}

function section(detail: Page) {
  return detail.locator('[data-section="blq-limits"]');
}

test('limit-confirm: phrase + Enter + Enter creates the limit with one key', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await field.fill('YouTube máximo 30 minutos al día');
  await expect(visibleText(main, '30 min al día')).toBeVisible();
  await field.press('Enter');

  const confirm = main.getByRole('button', { name: /^Crear límite: 30 min al día/ });
  await expect(confirm).toBeFocused();
  await expect(main.locator('[data-limit-card]')).toBeVisible();
  expect(callsOf(await app.harness.guardianCalls(), 'createLimit')).toHaveLength(0);

  await main.keyboard.press('Enter');
  await expect(main.locator('[data-limit-card]')).toHaveCount(0);
  await expect(visibleText(main, 'Límite creado: YouTube, 30 min al día')).toBeVisible();
  await expect(main.getByRole('textbox', { name: FIELD })).toHaveValue('');
  const creates = callsOf(await app.harness.guardianCalls(), 'createLimit');
  expect(creates).toHaveLength(1);
  expect(creates[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{8,}$/);
  expect(creates[0]?.body).toMatchObject({
    name: 'YouTube',
    dailyMinutes: 30,
    days: [1, 2, 3, 4, 5, 6, 7],
    mode: 'strict',
    targets: { serviceIds: ['youtube'] },
    acknowledgeNoEmergency: false,
  });
});

test('limit-confirm: accessible in both themes and in English; Hardcore asks; Esc closes', async () => {
  app = await launchApp({ state: 'limit-confirm', show: true });
  const main = await app.page('main');
  const card = main.locator('[data-limit-card]');
  await expect(card).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await app.harness.load('limit-confirm', { theme });
    await settleWindow(app, 'main');
    await expect(card).toBeVisible();
    await expectClean(main, theme);
  }
  await app.harness.load('limit-confirm', { lang: 'en' });
  await expect(main.getByRole('button', { name: /^Create limit: 30 min a day/ })).toBeVisible();
  await expectClean(main, 'en');
  await app.harness.load('limit-confirm', { lang: 'es' });

  await card.getByRole('radio', { name: 'Hardcore' }).click();
  await card.getByRole('button', { name: /^Crear límite/ }).click();
  await expect(
    visibleText(main, 'Cuando se agote, no podrás desbloquearlo de ninguna forma hasta medianoche'),
  ).toBeVisible();
  const again = card.getByRole('button', { name: /^Sí, crear el límite/ });
  await expect(again).toBeDisabled();
  await app.harness.advance(2_100);
  await again.click();
  await expect(card).toHaveCount(0);
  const [create] = callsOf(await app.harness.guardianCalls(), 'createLimit');
  expect(create?.body).toMatchObject({ mode: 'hardcore', acknowledgeNoEmergency: true });

  // A new card, then Esc: closed, the field keeps the phrase.
  const field = main.getByRole('textbox', { name: FIELD });
  await field.fill('limita Instagram a 1 h al día');
  await field.press('Enter');
  await expect(card).toBeVisible();
  await main.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(field).toHaveValue('limita Instagram a 1 h al día');
});

test('limit-block: the header names the limit and when it ends', async () => {
  app = await launchApp({ state: 'limit-block', show: true });
  const main = await app.page('main');
  await expect(
    main.getByRole('heading', { name: /^Límite (diario )?(de Redes sociales|): / }),
  ).toBeVisible();
  await expect(main.getByRole('heading', { name: /hasta las 00:00$/ })).toBeVisible();
  await expectClean(main, 'limit-block');
});

test('limits-unsupported: the section says why, focused and described, in both languages', async () => {
  const detail = await bloqueosWindow('limits-unsupported');
  const note = 'Tu guardián aún no tiene límites diarios: actualiza Céntrate';
  await expect(section(detail).getByText(note)).toBeVisible();
  await expect(section(detail)).toBeFocused();
  await expect(section(detail)).toHaveAccessibleDescription(note);
  await expect(detail.locator('[data-announcer]')).toHaveText(note);
  await expect(section(detail).getByRole('list')).toHaveCount(0);
  await expect(detail.locator('[data-tile-id="blq-new-limit"]')).toHaveCount(0);
  await expectClean(detail, 'limits-unsupported');
  await app?.harness.load('limits-unsupported', { lang: 'en' });
  await expect(
    section(detail).getByText('Your guardian has no daily limits yet: update Céntrate'),
  ).toBeVisible();
  await expectClean(detail, 'limits-unsupported en');
});

test('limits: rows, accessible in both themes and in English', async () => {
  const detail = await bloqueosWindow('limits');
  await expect(section(detail).getByRole('heading', { level: 2 })).toHaveText('Límites diarios: 3');
  await expect(section(detail).getByText('12 de 30 min hoy', { exact: false })).toBeVisible();
  await expect(section(detail).getByText('Bloqueado hasta mañana', { exact: false })).toBeVisible();
  await expect(
    section(detail).getByText('Cambio pendiente: 1 h al día desde mañana 16:00'),
  ).toBeVisible();
  await expect(
    section(detail).getByRole('progressbar', { name: 'Uso de hoy de YouTube' }),
  ).toHaveAttribute('aria-valuetext', '12 de 30 min hoy');
  for (const theme of ['light', 'dark'] as const) {
    await app?.harness.load('limits', { theme });
    if (app) await settleWindow(app, 'detail');
    await expectClean(detail, theme);
  }
  await app?.harness.load('limits', { lang: 'en' });
  await expect(section(detail).getByRole('heading', { level: 2 })).toHaveText('Daily limits: 3');
  await expectClean(detail, 'en');
});

test('limits: «Nuevo límite» in place, saved with one key; Esc closes the editor', async () => {
  const detail = await bloqueosWindow('limits');
  const newLimit = section(detail).getByRole('button', { name: /^Nuevo límite/ });
  await newLimit.click();
  const editor = section(detail).locator('[data-limit-editor]');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox', { name: /^Nombre del límite/ })).toBeFocused();
  await detail.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(newLimit).toBeFocused();
  // The window is still open: Esc closed the editor, not the window.
  expect((await app?.harness.bounds())?.detail?.visible).toBe(true);

  await newLimit.click();
  await editor.getByRole('checkbox', { name: 'Juegos' }).check();
  const minutes = editor.getByRole('textbox', { name: 'Minutos al día' });
  await minutes.fill('1h30');
  await expect(editor.getByText('1 h 30 min al día', { exact: true })).toBeVisible();
  await editor.getByRole('checkbox', { name: 'domingo' }).uncheck();
  await editor.getByRole('button', { name: /^Guardar/ }).click();
  await expect(editor).toHaveCount(0);
  await expect(section(detail).getByText('Guardado: Juegos · 1 h 30 min al día')).toBeVisible();
  await expect(
    section(detail).getByText('Juegos · 1 h 30 min al día', { exact: true }),
  ).toBeVisible();
  await expect(newLimit).toBeFocused();
  const creates = callsOf((await app?.harness.guardianCalls()) ?? [], 'createLimit');
  expect(creates).toHaveLength(1);
  expect(creates[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{8,}$/);
  expect(creates[0]?.body).toMatchObject({
    name: 'Juegos',
    dailyMinutes: 90,
    days: [1, 2, 3, 4, 5, 6],
    targets: { categoryIds: ['games'] },
    mode: 'strict',
  });
});

test('limits: «Cancelar cambio» and a softening edit that waits 24 h', async () => {
  const detail = await bloqueosWindow('limits');
  const cancel = section(detail).getByRole('button', { name: /^Cancelar cambio/ });
  await cancel.click();
  await expect(section(detail).getByText('Cambio cancelado: TikTok')).toBeVisible();
  await expect(section(detail).getByText(/^Cambio pendiente/)).toHaveCount(0);
  const updates = callsOf((await app?.harness.guardianCalls()) ?? [], 'updateLimit');
  expect(updates).toHaveLength(1);
  expect(JSON.stringify(updates[0]?.body)).toContain('"dailyMinutes":45');

  // YouTube: 30 → 45 min softens it: said before saving, then pending on the row.
  await section(detail)
    .getByRole('button', { name: /^Editar/ })
    .first()
    .click();
  const editor = section(detail).locator('[data-limit-editor]');
  await editor.getByRole('textbox', { name: 'Minutos al día' }).fill('45');
  await expect(
    editor.getByText('Esto lo suaviza: se aplicará mañana 17:00 (lo que lo endurece, ya)'),
  ).toBeVisible();
  await editor.getByRole('button', { name: /^Guardar/ }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    section(detail).getByText('Cambio pendiente: 45 min al día desde mañana 17:00'),
  ).toBeVisible();
  // The row still shows today's allowance: nothing softened at once.
  await expect(section(detail).getByText('YouTube · 30 min al día', { exact: true })).toBeVisible();
});
