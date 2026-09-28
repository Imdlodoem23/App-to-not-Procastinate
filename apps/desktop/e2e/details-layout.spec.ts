/**
 * Detail windows layout rules that are easy to regress (PROMPT §10 «Ventanas de detalle»):
 *
 * - Ajustes: every settings row is exactly 48 px, also after typing BORRAR swaps the
 *   description of «Borrar todos mis datos» (nothing jumps).
 * - Bloqueos: while naming a template the pinned bar is taller; Shift+Tab through the form never
 *   leaves the focused control under it (WCAG 2.4.11), and «Tu motivo» stays described by a
 *   help line that exists.
 */
import { launchApp, type LaunchedApp } from './support/app';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

test('Ajustes: settings rows stay 48 px after typing BORRAR', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  await main.getByRole('button', { name: /^Ajustes/ }).click();
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await detail.getByRole('textbox', { name: /BORRAR/ }).fill('BORRAR');
  await expect(detail.getByRole('button', { name: /^Borrar$/ })).toBeEnabled();
  const heights = await detail.evaluate(() =>
    [...document.querySelectorAll('.c-settings-row')]
      .filter((row) => row.getClientRects().length > 0)
      .map((row) => row.getBoundingClientRect().height),
  );
  expect(heights.length).toBeGreaterThan(0);
  for (const height of heights) expect(height).toBe(48);
});

test('Bloqueos: while naming a template, Shift+Tab never leaves the focus under the pinned bar', async () => {
  app = await launchApp({ state: 'bloqueos-prefilled', show: true });
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  // The seeded phrase named what to block, not for how long: pick the first duration preset.
  await detail.locator('.blq-how [data-row-tile]').first().click();
  await detail.getByRole('button', { name: /^Guardar como plantilla/ }).click();
  await expect(detail.getByRole('textbox', { name: /^Nombre de la plantilla/ })).toBeFocused();

  const reason = detail.getByRole('textbox', { name: /^Tu motivo/ });
  const described = (await reason.getAttribute('aria-describedby')) ?? '';
  const ids = described.split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) await expect(detail.locator(`[id="${id}"]`)).toHaveCount(1);

  let checked = 0;
  for (let step = 0; step < 8; step += 1) {
    await detail.keyboard.press('Shift+Tab');
    const overlap = await detail.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const el = document.activeElement;
      const bar = document.querySelector('.blq-actions');
      if (!el || !bar || bar.contains(el) || !el.closest('.blq-form')) return null;
      const below = el.getBoundingClientRect().bottom - bar.getBoundingClientRect().top;
      return { name: el.getAttribute('aria-label') ?? el.textContent ?? el.tagName, below };
    });
    if (!overlap) continue;
    checked += 1;
    expect(overlap.below, `«${overlap.name}» under the bar`).toBeLessThanOrEqual(0);
  }
  expect(checked).toBeGreaterThan(3);
});
