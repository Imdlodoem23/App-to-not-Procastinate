/**
 * Keyboard and ARIA rules (PROMPT §10 «Teclado y accesibilidad», docs/DESKTOP.md §7.3, §7.4),
 * which axe does not check:
 *
 * - **Every fixture** (main window, and the detail window of detail fixtures), on its own
 *   display: 32×32 hit areas, `aria-describedby` that resolves (tiles in rows and SettingsRow
 *   controls have one), unique `aria-keyshortcuts` and one on every tile (`support/keyboard.ts`).
 * - **Focus on show**, per main-window state: the field, the card's confirm button, or the
 *   Bloqueo section root when a block hides the field.
 * - **Flows**: the Esc cascade (card, «Otro…», «Nuevo», «¿Seguro?», hide), Ctrl+E then 2, the
 *   arrow keys in a radiogroup, and the focus never falling to `<body>` when what had it goes
 *   away (undo expiry, the card closing, the Emergencia stages).
 * - **Live regions**: in every flow, nothing gains `aria-live` or mounts as a live region with
 *   its text after the window loaded (`watchLiveRegions`).
 * - **Media**: `prefers-reduced-motion` turns transitions off; `forced-colors` keeps the tile
 *   borders and the selected outline.
 */
import type { Page } from '@playwright/test';
import type { RecordedGuardianCall } from '../src/main/contracts';
import { DISPLAY_PRESETS, type HarnessFixture } from '../src/shared/fixtures';
import { SHARED_ES } from '../src/shared/i18n/es';
import { onboardingActive } from '../src/shared/ui-state';
import { advanceInSteps, launchApp, type LaunchedApp } from './support/app';
import { bloqueoAnnouncer, settleMain, visibleText } from './support/checks';
import {
  auditKeyboard,
  auditProblems,
  focusInfo,
  focusIsSomewhere,
  liveEvents,
  watchLiveRegions,
  type FocusInfo,
} from './support/keyboard';
import { selectedFixtures } from './support/matrix';
import { expect, test } from './support/test';

const FIELD = '¿Qué quieres hacer?';

// ---------------------------------------------------------------------------------------
// Every fixture: targets, descriptions, shortcuts; focus on show
// ---------------------------------------------------------------------------------------

type ShowFocus = 'field' | 'confirm' | 'section' | 'onboarding';

/**
 * Where `showMain` must leave the focus (docs/DESKTOP.md §7.2 `ui:visibility`): the card's
 * confirm button when a card (or the «Límite diario» card) is open (Enter confirms), the field when it shows, else the
 * Bloqueo section root (a block hides the field). The onboarding (§15.2, in place of the
 * sections) focuses its step's first action, or the field in its last step.
 */
function expectedShowFocus(fixture: HarnessFixture): ShowFocus {
  if (onboardingActive(fixture.snapshot)) {
    return fixture.snapshot.prefs.onboarding.step === 'first-block' ? 'field' : 'onboarding';
  }
  if (fixture.main.card || fixture.main.limitCard) return 'confirm';
  const { variant } = fixture.expect;
  if (variant === 'idle' || variant === 'finished' || fixture.main.composer.openWhileActive) {
    return 'field';
  }
  return 'section';
}

function matchesShowFocus(info: FocusInfo, want: ShowFocus): boolean {
  switch (want) {
    case 'field':
      return info.tag === 'input' && info.name === FIELD;
    case 'confirm':
      return info.classes.split(/\s+/).includes('c-confirm');
    case 'section':
      return info.isSectionRoot && info.section === 'bloqueo';
    case 'onboarding':
      return info.section === 'onboarding' && info.classes.split(/\s+/).includes('c-tile');
  }
}

