/**
 * Estadísticas (PROMPT §9, §10 «Ventanas de detalle › Estadísticas»; docs/DESKTOP.md §15):
 *
 * - `stats-week`: «Concentrado: 14 h» · «21–27 sept», one green bar chart drawn by Recharts
 *   (its own lazy chunk), the text summary it is described by, the
 *   heatmap as one named image, the ranked lists, the 12-row log; axe and the keyboard audit
 *   clean in both themes and in English;
 * - the hover and keyboard readout on the chart's help line (no popup tooltip), the heatmap
 *   readout, «Día | Semana | Mes», the period tiles that never go past today, the log filter,
 *   «Exportar eventos…» and its result;
 * - `stats-empty`: the empty state, focused, and «Empezar 25 min» opening the main window's
 *   card for 25 min.
 */
import type { Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, settleWindow } from './support/checks';
import { auditKeyboard, auditProblems } from './support/keyboard';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

async function statsWindow(state: 'stats-week' | 'stats-empty'): Promise<Page> {
  app = await launchApp({ state, show: true });
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await expect(detail.locator('.est')).toBeVisible();
  await expect(detail.locator('.est[data-loading]')).toHaveCount(0);
  return detail;
}

test('stats-week: chart, summary, heatmap, lists and log, accessible in both themes', async () => {
  const detail = await statsWindow('stats-week');
  const chart = detail.locator('[data-section="est-chart"]');
  await expect(chart.getByRole('heading', { name: 'Concentrado: 14 h' })).toBeVisible();
  await expect(chart.locator('.c-section-datum')).toHaveText('21–27 sept');
  await expect(detail.getByRole('radio', { name: 'Semana' })).toBeFocused();
  // The window reports ready only once the chart's chunk is here: with the data on screen the
  // plot is already there, no waiting (a capture never shoots an empty plot).
  expect(await detail.locator('.est-chart-frame .recharts-wrapper').count()).toBe(1);

  // One Recharts chart (an interactive group), named by its caption and described by its help
  // line and the text summary beside it.
  const svg = detail.getByRole('group', { name: 'Minutos concentrado por día' });
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute('aria-describedby', 'est-chart-help est-summary');
  await expect(detail.locator('#est-summary')).toContainText('Mejor díajue 24 · 3 h 20 min');
  await expect(detail.locator('.est-bars .recharts-bar-rectangle')).toHaveCount(5);
  await expect(detail.locator('.est-bar-label')).toHaveText('3 h 20 min');
  await expect(detail.locator('.est-bars .recharts-cartesian-grid')).toHaveCount(0);
  await expect(detail.locator('#est-table tbody tr')).toHaveCount(7);

  // The heatmap: one image named by its summary, 365 days.
  const heat = detail.getByRole('img', { name: /^Último año: 321 días con actividad/ });
  await expect(heat).toBeVisible();
  await expect(detail.locator('.est-heat-cell')).toHaveCount(365);
  await expect(detail.locator('[data-section="est-heat"] h2')).toHaveText('Racha: 5 días');

  await expect(detail.getByRole('list', { name: /^Lo que más intentas abrir/ })).toContainText(
    'YouTube5 intentos−75',
  );
  await expect(detail.getByRole('list', { name: /^Tus mejores horas/ }).locator('li')).toHaveCount(
    3,
  );
  await expect(detail.locator('.est-log-row')).toHaveCount(12);

  for (const theme of ['light', 'dark'] as const) {
    await app?.harness.load('stats-week', { theme });
    if (app) await settleWindow(app, 'detail');
    await expect(detail.locator('.est-bars .recharts-bar-rectangle')).toHaveCount(5);
    const violations = await axeViolations(detail);
    expect(violations, formatViolations(violations)).toEqual([]);
    const problems = auditProblems(await auditKeyboard(detail));
    expect(problems, problems.join('\n')).toEqual([]);
  }

  await app?.harness.load('stats-week', { lang: 'en' });
  await expect(detail.getByRole('heading', { name: 'Focused: 14 h' })).toBeVisible();
  const chartEn = detail.getByRole('group', { name: 'Focused minutes per day' });
  await expect(chartEn).toBeVisible();
  await expect(chartEn).toHaveAttribute('aria-roledescription', 'bar chart');
  const violations = await axeViolations(detail);
  expect(violations, formatViolations(violations)).toEqual([]);
});

