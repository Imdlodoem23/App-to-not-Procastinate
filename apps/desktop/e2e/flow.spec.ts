/**
 * Flows against the fake guardian (docs/DESKTOP.md §12 «flows»): each test launches its own
 * app on a fixture (harness: fake guardian on a frozen clock, `advance()` moves it), except the
 * last one, which runs the production bootstrap with the mock guardian on the real clock.
 *
 * PROMPT §10 «Tiene que cumplirse»: a block = typing + 2 Enter (template: click + Enter);
 * extending = 1 click, sent to the guardian only after the 5 s undo; nothing looks active
 * before the guardian confirms.
 */
import type { Page } from '@playwright/test';
import type { RecordedGuardianCall } from '../src/main/contracts';
import { TRAY_ITEM } from '../src/main/tray/model';
import { splitCountdown } from '../src/shared/format';
import { UI_TIMINGS, primaryBlock } from '../src/shared/ui-state';
import { advanceInSteps, launchApp, type LaunchedApp } from './support/app';
import { visibleText } from './support/checks';
import { expect, test } from './support/test';

const PHRASE = 'no veo YouTube en una hora';
const FIELD = '¿Qué quieres hacer?';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

function callsOf(calls: RecordedGuardianCall[], method: RecordedGuardianCall['method']) {
  return calls.filter((c) => c.method === method);
}

/** The big countdown's text («1:00:00», «42:10»). */
function bigCountdown(page: Page) {
  return page.getByRole('timer').first();
}

async function expectedCountdown(launched: LaunchedApp): Promise<string> {
  const snapshot = await launched.harness.snapshot();
  const block = primaryBlock(snapshot.state);
  const now = snapshot.harness?.frozenNowMs;
  if (!block || now === undefined || now === null) throw new Error('no active block');
  return splitCountdown(Date.parse(block.endsAt) - now).text;
}

test('phrase + Enter + Enter creates the block (one createBlock, with an Idempotency-Key)', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');

  const field = main.getByRole('textbox', { name: FIELD });
  await field.click();
  await field.fill(PHRASE);
  await field.press('Enter');

  // The card replaces the templates; its confirm button has the focus.
  const confirm = main.getByRole('button', { name: /^Bloquear / });
  await expect(confirm).toBeVisible();
  await expect(confirm).toBeFocused();
  expect(callsOf(await app.harness.guardianCalls(), 'createBlock')).toHaveLength(0);
  await expect(bigCountdown(main)).toHaveCount(0);

  await main.keyboard.press('Enter');

  await expect(bigCountdown(main)).toBeVisible();
  await expect(bigCountdown(main)).toHaveText('1:00:00');
  await expect(main.getByRole('heading', { name: /^Bloqueo: YouTube/ })).toBeVisible();
  const creates = callsOf(await app.harness.guardianCalls(), 'createBlock');
  expect(creates).toHaveLength(1);
  expect(creates[0]?.idempotencyKey, 'Idempotency-Key').toBeTruthy();

  // Title and tray say it too (main's minute timer and every publish).
  await expect.poll(() => app?.harness.windowTitle()).toMatch(/^Céntrate · quedan/);
  await expect.poll(() => app?.harness.trayTooltip()).toContain('YouTube');
});

test('more than 4 h: the first Enter shows the consequence, the second works after 2 s', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await field.fill('bloquea las redes sociales 6 horas');
  await field.press('Enter');
  await expect(main.getByRole('button', { name: /^Bloquear / })).toBeFocused();

  await main.keyboard.press('Enter');
  await expect(visibleText(main, /^6 h: termina .* y solo se puede ampliar$/)).toBeVisible();
  const again = main.getByRole('button', { name: /^Sí, bloquear 6 h/ });
  await expect(again).toBeDisabled();
  await main.keyboard.press('Enter');
  expect(callsOf(await app.harness.guardianCalls(), 'createBlock')).toHaveLength(0);

  await app.harness.advance(2_100);
  await expect(again).toBeEnabled();
  await again.focus();
  await main.keyboard.press('Enter');
  await expect(bigCountdown(main)).toHaveText('6:00:00');
  expect(callsOf(await app.harness.guardianCalls(), 'createBlock')).toHaveLength(1);
});