async function checkFixture(app: LaunchedApp, fixture: HarnessFixture): Promise<void> {
  await app.harness.load(fixture.id, { display: fixture.display, theme: 'light' });
  await settleMain(app);
  // Surface fixtures (mini timer, OSD, Nuclear) open no detail window.
  const kinds =
    fixture.detailRequest === null ? (['main'] as const) : (['main', 'detail'] as const);
  for (const kind of kinds) {
    const page = await app.page(kind);
    const problems = auditProblems(await auditKeyboard(page));
    expect.soft(problems, `${fixture.id} ${kind}:\n  ${problems.join('\n  ')}`).toEqual([]);
  }

  // Focus on show: hide, show again (the tray click path), read the focus.
  await app.harness.hideMain();
  const want = expectedShowFocus(fixture);
  const shown = await app.harness.showMain().then(
    () => null,
    (error: unknown) => String(error),
  );
  const info = await focusInfo(await app.page('main'));
  expect
    .soft(
      shown === null && matchesShowFocus(info, want),
      `${fixture.id}: focus after show should be the ${want}, is ${info.element} «${info.name}»` +
        (shown ? ` (${shown})` : ''),
    )
    .toBe(true);
}

/** Fixtures grouped by the scale factor of their own display (one launch per group). */
const byScale = new Map<number, HarnessFixture[]>();
for (const fixture of selectedFixtures()) {
  const scale = DISPLAY_PRESETS[fixture.display].scaleFactor;
  byScale.set(scale, [...(byScale.get(scale) ?? []), fixture]);
}

for (const [scaleFactor, fixtures] of [...byScale.entries()].sort(([a], [b]) => a - b)) {
  test(`targets, descriptions, shortcuts and focus on show @${scaleFactor}x`, async ({ apps }) => {
    test.setTimeout(30_000 + fixtures.length * 6_000);
    const app = await apps.at(scaleFactor);
    for (const fixture of fixtures) {
      await test.step(fixture.id, () => checkFixture(app, fixture));
    }
  });
}

// ---------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------

let app: LaunchedApp | null = null;
/** Pages watched for late live regions in the current test (checked in `afterEach`). */
let watched: { label: string; page: Page }[] = [];

test.afterEach(async () => {
  try {
    for (const { label, page } of watched) {
      if (page.isClosed()) continue;
      const events = await liveEvents(page);
      expect
        .soft(
          events,
          `${label}: live regions must exist (empty) from load, never appear with text:\n` +
            events.map((e) => `  ${e.kind} ${e.element} «${e.text}»`).join('\n'),
        )
        .toEqual([]);
    }
  } finally {
    watched = [];
    await app?.close();
    app = null;
  }
});

/** Launches a shown harness app on `state` and watches its main window's live regions. */
async function start(state: Parameters<typeof launchApp>[0]['state']): Promise<LaunchedApp> {
  app = await launchApp({ state, show: true });
  const main = await app.page('main');
  await watch('main', main);
  return app;
}

async function watch(label: string, page: Page): Promise<void> {
  await watchLiveRegions(page);
  watched.push({ label, page });
}

/** The detail window, once shown, watched for live regions too. */
async function detailPage(launched: LaunchedApp): Promise<Page> {
  await expect.poll(async () => (await launched.harness.bounds()).detail?.visible).toBe(true);
  const page = await launched.page('detail');
  if (!watched.some((w) => w.page === page)) await watch('detail', page);
  return page;
}

/** Soft: a flow goes on after a lost focus, so one run reports every stage that loses it. */
async function expectFocusSomewhere(page: Page, when: string): Promise<FocusInfo> {
  const info = await focusInfo(page);
  expect.soft(focusIsSomewhere(info), `${when}: the focus fell to <${info.tag}>`).toBe(true);
  return info;
}

const mainVisible = async (launched: LaunchedApp) =>
  (await launched.harness.bounds()).main?.visible;
const detailVisible = async (launched: LaunchedApp) =>
  (await launched.harness.bounds()).detail?.visible;

function callsOf(calls: RecordedGuardianCall[], method: RecordedGuardianCall['method']) {
  return calls.filter((c) => c.method === method);
}

