/**
 * SURFACES in the real app (PROMPT §10 «Bandeja y otras superficies», «Pie»; docs/DESKTOP.md
 * §15): what the mini timer, the OSD and the Nuclear overlay draw, and the footer's Phase 5
 * controls.
 *
 * - `mini-timer`: the 180×44 box with 8 px corners over a transparent window, the service icon,
 *   the time at 20 px («42:10», «Quedan 43 minutos»), the whole box a drag region, nothing
 *   clipped; axe clean in both themes.
 * - `osd`: «+15 min · hasta las 17:57» on a black 60 % pill, radius 8, white 28 px at 600,
 *   centred in its transparent window; axe clean.
 * - `nuclear`: «Castigo · vuelves a las 18:40» over the 72 px countdown and one secondary
 *   «Salida de emergencia»: the first press arms it with the price on the help line, the second
 *   opens Emergencia; axe clean in both themes.
 * - English (`--harness-lang=en`): each surface in the OS language;
 * - footer: «Mini temporizador» fits and toggles the mini timer (pressed while it shows);
 *   `update-available`: «Actualizar a v0.2.0» is a button whose answer lands on the help line.
 *
 * PLATFORM owns the windows themselves (size, focus, placement: `platform.spec.ts`).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import type { ThemeName } from '@centrate/shared/design/tokens';
import { HARNESS_GLOBAL } from '../src/main/contracts';
import type { HarnessStateId } from '../src/shared/fixtures';
import type { SurfaceKind } from '../src/shared/ui-state';
import { launchApp, type LaunchedApp } from './support/app';
import { axeViolations, formatViolations, probeLayout } from './support/checks';
import { auditKeyboard, auditProblems } from './support/keyboard';
import { expect, test } from './support/test';

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

function openSurface(electron: ElectronApplication, kind: SurfaceKind): Promise<void> {
  return electron.evaluate(
    async (_e, input) => {
      const api = (globalThis as Record<string, unknown>)[input.key] as {
        openSurface(kind: string): Promise<void>;
      };
      await api.openSurface(input.kind);
    },
    { key: HARNESS_GLOBAL, kind },
  );
}

/** Launches `state` in `theme`, shows its surface and returns its page once rendered. */
async function surface(
  state: HarnessStateId,
  kind: SurfaceKind,
  theme: ThemeName = 'light',
  args: string[] = [],
): Promise<{ launched: LaunchedApp; page: Page }> {
  const launched = await launchApp({ state, theme, args });
  app = launched;
  await openSurface(launched.electron, kind);
  await expect
    .poll(() => launched.electron.windows().some((p) => p.url().includes(`window=${kind}`)), {
      timeout: 15_000,
    })
    .toBe(true);
  const page = launched.electron.windows().find((p) => p.url().includes(`window=${kind}`));
  if (!page) throw new Error(`no ${kind} page`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('html')).toHaveAttribute('data-harness-ready', state);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { launched, page };
}

/** The forced theme reaches the surface (main drives `prefers-color-scheme` with it). */
async function expectTheme(page: Page, theme: ThemeName): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
    .toBe(theme === 'dark');
}

async function expectNoClipping(page: Page): Promise<void> {
  const probe = await probeLayout(page);
  expect(probe.clipped, JSON.stringify(probe.clipped)).toEqual([]);
  expect(probe.document.scrollWidth).toBeLessThanOrEqual(probe.document.clientWidth);
  expect(probe.document.scrollHeight).toBeLessThanOrEqual(probe.document.clientHeight);
}