test('the chart and the heatmap answer on their help lines; periods, filter and export', async () => {
  const detail = await statsWindow('stats-week');
  const help = detail.locator('#est-chart-help');
  await expect(help).toHaveText(/^Pasa el ratón por una barra/);

  // Hover: the bar's day and minutes replace the hint (no tooltip).
  const svg = detail.locator('.est-bars svg').first();
  const box = await svg.boundingBox();
  if (!box) throw new Error('no chart');
  await detail.mouse.move(box.x + (box.width * 3.5) / 7, box.y + box.height - 30);
  await expect(help).toHaveText('Jueves 24: 3 h 20 min · 2 intentos');
  await expect(detail.locator('#est-chart-live')).toHaveText('');
  await expect(detail.locator('.recharts-tooltip-wrapper')).not.toContainText('3 h 20 min');
  await detail.mouse.move(2, 2);
  await expect(help).toHaveText(/^Pasa el ratón por una barra/);

  // Keyboard: the chart is one tab stop; the arrow keys walk the bars.
  await svg.focus();
  await detail.keyboard.press('ArrowRight');
  await detail.keyboard.press('ArrowRight');
  await expect(help).toHaveText('Miércoles 23: 2 h 55 min · 4 intentos');
  // Assistive technology gets it too: an interactive group described by the help line, and the
  // key-driven readout in a polite region (pointer hover never speaks there).
  await expect(svg).toHaveAttribute('role', 'group');
  await expect(svg).toHaveAttribute('aria-roledescription', 'gráfico de barras');
  await expect(svg).toHaveAttribute('aria-describedby', 'est-chart-help est-summary');
  const live = detail.locator('#est-chart-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveText('Miércoles 23: 2 h 55 min · 4 intentos');
  await detail.keyboard.press('ArrowLeft');
  await expect(live).toHaveText(/^Martes 22: /);
  await expect(help).toHaveText(/^Martes 22: /);

  // The heatmap cell under the pointer.
  const heat = await detail.locator('.est-heat-svg').boundingBox();
  if (!heat) throw new Error('no heatmap');
  await detail.mouse.move(heat.x + heat.width - 12, heat.y + 20);
  await expect(detail.locator('#est-heat-help')).toHaveText(
    'Lunes 21 de septiembre: 1 h 50 min · objetivo cumplido',
  );

  // Periods: this month cannot move forward; the previous one can come back.
  await detail.getByRole('radio', { name: 'Mes' }).click();
  await expect(detail.locator('[data-section="est-chart"] .c-section-datum')).toHaveText(
    'septiembre de 2026',
  );
  const next = detail.getByRole('button', { name: /^Mes siguiente/ });
  const current = detail.getByRole('button', { name: 'Este mes' });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(current).toHaveAttribute('aria-disabled', 'true');
  await detail.getByRole('button', { name: /Mes anterior/ }).click();
  await expect(next).not.toHaveAttribute('aria-disabled', 'true');
  await expect(current).not.toHaveAttribute('aria-disabled', 'true');
  await current.click();
  await expect(current).toHaveAttribute('aria-disabled', 'true');

  // Alt + letter picks a range.
  await detail.keyboard.press('Alt+s');
  await expect(detail.getByRole('radio', { name: 'Semana' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // The log filter.
  await detail.getByRole('radio', { name: 'Intentos' }).click();
  await expect(detail.locator('.est-log-row')).toHaveCount(3);
  await expect(detail.locator('#est-log-title')).toHaveText('Registro: 3 eventos');

  // «Exportar eventos…»: main saves it; only the file name comes back (dated with the real day).
  const saved = /^Guardado: centrate-eventos-\d{4}-\d{2}-\d{2}\.csv · 12 filas$/;
  await detail.getByRole('button', { name: /^Exportar eventos/ }).click();
  await expect(detail.locator('[data-announcer]')).toHaveText(saved);
  await expect(detail.locator('#est-export-help')).toHaveText(saved);
});

test('stats-empty: the empty state starts a 25 min block through the main card', async () => {
  const detail = await statsWindow('stats-empty');
  await expect(
    detail.getByText('Tus estadísticas aparecerán después de tu primera sesión'),
  ).toBeVisible();
  const start = detail.getByRole('button', { name: 'Empezar 25 min' });
  await expect(start).toBeFocused();
  await expect(detail.locator('.est-bars')).toHaveCount(0);
  const violations = await axeViolations(detail);
  expect(violations, formatViolations(violations)).toEqual([]);
  expect(auditProblems(await auditKeyboard(detail))).toEqual([]);

  await start.click();
  if (!app) throw new Error('no app');
  const main = await app.page('main');
  const confirm = main.locator('.c-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  await expect(main.locator('[data-section="bloqueo"]')).toContainText('25 min');
});