test('Esc cascade in the card: consequence → edit → card closed → text cleared → hidden', async () => {
  const launched = await start('idle');
  const main = await launched.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await field.fill('bloquea las redes sociales 6 horas');
  await field.press('Enter');
  const confirm = main.getByRole('button', { name: /^Bloquear / });
  await expect(confirm).toBeFocused();
  await main.keyboard.press('Enter');
  const consequence = visibleText(main, /^6 h: termina .* y solo se puede ampliar$/);
  await expect(consequence).toBeVisible();
  await expect(bloqueoAnnouncer(main)).toHaveText(/^6 h: termina .* y solo se puede ampliar$/);

  // 3. Back from the consequence step: the card stays, the red line goes.
  await main.keyboard.press('Escape');
  await expect(consequence).toHaveCount(0);
  await expect(confirm).toBeVisible();
  await expectFocusSomewhere(main, 'after leaving the consequence step');

  // 4. Close the card: the templates are back, the text stays, the field has the focus.
  await main.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(main.getByRole('button', { name: /^Deberes/ })).toBeVisible();
  await expect(field).toHaveValue('bloquea las redes sociales 6 horas');
  await expect(field).toBeFocused();

  // 6. Clear the text, 7. hide the window.
  await main.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  expect(await mainVisible(launched)).toBe(true);
  await main.keyboard.press('Escape');
  await expect.poll(() => mainVisible(launched)).toBe(false);
});

test('Esc cascade over a block: «Otro…» closes, the «Nuevo» field closes, then the window hides', async () => {
  const launched = await start('one-block');
  const main = await launched.page('main');

  // 2. «Otro…» opens an inline minutes field; Esc closes it and the focus stays in the row.
  await main.getByRole('button', { name: /^Otro/ }).click();
  const minutes = main.getByRole('textbox').last();
  await expect(minutes).toBeFocused();
  await main.keyboard.press('Escape');
  await expect(main.getByRole('button', { name: /^Otro/ })).toBeVisible();
  await expectFocusSomewhere(main, 'after closing «Otro…»');

  // 5. «Nuevo» opens the field under the countdown; Esc closes it.
  await main.getByRole('button', { name: /^Nuevo/ }).click();
  const field = main.getByRole('textbox', { name: FIELD });
  await expect(field).toBeFocused();
  await main.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expectFocusSomewhere(main, 'after closing the «Nuevo» field');
  expect(await mainVisible(launched)).toBe(true);

  // 7. Nothing left to back out of: hide.
  await main.keyboard.press('Escape');
  await expect.poll(() => mainVisible(launched)).toBe(false);
});

test('Esc in a detail window: disarms «¿Seguro?» first, then closes the window', async () => {
  const launched = await start('emergency-ready');
  const detail = await detailPage(launched);
  const unlock = detail.getByRole('button', { name: /Desbloquear/ });
  await unlock.focus();
  // Armed from the fixture, or by the first Enter.
  if (!/^¿Seguro\?/.test((await unlock.textContent()) ?? '')) await detail.keyboard.press('Enter');
  await expect(unlock).toHaveAccessibleName(/^¿Seguro\?/);
  expect(callsOf(await launched.harness.guardianCalls(), 'confirmEmergency')).toHaveLength(0);

  // 1. Disarm: the label is back, the window stays, the focus stays on the tile.
  await detail.keyboard.press('Escape');
  await expect(unlock).toHaveAccessibleName(/^Desbloquear/);
  await expect(unlock).toBeFocused();
  expect(await detailVisible(launched)).toBe(true);

  // 7. Close the detail window (the main window stays and gets the focus back).
  await detail.keyboard.press('Escape');
  await expect.poll(() => detailVisible(launched)).toBe(false);
  expect(await mainVisible(launched)).toBe(true);
  expect(callsOf(await launched.harness.guardianCalls(), 'confirmEmergency')).toHaveLength(0);
});