test('Hardcore: the consequence says it cannot be cancelled', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await field.fill(PHRASE);
  await field.press('Enter');
  await main.getByRole('radio', { name: 'Hardcore' }).click();
  await main.getByRole('button', { name: /^Bloquear / }).click();
  await expect(visibleText(main, /^No podrás cancelarlo de ninguna forma hasta/)).toBeVisible();
  const again = main.getByRole('button', { name: /^Sí, bloquear/ });
  await expect(again).toBeDisabled();
  await app.harness.advance(2_100);
  await again.click();
  await expect(bigCountdown(main)).toHaveText('1:00:00');
  await expect(main.getByText('Hardcore: no se puede cancelar')).toBeVisible();
  const [create] = callsOf(await app.harness.guardianCalls(), 'createBlock');
  expect(JSON.stringify(create?.body)).toContain('"mode":"hardcore"');
});

test('template tile + Enter creates the block', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');

  await main.getByRole('button', { name: /^Deberes/ }).click();
  const confirm = main.getByRole('button', { name: /^Bloquear / });
  await expect(confirm).toBeFocused();
  await main.keyboard.press('Enter');

  await expect(bigCountdown(main)).toHaveText('1:00:00');
  expect(callsOf(await app.harness.guardianCalls(), 'createBlock')).toHaveLength(1);
});

test('tray «Bloqueo rápido ▸» opens the card in the main window', async () => {
  app = await launchApp({ state: 'idle', show: false });
  const main = await app.page('main');
  const menu = await app.harness.trayMenu();
  expect(JSON.stringify(menu)).toContain(TRAY_ITEM.template('deberes'));

  await app.harness.clickTrayItem(TRAY_ITEM.template('deberes'));
  const confirm = main.getByRole('button', { name: /^Bloquear / });
  await expect(confirm).toBeVisible();
  await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(true);
  await expect(confirm).toBeFocused();
  await main.keyboard.press('Enter');
  await expect(bigCountdown(main)).toHaveText('1:00:00');
});

test('extend +15 min: undo within 5 s sends nothing; otherwise one call after 5 s', async () => {
  app = await launchApp({ state: 'one-block', show: true });
  const main = await app.page('main');
  const extends_ = async () => callsOf(await app!.harness.guardianCalls(), 'extendBlock');
  const endsAt = async () => primaryBlock((await app!.harness.snapshot()).state)?.endsAt;
  const originalEnd = await endsAt();
  expect(originalEnd).toBeTruthy();

  const plus15 = main.getByRole('button', { name: /^\+15 min$/ });
  const undo = main.getByRole('button', { name: /^Deshacer/ });

  // Click, then undo inside the window: the guardian never hears of it.
  await plus15.click();
  await expect(undo).toBeVisible();
  await expect(main.getByText(/^\+15 min · termina/)).toBeVisible();
  await undo.click();
  await expect(undo).toHaveCount(0);
  await app.harness.advance(6_000);
  expect(await extends_()).toHaveLength(0);
  expect(await endsAt()).toBe(originalEnd);

  // Click and wait: sent once, at 5 s, with an Idempotency-Key.
  await plus15.click();
  await expect(undo).toBeVisible();
  await app.harness.advance(4_900);
  expect(await extends_()).toHaveLength(0);
  await app.harness.advance(200);
  await expect.poll(async () => (await extends_()).length).toBe(1);
  const [call] = await extends_();
  expect(call?.idempotencyKey, 'Idempotency-Key').toBeTruthy();
  expect(JSON.stringify(call?.body)).toContain('"addMinutes":15');

  // The countdown moves only with the guardian's new end.
  await expect
    .poll(async () => Date.parse((await endsAt()) ?? '') - Date.parse(originalEnd ?? ''))
    .toBe(15 * 60_000);
  await expect(bigCountdown(main)).toHaveText(await expectedCountdown(app));
  await expect(undo).toHaveCount(0);
});

test('raising a covered window under a block keeps the Bloqueo layout (tray click, «Abrir»)', async () => {
  app = await launchApp({ state: 'one-block', show: true });
  const main = await app.page('main');
  const nuevo = main.getByRole('button', { name: /^Nuevo/ });
  const field = main.getByRole('textbox', { name: FIELD });
  await expect(nuevo).toBeVisible();
  await expect(field).toHaveCount(0);
  const height = async () => (await app!.harness.bounds()).main?.content.height;
  const before = await height();
  expect(before).toBeTruthy();

  const cover = async (): Promise<void> => {
    await app!.electron.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.blur();
    });
    // Past the tray's blur grace, so the click reads as «covered», not «just blurred».
    await main.waitForTimeout(UI_TIMINGS.trayBlurGraceMs + 350);
  };

  for (const raise of [
    () => app!.harness.trayClick(),
    () => app!.harness.clickTrayItem(TRAY_ITEM.open),
  ]) {
    await cover();
    await raise();
    await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(true);
    await main.waitForTimeout(300);
    await expect(field).toHaveCount(0);
    await expect(nuevo).toBeVisible();
    expect(await height()).toBe(before);
  }
});