async function expectAxeClean(page: Page): Promise<void> {
  const violations = await axeViolations(page);
  expect(violations, formatViolations(violations)).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`mini timer: icon, 20 px time and drag region (${theme})`, async () => {
    const { page } = await surface('mini-timer', 'mini-timer', theme);
    const box = page.locator('main.mt');
    await expect(box).toBeVisible();
    await expectTheme(page, theme);

    const timer = box.getByRole('timer');
    await expect(timer).toHaveText('42:10');
    await expect(timer).toHaveAttribute('aria-label', 'Quedan 43 minutos');
    await expect(box.locator('.mt-monogram')).toHaveText('YT');
    await expect(page.getByRole('main', { name: 'Mini temporizador' })).toBeVisible();
    await expect(box.locator('.sr-only').first()).toHaveText('Mini temporizador');

    const look = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('main.mt');
      const digits = document.querySelector<HTMLElement>('.mt .c-countdown-digits');
      if (!main || !digits) throw new Error('missing mini timer parts');
      const m = getComputedStyle(main);
      const d = getComputedStyle(digits);
      const rect = main.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        radius: m.borderTopLeftRadius,
        drag: m.getPropertyValue('-webkit-app-region') || m.getPropertyValue('app-region'),
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        boxBg: m.backgroundColor,
        fontSize: d.fontSize,
        fontWeight: d.fontWeight,
        numeric: d.fontVariantNumeric,
      };
    });
    expect(look).toMatchObject({
      width: 180,
      height: 44,
      radius: '8px',
      drag: 'drag',
      htmlBg: 'rgba(0, 0, 0, 0)',
      bodyBg: 'rgba(0, 0, 0, 0)',
      fontSize: '20px',
      fontWeight: '600',
      numeric: 'tabular-nums',
    });
    expect(look.boxBg).not.toBe('rgba(0, 0, 0, 0)');

    await expectNoClipping(page);
    await expectAxeClean(page);
    expect(auditProblems(await auditKeyboard(page))).toEqual([]);
  });
}