test('Ctrl+E then 2 extends by 30 min (sent after the 5 s undo); the focus survives the undo line', async () => {
  const launched = await start('one-block');
  const main = await launched.page('main');
  await expectFocusSomewhere(main, 'after show');

  await main.keyboard.press('Control+E');
  await main.keyboard.press('2');
  await expect(main.getByText(/^\+30 min · termina a las \d{1,2}:\d\d/)).toBeVisible();
  const undo = main.getByRole('button', { name: /^Deshacer/ });
  await expect(undo).toBeVisible();
  await expectFocusSomewhere(main, 'after Ctrl+E 2');
  expect(callsOf(await launched.harness.guardianCalls(), 'extendBlock')).toHaveLength(0);

  // The undo line expires: one call, and the focus does not fall to <body> even if it was on
  // «Deshacer».
  await undo.focus();
  await launched.harness.advance(5_100);
  await expect(undo).toHaveCount(0);
  await expect
    .poll(async () => callsOf(await launched.harness.guardianCalls(), 'extendBlock').length)
    .toBe(1);
  const [call] = callsOf(await launched.harness.guardianCalls(), 'extendBlock');
  expect(JSON.stringify(call?.body)).toContain('"addMinutes":30');
  await expectFocusSomewhere(main, 'after the undo line expired');
});

test('«Deshacer» by keyboard: nothing is sent and the focus stays in the extend row', async () => {
  const launched = await start('one-block');
  const main = await launched.page('main');
  const plus15 = main.getByRole('button', { name: /^\+15 min$/ });
  await plus15.focus();
  await main.keyboard.press('Enter');
  const undo = main.getByRole('button', { name: /^Deshacer/ });
  await expect(undo).toBeVisible();
  await undo.focus();
  await main.keyboard.press('Enter');
  await expect(undo).toHaveCount(0);
  await expectFocusSomewhere(main, 'after «Deshacer»');
  await launched.harness.advance(6_000);
  expect(callsOf(await launched.harness.guardianCalls(), 'extendBlock')).toHaveLength(0);
});

test('arrow keys in a radiogroup move the focus and select (Home, End, wrap-around)', async () => {
  const launched = await start('confirm-normal');
  const main = await launched.page('main');
  const group = main
    .getByRole('radiogroup')
    .filter({ has: main.getByRole('radio', { name: 'Estricto' }) });
  const radio = (name: string) => group.getByRole('radio', { name });
  const checked = group.getByRole('radio', { checked: true });

  // One tab stop: the checked radio.
  await expect(checked).toHaveAttribute('tabindex', '0');
  await checked.focus();
  const first = (await checked.textContent())?.trim() ?? '';
  expect(first).toBe('Normal');

  await main.keyboard.press('ArrowRight');
  await expect(radio('Estricto')).toBeFocused();
  await expect(radio('Estricto')).toBeChecked();
  await main.keyboard.press('End');
  await expect(radio('Examen')).toBeFocused();
  await expect(radio('Examen')).toBeChecked();
  await main.keyboard.press('ArrowRight');
  await expect(radio('Normal')).toBeFocused();
  await expect(radio('Normal')).toBeChecked();
  await main.keyboard.press('ArrowLeft');
  await expect(radio('Examen')).toBeFocused();
  await main.keyboard.press('Home');
  await expect(radio('Normal')).toBeFocused();
  await expect(radio('Normal')).toBeChecked();
  await expect(group.getByRole('radio', { checked: true })).toHaveCount(1);
});

test('the card closing never leaves the focus on <body> (Esc, and the create)', async () => {
  const launched = await start('confirm-normal');
  const main = await launched.page('main');
  const confirm = main.getByRole('button', { name: /^Bloquear / });
  await confirm.focus();
  await main.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(main.getByRole('textbox', { name: FIELD })).toBeFocused();

  // Open it again and create: the card goes, the block shows, the focus is somewhere real.
  await main.keyboard.press('Enter');
  await expect(main.getByRole('button', { name: /^Bloquear / })).toBeFocused();
  await main.keyboard.press('Enter');
  await expect(main.getByRole('timer').first()).toBeVisible();
  await expectFocusSomewhere(main, 'after the create closed the card');
});