test('«Reintentar» after a timeout resends the same Idempotency-Key', async () => {
  app = await launchApp({ state: 'guardian-timeout', show: true });
  const main = await app.page('main');
  const intentId = (await app.harness.snapshot()).ops.create?.intentId;
  expect(intentId).toBeTruthy();
  await expect(visibleText(main, /El guardián no responde/)).toBeVisible();

  await main.getByRole('button', { name: /^Reintentar/ }).click();
  // «Bloqueando…» (a label, no spinner) and nothing active until the guardian answers.
  const pending = main.getByRole('button', { name: 'Bloqueando…' });
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();
  await expect(bigCountdown(main)).toHaveCount(0);
  await expect
    .poll(async () => callsOf(await app!.harness.guardianCalls(), 'createBlock').length)
    .toBe(1);
  const [retry] = callsOf(await app.harness.guardianCalls(), 'createBlock');
  expect(retry?.idempotencyKey).toBe(intentId);
  // The scripted guardian never answers: after 3 s it is a timeout again, nothing active.
  await app.harness.advance(3_100);
  await expect(visibleText(main, /El guardián no responde/)).toBeVisible();
  await expect(bigCountdown(main)).toHaveCount(0);
});

test('emergency: the link opens the Emergencia window with the price', async () => {
  app = await launchApp({ state: 'one-block', show: true });
  const main = await app.page('main');

  await main.getByRole('button', { name: 'Desbloqueo de emergencia…' }).click();
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const title = await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.isVisible())
      .map((w) => w.getTitle()),
  );
  expect(title).toContain('Emergencia');
  const detail = await app.page('detail');
  await expect(detail.getByRole('heading', { level: 1, name: 'Emergencia' })).toBeAttached();
  // DETAILS: the preview, already priced («Perderás 620 puntos y tu racha de 5 días»).
  await expect(detail.getByText(/Perderás/)).toBeVisible();
});

