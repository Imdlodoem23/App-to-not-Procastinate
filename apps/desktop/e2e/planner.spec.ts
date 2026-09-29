/**
 * Bloqueos, Phase 5 (PLANNER; PROMPT §9 «Horarios», «Modo examen», §10 «Ventanas de detalle ›
 * Bloqueos»; docs/DESKTOP.md §15):
 *
 * - `schedules`: the new schedule «L–V 16:00–19:00 · Redes sociales» open in place; axe and the
 *   keyboard audit clean in both themes and in English; «Guardar» creates it (one
 *   `Idempotency-Key`), the row appears and the focus goes back to «Nuevo horario»;
 * - Hardcore asks the in-place «¿Seguro?» with the red consequence and sends the
 *   acknowledgement; Esc closes the editor;
 * - a saved schedule: «Editar» opens it, a weakening edit 10 min before it starts is refused
 *   with the guardian's words while a strengthening one goes through, «Borrar» is locked then;
 *   later «Borrar» asks «¿Seguro?» and removes it;
 * - `exam-whitelist`: the extras with the pending addition and its date; distractions and study
 *   sites refused with the reason; an addition waits 24 h; a removal applies at once; the PUT
 *   carries the full settings.
 */
import type { Locator, Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, settleWindow } from './support/checks';
import { auditKeyboard, auditProblems } from './support/keyboard';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

async function bloqueosWindow(state: 'schedules' | 'exam-whitelist' | 'bloqueos'): Promise<Page> {
  app = await launchApp({ state, show: true });
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await expect(detail.locator('.blq')).toBeVisible();
  await expect(detail.locator('.blq[data-loading]')).toHaveCount(0);
  return detail;
}

function schedules(detail: Page): Locator {
  return detail.locator('[data-section="blq-schedules"]');
}

function editor(detail: Page): Locator {
  return schedules(detail).locator('.blq-editor');
}

async function expectClean(detail: Page, label: string): Promise<void> {
  const violations = await axeViolations(detail);
  expect(violations, `${label}: ${formatViolations(violations)}`).toEqual([]);
  const problems = auditProblems(await auditKeyboard(detail));
  expect(problems, `${label}:\n${problems.join('\n')}`).toEqual([]);
}