test('a create that times out keeps the focus on the card', async () => {
  const launched = await start('pending');
  const main = await launched.page('main');
  // Shown from the tray: «Bloqueando…» (aria-disabled, still focusable) has the focus.
  await launched.harness.hideMain();
  await launched.harness.showMain();
  const pending = main.getByRole('button', { name: 'Bloqueando…' });
  await expect(pending).toBeFocused();
  await launched.harness.advance(3_100);
  await expect(visibleText(main, /El guardián no responde/)).toBeVisible();
  await expectFocusSomewhere(main, 'after the create timed out');
});

test('Emergencia: the focus survives every stage (request → counting → ready → «¿Seguro?» → done)', async () => {
  test.setTimeout(90_000);
  const launched = await start('one-block');
  const main = await launched.page('main');
  await main.getByRole('button', { name: 'Desbloqueo de emergencia…' }).click();
  const detail = await detailPage(launched);
  const intro = detail.getByText(/^Escribe a mano esta frase:/);
  const phrase = /«(.+)»/.exec((await intro.textContent()) ?? '')?.[1] ?? '';
  expect(phrase, 'commitment phrase').toBeTruthy();
  const field = detail.getByRole('textbox', { name: 'Frase de compromiso' });
  await field.focus();
  await field.pressSequentially(phrase, { delay: 0 });
  await expect(detail.getByText('Coincide')).toBeVisible();

  // Request by keyboard: the button goes away, the focus must not.
  const request = detail.getByRole('button', { name: /^Empezar la espera/ });
  await request.focus();
  await detail.keyboard.press('Enter');
  await expect(detail.getByRole('button', { name: /^Cancelar \(recomendado\)/ })).toBeVisible();
  await expectFocusSomewhere(detail, 'Emergencia: after starting the wait');

  // Counting → ready.
  const snapshot = await launched.harness.snapshot();
  const readyAt = Date.parse(snapshot.state?.emergency?.readyAt ?? '');
  const now = snapshot.harness?.frozenNowMs ?? NaN;
  expect(Number.isFinite(readyAt - now)).toBe(true);
  await detail.getByRole('button', { name: /^Cancelar \(recomendado\)/ }).focus();
  await advanceInSteps(launched, readyAt - now + 1_000, 2_500);
  const unlock = detail.getByRole('button', { name: /Desbloquear/ });
  await expect(unlock).toBeVisible();
  await expectFocusSomewhere(detail, 'Emergencia: when the wait ended');

  // «¿Seguro?» in place, then the result.
  await unlock.focus();
  await detail.keyboard.press('Enter');
  await expect(unlock).toHaveAccessibleName(/^¿Seguro\?/);
  await detail.keyboard.press('Enter');
  await expect(detail.getByText(/^Has perdido/)).toBeVisible();
  await expectFocusSomewhere(detail, 'Emergencia: after «Desbloquear»');
});

test('Ajustes: «Copiado» and BORRAR update in place without late live regions', async () => {
  const launched = await start('idle');
  const main = await launched.page('main');
  await main.getByRole('button', { name: /^Ajustes/ }).click();
  const detail = await detailPage(launched);
  await detail.getByRole('button', { name: /^Copiar diagnóstico/ }).click();
  await expect(detail.getByText(/^Copiado/)).toBeVisible();
  await detail.getByRole('textbox', { name: /BORRAR/ }).fill('BORRAR');
  await expect(detail.getByRole('button', { name: /^Borrar$/ })).toBeEnabled();
});

test('typing: the chips and «No he entendido» update in place without late live regions', async () => {
  const launched = await start('idle');
  const main = await launched.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await field.pressSequentially('no veo YouTube mañana tarde', { delay: 0 });
  await expect(main.getByText(/No he entendido/)).toBeVisible();
  await field.fill('');
  await field.pressSequentially('no veo YouTube en una hora', { delay: 0 });
  await expect(main.getByRole('button', { name: /YouTube/ }).first()).toBeVisible();
});