test('emergency: phrase by hand (paste refused) → waiting → ready → «¿Seguro?» → unlocked', async () => {
  test.setTimeout(90_000);
  app = await launchApp({ state: 'one-block', show: true });
  const main = await app.page('main');
  await main.getByRole('button', { name: 'Desbloqueo de emergencia…' }).click();
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await expect(detail.getByText(/Perderás/)).toBeVisible();

  // The phrase to copy is shown between «…» after «Escribe a mano esta frase:».
  const intro = detail.getByText(/^Escribe a mano esta frase:/);
  const phrase = /«(.+)»/.exec((await intro.textContent()) ?? '')?.[1];
  expect(phrase, 'commitment phrase').toBeTruthy();
  const field = detail.getByRole('textbox', { name: 'Frase de compromiso' });
  const request = detail.getByRole('button', { name: /^Empezar la espera/ });

  // A real paste (system clipboard + shortcut) is refused.
  await app.electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), phrase ?? '');
  await field.focus();
  await field.press('ControlOrMeta+V');
  await expect(field).toHaveValue('');
  await expect(detail.getByText('Escríbela a mano: pegar no vale')).toBeVisible();
  expect(callsOf(await app.harness.guardianCalls(), 'requestEmergency')).toHaveLength(0);

  // Typed by hand: the wait can start; the block stays active meanwhile.
  await field.pressSequentially(phrase ?? '', { delay: 0 });
  await expect(detail.getByText('Coincide')).toBeVisible();
  await request.click();
  await expect
    .poll(async () => (await app!.harness.snapshot()).state?.emergency?.status)
    .toBe('counting');
  expect(callsOf(await app.harness.guardianCalls(), 'requestEmergency')).toHaveLength(1);
  await expect(detail.getByRole('button', { name: /^Cancelar \(recomendado\)/ })).toBeVisible();
  await expect(bigCountdown(main)).toBeVisible();

  // Wait out the countdown on the frozen clock.
  const snapshot = await app.harness.snapshot();
  const readyAt = Date.parse(snapshot.state?.emergency?.readyAt ?? '');
  const now = snapshot.harness?.frozenNowMs ?? NaN;
  expect(Number.isFinite(readyAt - now)).toBe(true);
  await advanceInSteps(app, readyAt - now + 1_000, 2_500);

  // «Desbloquear» asks «¿Seguro?» in place; the second press confirms.
  const unlock = detail.getByRole('button', { name: /Desbloquear/ });
  await expect(unlock).toBeVisible();
  // What the page sees around the two presses (anything that disarms or skips a press), for
  // the failure message: the Windows runner once saw the second press confirm nothing.
  await detail.evaluate(() => {
    const w = window as unknown as { __unlockLog: string[] };
    const t0 = performance.now();
    const name = (t: EventTarget | null): string =>
      t instanceof HTMLElement
        ? (t.dataset['tileId'] ?? (t.id || t.tagName.toLowerCase()))
        : t === window
          ? 'window'
          : 'document';
    w.__unlockLog = [];
    const types = ['pointerdown', 'click', 'mouseleave', 'focusout', 'blur', 'visibilitychange'];
    for (const type of types) {
      window.addEventListener(
        type,
        (e) => {
          const detail = e instanceof MouseEvent ? ` detail=${e.detail}` : '';
          w.__unlockLog.push(
            `${Math.round(performance.now() - t0)} ${type} ${name(e.target)}${detail}`,
          );
        },
        true,
      );
    }
  });
  await unlock.click();
  await expect(unlock).toHaveAccessibleName(/¿Seguro\?/);
  expect(callsOf(await app.harness.guardianCalls(), 'confirmEmergency')).toHaveLength(0);
  await unlock.click();
  try {
    await expect
      .poll(async () => callsOf(await app!.harness.guardianCalls(), 'confirmEmergency').length)
      .toBe(1);
  } catch (error) {
    const seen = await detail.evaluate(
      () => (window as unknown as { __unlockLog: string[] }).__unlockLog,
    );
    const now = await unlock.evaluateAll((els) =>
      els.map((el) => `${el.textContent} (${el.getAttribute('aria-description')})`),
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `«Desbloquear» now: ${now.join(', ') || 'gone'}; page events: ${seen.join(' | ')}`,
      { cause: error },
    );
  }
  await expect(detail.getByText(/^Has perdido/)).toBeVisible();
  await expect(main.getByRole('heading', { name: /^Bloqueo: ninguno/ })).toBeVisible();
});

test('Ajustes: theme applies at once, pairing code, «Copiar diagnóstico», BORRAR', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const main = await app.page('main');
  await main.getByRole('button', { name: /^Ajustes/ }).click();
  await expect.poll(async () => (await app?.harness.bounds())?.detail?.visible).toBe(true);
  const detail = await app.page('detail');
  await expect(detail.getByRole('heading', { level: 1, name: 'Ajustes' })).toBeAttached();
  const dark = (page: Page) =>
    page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);

  // Theme: no «Guardar», both windows follow at once.
  await detail.getByRole('radio', { name: 'Oscuro' }).click();
  await expect.poll(() => dark(main)).toBe(true);
  await expect.poll(() => dark(detail)).toBe(true);
  expect((await app.harness.snapshot()).prefs.theme).toBe('dark');
  await detail.getByRole('radio', { name: 'Claro' }).click();
  await expect.poll(() => dark(main)).toBe(false);

  // Pairing code.
  await detail.getByRole('button', { name: /^Nuevo código/ }).click();
  await expect(detail.getByText(/^\d{6}$/)).toBeVisible();
  expect(callsOf(await app.harness.guardianCalls(), 'createPairingCode')).toHaveLength(1);

  // Diagnostics go to the clipboard from main (the text never crosses IPC).
  await app.electron.evaluate(({ clipboard }) => clipboard.writeText(''));
  await detail.getByRole('button', { name: /^Copiar diagnóstico/ }).click();
  await expect(detail.getByText(/^Copiado/)).toBeVisible();
  const copied = await app.electron.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied.length).toBeGreaterThan(20);

  // «Borrar todos mis datos» needs the word BORRAR.
  const erase = detail.getByRole('button', { name: /^Borrar$/ });
  const word = detail.getByRole('textbox', { name: /BORRAR/ });
  await expect(erase).toBeDisabled();
  await word.fill('BORRA');
  await expect(erase).toBeDisabled();
  await word.fill('BORRAR');
  await expect(erase).toBeEnabled();
  await erase.click();
  if (callsOf(await app.harness.guardianCalls(), 'deleteData').length === 0) {
    // In-place «¿Seguro?»: the second press confirms.
    await erase.click();
  }
  await expect
    .poll(async () => callsOf(await app!.harness.guardianCalls(), 'deleteData').length)
    .toBe(1);
  await expect(detail.getByText(/^Hecho: tus datos se han borrado/)).toBeVisible();
});