test('schedules: the new schedule in place, accessible, saved with one key', async () => {
  const detail = await bloqueosWindow('schedules');
  const heading = editor(detail).getByRole('heading', { level: 3 });
  await expect(heading).toHaveText('Nuevo horario: L–V 16:00–19:00 · Redes sociales');
  await expect(editor(detail).getByRole('textbox', { name: /^Nombre del horario/ })).toHaveValue(
    'Tardes sin redes',
  );
  await expect(editor(detail).getByRole('checkbox', { name: 'lunes' })).toBeChecked();
  await expect(editor(detail).getByRole('checkbox', { name: 'sábado' })).not.toBeChecked();
  await expect(editor(detail).locator('#blq-schedule-editor-times')).toHaveText('Dura 3 h');
  // «Nuevo horario» hides while the editor is open.
  await expect(schedules(detail).getByRole('button', { name: /^Nuevo horario/ })).toHaveCount(0);

  for (const theme of ['light', 'dark'] as const) {
    await app?.harness.load('schedules', { theme });
    if (app) await settleWindow(app, 'detail');
    await expect(heading).toBeVisible();
    await expectClean(detail, theme);
  }
  await app?.harness.load('schedules', { lang: 'en' });
  await expect(heading).toHaveText('New schedule: Mo–Fr 4:00 PM–7:00 PM · Social media');
  await expectClean(detail, 'en');
  await app?.harness.load('schedules', { lang: 'es' });
  await expect(heading).toHaveText('Nuevo horario: L–V 16:00–19:00 · Redes sociales');

  // A time is read as typed and written back as HH:MM when the field is left.
  const end = editor(detail).getByRole('textbox', { name: 'Hasta' });
  await end.fill('1930');
  await end.press('Tab');
  await expect(end).toHaveValue('19:30');
  await expect(heading).toHaveText('Nuevo horario: L–V 16:00–19:30 · Redes sociales');

  await editor(detail)
    .getByRole('button', { name: /^Guardar/ })
    .click();
  await expect(editor(detail)).toHaveCount(0);
  await expect(schedules(detail).getByRole('heading', { level: 2 })).toHaveText(
    'Horarios: 2 de 3 activos',
  );
  await expect(
    schedules(detail).getByText('L–V 16:00–19:30 · Redes sociales', { exact: true }),
  ).toBeVisible();
  await expect(
    schedules(detail).getByText('Guardado: L–V 16:00–19:30 · Redes sociales'),
  ).toBeVisible();
  await expect(detail.locator('[data-announcer]')).toHaveText(
    'Guardado: L–V 16:00–19:30 · Redes sociales',
  );
  await expect(schedules(detail).getByRole('button', { name: /^Nuevo horario/ })).toBeFocused();

  const calls = (await app?.harness.guardianCalls())?.filter((c) => c.method === 'createSchedule');
  expect(calls).toHaveLength(1);
  expect(calls?.[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{8,}$/);
  expect(calls?.[0]?.body).toMatchObject({
    name: 'Tardes sin redes',
    days: [1, 2, 3, 4, 5],
    start: '16:00',
    end: '19:30',
    timezone: expect.any(String),
    targets: { categoryIds: ['social'] },
    mode: 'normal',
    whitelistOnly: false,
    acknowledgeNoEmergency: false,
  });
});

test('schedules: Hardcore asks «¿Seguro?» in place; Esc closes the editor', async () => {
  const detail = await bloqueosWindow('schedules');
  const box = editor(detail);
  await box.getByRole('radio', { name: 'Hardcore' }).click();
  const save = box.getByRole('button', { name: /Guardar/ });
  await save.focus();
  await detail.keyboard.press('Enter');
  await expect(save).toHaveText(/^¿Seguro\?/);
  const help = box.locator('#blq-schedule-actions-help');
  await expect(help).toHaveText(
    'Cuando empiece, no podrás cancelarlo de ninguna forma hasta que acabe',
  );
  await expect(help).toHaveAttribute('data-tone', 'red');
  await detail.keyboard.press('Enter');
  await expect(box).toHaveCount(0);
  const call = (await app?.harness.guardianCalls())?.find((c) => c.method === 'createSchedule');
  expect(call?.body).toMatchObject({ mode: 'hardcore', acknowledgeNoEmergency: true });

  await schedules(detail)
    .getByRole('button', { name: /^Nuevo horario/ })
    .click();
  await expect(editor(detail)).toBeVisible();
  await expect(editor(detail).getByRole('textbox', { name: /^Nombre del horario/ })).toBeFocused();
  await detail.keyboard.press('Escape');
  await expect(editor(detail)).toHaveCount(0);
  await expect(schedules(detail).getByRole('button', { name: /^Nuevo horario/ })).toBeFocused();
  // The window is still open: Esc closed the editor, not the window.
  expect((await app?.harness.bounds())?.detail?.visible).toBe(true);
});

test('schedules: 10 min before it starts only a stricter edit goes through; «Borrar»', async () => {
  const detail = await bloqueosWindow('schedules');
  await editor(detail)
    .getByRole('button', { name: /^Cancelar/ })
    .click();
  const rows = schedules(detail).getByRole('listitem');
  await expect(rows).toHaveCount(2);

  // «Tardes de estudio» starts at 18:00; move the clock to 17:52.
  await app?.harness.advance(52 * 60_000);
  const first = rows.first();
  await expect(first).toContainText('Empieza en menos de 10 min: ya no se puede quitar');
  await expect(first.getByRole('switch')).toHaveAttribute('aria-disabled', 'true');

  await first.getByRole('button', { name: /^Editar/ }).click();
  const box = editor(detail);
  await expect(box.getByRole('heading', { level: 3 })).toHaveText(
    'Editar: L–V 18:00–20:00 · Redes sociales',
  );
  await expect(first).toContainText('Editando…');
  const save = box.getByRole('button', { name: /Guardar/ });
  const remove = box.getByRole('button', { name: /Borrar/ });
  const help = box.locator('#blq-schedule-actions-help');
  await expect(remove).toHaveAttribute('aria-disabled', 'true');

  // Losing a day weakens it: refused with the guardian's words.
  await box.getByRole('checkbox', { name: 'viernes' }).uncheck();
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(help).toHaveText('Empieza a las 18:00: a menos de 10 min solo se puede endurecer');
  // Adding Saturday instead strengthens it: it goes through.
  await box.getByRole('checkbox', { name: 'viernes' }).check();
  await box.getByRole('checkbox', { name: 'sábado' }).check();
  await expect(save).not.toHaveAttribute('aria-disabled', 'true');
  await save.click();
  await expect(box).toHaveCount(0);
  await expect(first).toContainText('L–S 18:00–20:00 · Redes sociales');
  const update = (await app?.harness.guardianCalls())?.find((c) => c.method === 'updateSchedule');
  expect(update?.body).toMatchObject([expect.any(String), { days: [1, 2, 3, 4, 5, 6] }]);

  // «Sábados sin juegos» is off: it can be deleted, after «¿Seguro?».
  await rows
    .nth(1)
    .getByRole('button', { name: /^Editar/ })
    .click();
  const del = editor(detail).getByRole('button', { name: /Borrar/ });
  await del.focus();
  await detail.keyboard.press('Enter');
  await expect(del).toHaveText(/^¿Seguro\?/);
  await expect(editor(detail).locator('#blq-schedule-actions-help')).toHaveText(
    'Se borra «Sábados sin juegos»; lo que ya empezó sigue hasta el final',
  );
  await detail.keyboard.press('Enter');
  await expect(editor(detail)).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(schedules(detail).getByText('Borrado: «Sábados sin juegos»')).toBeVisible();
  // The focus lands on «Nuevo horario», never on <body>.
  await expect(schedules(detail).getByRole('button', { name: /^Nuevo horario/ })).toBeFocused();
});

test('exam-whitelist: extras, the pending one, refusals with reasons, add and remove', async () => {
  const detail = await bloqueosWindow('exam-whitelist');
  const exam = detail.locator('[data-section="blq-exam"]');
  const whitelist = exam.locator('.blq-whitelist');
  await expect(whitelist.getByRole('heading', { level: 3 })).toHaveText(
    'Tu lista blanca: 3 extras · 1 esperando',
  );
  await expect(
    whitelist.getByRole('button', { name: 'Quitar geogebra.org (se permitiría mañana 16:10)' }),
  ).toHaveText('geogebra.org · desde mañana 16:10');

  for (const theme of ['light', 'dark'] as const) {
    await app?.harness.load('exam-whitelist', { theme });
    if (app) await settleWindow(app, 'detail');
    await expect(whitelist).toBeVisible();
    await expectClean(detail, theme);
  }
  await app?.harness.load('exam-whitelist', { lang: 'en' });
  await expect(whitelist.getByRole('heading', { level: 3 })).toHaveText(
    'Your allowlist: 3 extras · 1 waiting',
  );
  await expectClean(detail, 'en');
  await app?.harness.load('exam-whitelist', { lang: 'es' });

  const help = whitelist.locator('#blq-whitelist-help');
  const web = whitelist.getByRole('textbox', { name: 'Webs permitidas' });
  const allowWeb = whitelist.getByRole('button', { name: /^Permitir/ }).first();
  await expect(web).toHaveValue('deepl.com');
  await allowWeb.click();
  await expect(help).toHaveText('Ya está en la lista de estudio');
  await web.fill('youtube.com');
  await web.press('Enter');
  await expect(help).toHaveText(
    'youtube.com es de YouTube: una distracción no puede ir en la lista blanca',
  );
  await expect(help).toHaveAttribute('data-tone', 'orange');
  const app1 = whitelist.getByRole('textbox', { name: 'Apps permitidas' });
  await app1.fill('steam.exe');
  await app1.press('Enter');
  await expect(help).toHaveText('Steam es una distracción: no puede ir en la lista blanca');
  expect(
    (await app?.harness.guardianCalls())?.filter((c) => c.method === 'updateSettings'),
  ).toHaveLength(0);

  // An addition loosens the whitelist: it waits 24 h (the PUT carries every setting).
  await web.fill('apuntes-ejemplo.es');
  await web.press('Enter');
  await expect(help).toHaveText(/^apuntes-ejemplo\.es se permitirá mañana/);
  await expect(web).toHaveValue('');
  await expect(whitelist.getByRole('button', { name: /^Quitar apuntes-ejemplo\.es/ })).toHaveText(
    /^apuntes-ejemplo\.es · desde mañana/,
  );
  const put = (await app?.harness.guardianCalls())?.find((c) => c.method === 'updateSettings');
  expect(put?.body).toMatchObject({
    timezone: 'Europe/Madrid',
    dailyGoalMinutes: 60,
    studyWhitelist: {
      extraDomains: ['wikipedia.org', 'khanacademy.org', 'geogebra.org', 'apuntes-ejemplo.es'],
      extraProcesses: ['WINWORD.EXE'],
    },
  });

  // A removal applies at once.
  await whitelist.getByRole('button', { name: 'Quitar khanacademy.org' }).click();
  await expect(help).toHaveText('Quitada: khanacademy.org');
  await expect(whitelist.getByRole('button', { name: 'Quitar khanacademy.org' })).toHaveCount(0);
  await expect(detail.locator('[data-announcer]')).toHaveText('Quitada: khanacademy.org');
});

test('exam-whitelist: removing by keyboard keeps the focus on the list, never on <body>', async () => {
  const detail = await bloqueosWindow('exam-whitelist');
  const whitelist = detail.locator('[data-section="blq-exam"] .blq-whitelist');
  const help = whitelist.locator('#blq-whitelist-help');
  const chip = (name: string | RegExp) => whitelist.getByRole('button', { name });
  const bodyFocused = () => detail.evaluate(() => document.activeElement === document.body);

  // The first chip: the focus goes to the one that took its place.
  await chip('Quitar wikipedia.org').focus();
  await detail.keyboard.press('Enter');
  await expect(help).toHaveText('Quitada: wikipedia.org');
  await expect(chip('Quitar wikipedia.org')).toHaveCount(0);
  await expect(chip('Quitar khanacademy.org')).toBeFocused();

  // The pending one is the last web chip: the focus goes to the next chip (the app).
  await chip(/^Quitar geogebra\.org/).focus();
  await detail.keyboard.press('Enter');
  await expect(chip(/^Quitar geogebra\.org/)).toHaveCount(0);
  await expect(chip('Quitar WINWORD.EXE')).toBeFocused();

  // The last chip: the previous one.
  await detail.keyboard.press('Enter');
  await expect(chip('Quitar WINWORD.EXE')).toHaveCount(0);
  await expect(chip('Quitar khanacademy.org')).toBeFocused();

  // The only chip left: its field.
  await detail.keyboard.press('Enter');
  await expect(chip('Quitar khanacademy.org')).toHaveCount(0);
  await expect(whitelist.getByRole('textbox', { name: 'Webs permitidas' })).toBeFocused();
  expect(await bodyFocused()).toBe(false);

  // A suggestion leaves the suggestions once allowed: the focus goes to the apps field.
  const apps = whitelist.getByRole('textbox', { name: 'Apps permitidas' });
  await apps.fill('code');
  const suggestion = whitelist.getByRole('button', { name: 'Permitir Code.exe' });
  await suggestion.focus();
  await detail.keyboard.press('Enter');
  await expect(suggestion).toHaveCount(0);
  await expect(chip(/^Quitar Code\.exe/)).toHaveCount(1);
  await expect(apps).toBeFocused();
  expect(await bodyFocused()).toBe(false);
});

test('exam: «Examen 2 h» goes to the main card, whose red line says it cannot be cancelled', async () => {
  const detail = await bloqueosWindow('exam-whitelist');
  await detail
    .locator('[data-section="blq-exam"]')
    .getByRole('button', { name: /^Examen 2 h/ })
    .click();
  if (!app) throw new Error('no app');
  const main = await app.page('main');
  const confirm = main.locator('.c-confirm');
  await expect(confirm).toBeFocused();
  const bloqueo = main.locator('[data-section="bloqueo"]');
  await expect(bloqueo).toContainText('Todo salvo la lista blanca');
  await main.keyboard.press('Enter');
  const help = bloqueo.locator('#bloqueo-card-help');
  await expect(help).toHaveText('No podrás cancelarlo de ninguna forma hasta las 19:00');
  await expect(help).toHaveAttribute('data-tone', 'red');
  await expect(confirm).toHaveText(/^Sí, bloquear 2 h/);
  // Nothing reached the guardian: the card is the one confirmation path.
  const creates = (await app.harness.guardianCalls()).filter((c) => c.method === 'createBlock');
  expect(creates).toHaveLength(0);
});