test('OSD: black 60 % pill, radius 8, white 28 px at 600, centred', async () => {
  const { page } = await surface('osd', 'osd');
  const pill = page.locator('.osd-pill');
  await expect(pill).toHaveText('+15 min · hasta las 17:57');
  await expect(page.getByRole('status')).toContainText('+15 min · hasta las 17:57');

  const look = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.osd-pill');
    const text = document.querySelector<HTMLElement>('.osd-text');
    if (!el || !text) throw new Error('no pill');
    const s = getComputedStyle(el);
    const t = getComputedStyle(text);
    const rect = el.getBoundingClientRect();
    return {
      bg: s.backgroundColor,
      color: t.color,
      radius: s.borderTopLeftRadius,
      fontSize: t.fontSize,
      fontWeight: t.fontWeight,
      height: rect.height,
      centreOffset: Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2),
      verticalOffset: Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2),
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      iconSize: document.querySelector('.osd-icon svg')?.getAttribute('width') ?? null,
    };
  });
  expect(look).toMatchObject({
    bg: 'rgba(0, 0, 0, 0.6)',
    color: 'rgb(255, 255, 255)',
    radius: '8px',
    fontSize: '28px',
    fontWeight: '600',
    height: 64,
    htmlBg: 'rgba(0, 0, 0, 0)',
    iconSize: '20',
  });
  expect(look.centreOffset).toBeLessThanOrEqual(1);
  expect(look.verticalOffset).toBeLessThanOrEqual(1);

  await expectNoClipping(page);
  await expectAxeClean(page);
  expect(auditProblems(await auditKeyboard(page))).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Nuclear: 72 px countdown and one «Salida de emergencia» (${theme})`, async () => {
    const { launched, page } = await surface('nuclear', 'nuclear', theme);
    await expectTheme(page, theme);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(
      'Castigo · vuelves a las 18:40',
    );
    const timer = page.getByRole('timer');
    await expect(timer).toHaveText('1:40:00');
    await expect(timer).toHaveAttribute('aria-label', 'Quedan 1 hora y 40 minutos');
    await expect(page.locator('.nuc-cause')).toHaveText('3 strikes en "mates"·−100 puntos');

    const buttons = page.getByRole('button');
    await expect(buttons).toHaveCount(1);
    const exit = buttons.first();
    await expect(exit).toHaveText('Salida de emergencia');

    const look = await page.evaluate(() => {
      const digits = document.querySelector<HTMLElement>('.nuc-countdown .c-countdown-digits');
      const tile = document.querySelector<HTMLElement>('.nuc-exit .c-tile');
      const nuc = document.querySelector<HTMLElement>('.nuc');
      if (!digits || !tile || !nuc) throw new Error('missing Nuclear parts');
      const bgVar = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const probe = document.createElement('span');
      probe.style.color = bgVar;
      document.body.append(probe);
      const bg = getComputedStyle(probe).color;
      probe.remove();
      return {
        fontSize: getComputedStyle(digits).fontSize,
        fontWeight: getComputedStyle(digits).fontWeight,
        tileHeight: tile.getBoundingClientRect().height,
        tileSurface: tile.dataset['surface'] ?? null,
        background: getComputedStyle(nuc).backgroundColor,
        themeBg: bg,
      };
    });
    expect(look).toMatchObject({
      fontSize: '72px',
      fontWeight: '600',
      tileHeight: 32,
      tileSurface: 'tile-2',
    });
    expect(look.background).toBe(look.themeBg);

    await expectNoClipping(page);
    await expectAxeClean(page);
    expect(auditProblems(await auditKeyboard(page))).toEqual([]);
    await expect(exit).toHaveAttribute('aria-keyshortcuts', 'Alt+E');

    // First press: «¿Seguro?», the price in red on the help line; nothing opens yet.
    const help = page.locator('#nuclear-exit-help');
    await expect(help).toHaveText('Abre el desbloqueo de emergencia: espera de 30 min');
    // Alt + E presses it like a click (PROMPT §10: «Alt + letra en cada tile»).
    await page.keyboard.press('Alt+E');
    await expect(exit).toHaveText('¿Seguro? Salida de emergencia');
    await expect(help).toHaveText('Perderás 547 puntos y tu racha de 5 días · espera de 30 min');
    await expect(help).toHaveAttribute('data-tone', 'red');
    expect((await launched.harness.bounds()).detail?.visible ?? false).toBe(false);
    await expectAxeClean(page);

    // Second press within 3 s: Emergencia opens above the overlay.
    await exit.click();
    await expect
      .poll(async () => (await launched.harness.bounds()).detail?.visible ?? false, {
        timeout: 10_000,
      })
      .toBe(true);
    const detail = await launched.page('detail');
    await expect(detail.locator('#detail-title')).toHaveText(/Emergencia/);
  });
}

test('an English system shows every surface in English', async () => {
  const lang = ['--harness-lang=en'];
  let { page } = await surface('mini-timer', 'mini-timer', 'light', lang);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('main', { name: 'Mini timer' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveAttribute('aria-label', /left$/);
  await expectNoClipping(page);
  await app?.close();

  ({ page } = await surface('osd', 'osd', 'light', lang));
  await expect(page.locator('.osd-pill')).toHaveText('+15 min · until 5:57 PM');
  await expectNoClipping(page);
  await app?.close();

  ({ page } = await surface('nuclear', 'nuclear', 'light', lang));
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Penalty · back at 6:40 PM');
  await expect(page.getByRole('button')).toHaveText('Emergency exit');
  await expect(page.locator('#nuclear-exit-help')).toHaveText(
    'Opens the emergency unlock: 30 min wait',
  );
  await expectNoClipping(page);
  await expectAxeClean(page);
});

test('footer: «Mini temporizador» fits and toggles the mini timer', async () => {
  const launched = await launchApp({ state: 'idle', show: true });
  app = launched;
  const main = await launched.page('main');
  await expect(main.locator('html')).toHaveAttribute('data-harness-ready', 'idle');
  const button = main.locator('[data-row-tile="pie"][data-tile-id="miniTimer"]');
  await expect(button).toHaveText('Mini temporizador');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Alt+Z');

  const fit = await main.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.main-footer .c-tile-label')].map((el) => ({
      text: el.textContent,
      over: el.scrollWidth - el.clientWidth,
    })),
  );
  for (const label of fit) expect(label.over, label.text ?? '').toBeLessThanOrEqual(0);
  const probe = await probeLayout(main);
  expect(probe.clipped.filter((c) => c.element.includes('c-tile-label'))).toEqual([]);

  await button.click();
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.miniTimer.visible)
    .toBe(true);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => launched.electron.windows().some((p) => p.url().includes('window=mini-timer')))
    .toBe(true);

  await button.click();
  await expect
    .poll(async () => (await launched.harness.snapshot()).prefs.miniTimer.visible)
    .toBe(false);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('footer: «Actualizar a v0.2.0» is a button that answers on the help line', async () => {
  const launched = await launchApp({ state: 'update-available', show: true });
  app = launched;
  const main = await launched.page('main');
  await expect(main.locator('html')).toHaveAttribute('data-harness-ready', 'update-available');
  const update = main.getByRole('button', { name: 'Actualizar a v0.2.0' });
  await expect(update).toBeVisible();
  await expect(update).toHaveAttribute('data-tone', 'blue');
  await expectNoClipping(main);
  await update.click();
  await expect(main.locator('#pie-help')).toHaveText(
    'Reiniciando para actualizar. Los bloqueos siguen activos',
  );
  await expectAxeClean(main);
});