test('the countdown speaks at 15, 5 and 1 min from a region that was there from the start', async () => {
  test.setTimeout(180_000);
  const launched = await start('one-block');
  const main = await launched.page('main');
  const snapshot = await launched.harness.snapshot();
  const now = snapshot.harness?.frozenNowMs ?? NaN;
  const endsAt = Math.max(
    ...(snapshot.state?.blocks ?? []).map((b) => Date.parse(b.endsAt)).filter(Number.isFinite),
  );
  expect(Number.isFinite(endsAt - now)).toBe(true);
  // The big countdown's own polite region (not the timer, which is never live).
  const speech = main.locator('.c-countdown').first().locator('[aria-live="polite"]');
  // It says nothing until a mark is crossed, then keeps its last sentence until the next.
  let said = '';
  let at = now;
  for (const minutes of [15, 5, 1]) {
    // 30 s before the mark, then 30 s past it.
    const target = endsAt - minutes * 60_000 - 30_000;
    await advanceInSteps(launched, target - at, 2_500);
    at = target;
    await expect(speech).toHaveText(said);
    await advanceInSteps(launched, 60_000, 2_500);
    at += 60_000;
    said = SHARED_ES.remaining.announce(minutes);
    await expect(speech).toHaveText(said);
  }
});

// ---------------------------------------------------------------------------------------
// Media: reduced motion, forced colors
// ---------------------------------------------------------------------------------------

test('prefers-reduced-motion: no transitions anywhere', async () => {
  const launched = await start('confirm-normal');
  const main = await launched.page('main');
  const durations = () =>
    main.evaluate(() => {
      const out: Record<string, string> = {};
      for (const el of document.querySelectorAll('*')) {
        for (const pseudo of [null, '::before', '::after'] as const) {
          const style = getComputedStyle(el, pseudo);
          const moving = style.transitionDuration
            .split(',')
            .concat(style.animationDuration.split(','))
            .some((d) => parseFloat(d) > 0);
          if (moving) {
            const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '';
            out[`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${pseudo ?? ''}`] =
              `${style.transitionDuration} / ${style.animationDuration}`;
          }
        }
      }
      return out;
    });
  // Sanity: without the preference, the tiles do have their 100 ms hover transition.
  await main.emulateMedia({ reducedMotion: 'no-preference' });
  expect(Object.keys(await durations()).some((k) => k.startsWith('button.c-tile'))).toBe(true);

  await main.emulateMedia({ reducedMotion: 'reduce' });
  expect(await main.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  expect(await durations()).toEqual({});
});

test('forced-colors: tiles keep their border and the selected tile its outline', async () => {
  const launched = await start('confirm-normal');
  const main = await launched.page('main');
  await main.emulateMedia({ forcedColors: 'active' });
  expect(await main.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  const report = await main.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0;
    const drawn = (style: CSSStyleDeclaration, side: 'Top' | 'Bottom') =>
      style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
      parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) >= 1 &&
      !/rgba\(.*,\s*0\)$|transparent/.test(
        style.getPropertyValue(`border-${side.toLowerCase()}-color`),
      );
    const tiles = [...document.querySelectorAll('.c-tile')].filter(visible);
    const borderless = tiles
      .filter((t) => {
        const style = getComputedStyle(t);
        return !drawn(style, 'Top') || !drawn(style, 'Bottom');
      })
      .map((t) => (t.textContent ?? '').trim());
    const selected = tiles.filter(
      (t) => t.getAttribute('aria-checked') === 'true' || t.getAttribute('aria-pressed') === 'true',
    );
    const unoutlined = selected
      .filter((t) => {
        const before = getComputedStyle(t, '::before');
        return (
          before.content === 'none' ||
          parseFloat(before.borderTopWidth) < 2 ||
          before.borderTopStyle === 'none' ||
          /rgba\(.*,\s*0\)$|transparent/.test(before.borderTopColor)
        );
      })
      .map((t) => (t.textContent ?? '').trim());
    return { tiles: tiles.length, selected: selected.length, borderless, unoutlined };
  });
  expect(report.tiles).toBeGreaterThan(0);
  expect(report.selected).toBeGreaterThan(0);
  expect(report.borderless, 'tiles without a border in forced colors').toEqual([]);
  expect(report.unoutlined, 'selected tiles without their outline in forced colors').toEqual([]);
});