test('emergency: counting reaches «lista» on the frozen clock', async () => {
  app = await launchApp({ state: 'emergency-waiting', show: true });
  const main = await app.page('main');
  await expect(main.getByText(/^Emergencia: \d+:\d\d$/)).toBeVisible();
  const emergency = (await app.harness.snapshot()).state?.emergency;
  const readyAt = emergency?.readyAt ? Date.parse(emergency.readyAt) : NaN;
  const now = (await app.harness.snapshot()).harness?.frozenNowMs ?? NaN;
  expect(Number.isFinite(readyAt - now)).toBe(true);
  await advanceInSteps(app, readyAt - now + 1_000);
  await expect(main.getByText('Emergencia: lista')).toBeVisible();
});

test('notifications while hidden: «Quedan 5 min», then «Bloqueo terminado», ≤ 1 per minute', async () => {
  test.setTimeout(90_000);
  app = await launchApp({ state: 'one-block', show: false });
  const snapshot = await app.harness.snapshot();
  const block = primaryBlock(snapshot.state);
  const now = snapshot.harness?.frozenNowMs ?? NaN;
  expect(block).toBeTruthy();
  await advanceInSteps(app, Date.parse(block?.endsAt ?? '') - now + 90_000, 2_500);

  const shown = await app.harness.notifications();
  const titles = shown.map((n) => n.title);
  expect(titles).toContain('Quedan 5 min');
  expect(titles).toContain('Bloqueo terminado');
  for (let i = 1; i < shown.length; i += 1) {
    const gap = (shown[i]?.at ?? 0) - (shown[i - 1]?.at ?? 0);
    expect(gap, `${titles[i - 1]} → ${titles[i]}`).toBeGreaterThanOrEqual(60_000);
  }
});

test('the X hides both windows; the tray hint is shown once', async () => {
  app = await launchApp({ state: 'idle', show: true });
  const closeMain = () =>
    app!.electron.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('window=main'),
      );
      main?.close();
    });
  await closeMain();
  await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(false);
  await app.harness.showMain();
  await closeMain();
  await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(false);
  const hints = (await app.harness.notifications()).filter((n) => n.kinds.includes('close_hint'));
  expect(hints).toHaveLength(1);
  expect(app.electron.process().exitCode).toBeNull();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} (logout, Ctrl+C; like Cmd+Q, a quit started outside JS) exits cleanly`, async () => {
    test.skip(process.platform === 'win32', 'Windows has no POSIX signals');
    app = await launchApp({ state: null });
    const main = await app.page('main');
    await expect(main.getByRole('textbox', { name: FIELD })).toBeVisible({ timeout: 15_000 });
    const proc = app.electron.process();
    const exited = new Promise<number | null>((resolve) =>
      proc.once('exit', (code) => resolve(code)),
    );
    proc.kill(signal);
    // `core.shutdown` runs inside `before-quit`; the process must then really exit.
    const code = await Promise.race([
      exited,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5_000)),
    ]);
    expect(code).toBe(0);
  });
}

test('mock guardian (no harness): phrase + Enter + Enter, then the countdown ticks in real time', async () => {
  app = await launchApp({ state: null });
  const main = await app.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.click();
  await field.fill(PHRASE);
  await field.press('Enter');
  await expect(main.getByRole('button', { name: /^Bloquear / })).toBeFocused();
  await main.keyboard.press('Enter');

  const timer = bigCountdown(main);
  await expect(timer).toBeVisible();
  await expect(timer).toHaveText(/^(1:00:00|59:5\d)$/);

  // Real clock: the displayed seconds follow the wall clock (≤ 1 s off over 3 s).
  const seconds = (text: string): number =>
    text
      .split(':')
      .map(Number)
      .reduce((acc, n) => acc * 60 + n, 0);
  const sample = async (): Promise<{ at: number; left: number }> => {
    const text = (await timer.textContent()) ?? '';
    return { at: Date.now(), left: seconds(text.trim()) };
  };
  const first = await sample();
  await main.waitForTimeout(3_000);
  const second = await sample();
  const elapsed = (second.at - first.at) / 1000;
  expect(Math.abs(first.left - second.left - elapsed)).toBeLessThanOrEqual(1);
});
