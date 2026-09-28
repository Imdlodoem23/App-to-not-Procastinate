/**
 * Performance criteria of PROMPT §10 «Tiene que cumplirse»:
 * - tray click → window shown with the focus in the field in < 150 ms, and no white flash
 *   (the window's native background and the page are the theme's `bg` before the first show);
 * - the countdown drifts ≤ 1 s over an hour: computed from the guardian's `endsAt` on the
 *   harness's frozen clock, and ticked by the renderer's own timer chain over a simulated hour
 *   (Playwright's fake clock in the renderer, mock guardian);
 * - hidden, the app stays under 1 % CPU (sampled over `E2E_CPU_WINDOW_MS`, 10 s by default;
 *   the nightly run can pass 60 000).
 */
import { colors } from '@centrate/shared/design/tokens';
import { UI_TIMINGS, primaryBlock } from '../src/shared/ui-state';
import { splitCountdown } from '../src/shared/format';
import { launchApp, type LaunchedApp } from './support/app';
import { expect, test } from './support/test';

const FIELD = '¿Qué quieres hacer?';
const SHOWS = 5;

let app: LaunchedApp | null = null;

test.afterEach(async () => {
  await app?.close();
  app = null;
});

/** «1:02:03» / «42:10» → seconds. */
function seconds(text: string): number {
  return text
    .trim()
    .split(':')
    .map(Number)
    .reduce((acc, n) => acc * 60 + n, 0);
}

/** `#RRGGBB` → `rgb(r, g, b)` as `getComputedStyle` reports it. */
function cssRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

for (const theme of ['light', 'dark'] as const) {
  test(`tray show → field focused in < ${UI_TIMINGS.showBudgetMs} ms, no white flash (${theme})`, async () => {
    app = await launchApp({ state: 'idle', theme, show: false });
    const main = await app.page('main');
    const field = main.getByRole('textbox', { name: FIELD });
    const bg = colors[theme].bg;

    // Before the first show: native background and page background are the theme's.
    const native = await app.electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((w) => w.webContents.getURL().includes('window=main'))
        .map((w) => ({ color: w.getBackgroundColor(), visible: w.isVisible() })),
    );
    expect(native).toHaveLength(1);
    expect(native[0]?.visible, 'starts hidden').toBe(false);
    expect(native[0]?.color.toUpperCase()).toBe(bg.toUpperCase());
    expect(await main.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      cssRgb(bg),
    );

    const timings: number[] = [];
    for (let i = 0; i < SHOWS; i += 1) {
      timings.push(await app.harness.showMain());
      await expect(field).toBeFocused();
      app.harness.hideMain();
      await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(false);
    }
    test.info().annotations.push({
      type: 'show ms',
      description: timings.map((t) => t.toFixed(1)).join(', '),
    });
    expect(Math.max(...timings), `show timings: ${timings.join(', ')}`).toBeLessThan(
      UI_TIMINGS.showBudgetMs,
    );

    // The tray click toggles through the same show path.
    await app.harness.trayClick();
    await expect.poll(async () => (await app?.harness.bounds())?.main?.visible).toBe(true);
    await expect(field).toBeFocused();
  });
}

test('countdown = endsAt − now over an hour of the frozen clock (irregular steps)', async () => {
  test.setTimeout(120_000);
  app = await launchApp({ state: 'three-blocks', show: true });
  const main = await app.page('main');
  const timer = main.getByRole('timer').first();
  const expected = async (): Promise<string> => {
    const snapshot = await app!.harness.snapshot();
    const block = primaryBlock(snapshot.state);
    const now = snapshot.harness?.frozenNowMs;
    if (!block || typeof now !== 'number') throw new Error('no active block');
    return splitCountdown(Date.parse(block.endsAt) - now).text;
  };

  // Deterministic «random» steps of 1.0–2.9 s (under the 3 s request timeout), off the second.
  let seed = 7;
  const nextStep = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return 1_001 + (seed % 1_900);
  };
  let elapsed = 0;
  let sinceCheck = 0;
  const hour = 60 * 60_000;
  const checks: string[] = [];
  while (elapsed < hour) {
    const step = Math.min(nextStep(), hour - elapsed);
    await app.harness.advance(step);
    elapsed += step;
    sinceCheck += step;
    if (sinceCheck >= 5 * 60_000 || elapsed >= hour) {
      sinceCheck = 0;
      const want = await expected();
      await expect(timer, `after ${Math.round(elapsed / 1000)} s`).toHaveText(want);
      checks.push(want);
    }
  }
  expect(checks.length).toBeGreaterThanOrEqual(12);
  // 2:10:05 at the start, one hour later 1:10:05.
  expect(seconds(checks.at(-1) ?? '')).toBe(seconds('1:10:05'));
});

test('the renderer timer chain drifts ≤ 1 s over a simulated hour (mock guardian)', async () => {
  test.setTimeout(240_000);
  app = await launchApp({ state: null });
  const main = await app.page('main');
  const field = main.getByRole('textbox', { name: FIELD });
  await expect(field).toBeVisible({ timeout: 15_000 });
  await field.fill('no veo YouTube dos horas');
  await field.press('Enter');
  await expect(main.getByRole('button', { name: /^Bloquear / })).toBeFocused();
  await main.keyboard.press('Enter');
  const timer = main.getByRole('timer').first();
  await expect(timer).toHaveText(/^(2:00:00|1:59:5\d)$/);

  // Fake the renderer's clock only (main and its guardian keep real time). The pending tick
  // was armed on the real clock: let it fire so the chain re-arms on the fake one, then pause
  // the fake clock so time moves only with runFor().
  await main.clock.install();
  await main.waitForTimeout(1_500);
  await main.clock.pauseAt((await main.evaluate(() => Date.now())) + 10);
  // React renders in a task after the timer that asked for it: yield one per simulated second.
  const yieldTask = (): Promise<unknown> =>
    main.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve(null);
          channel.port2.postMessage(0);
        }),
    );
  await main.clock.runFor(1_000);
  await yieldTask();
  const start = seconds((await timer.textContent()) ?? '');
  const t0 = await main.evaluate(() => Date.now());
  const drifts: number[] = [];
  for (let second = 1; second <= 3_600; second += 1) {
    await main.clock.runFor(1_000);
    await yieldTask();
    if (second % 300 !== 0) continue;
    const shown = seconds((await timer.textContent()) ?? '');
    const simulated = ((await main.evaluate(() => Date.now())) - t0) / 1000;
    drifts.push(Number((start - shown - simulated).toFixed(3)));
  }
  test.info().annotations.push({ type: 'drift s (every 5 min)', description: drifts.join(', ') });
  expect(drifts).toHaveLength(12);
  for (const drift of drifts) expect(Math.abs(drift)).toBeLessThanOrEqual(1);
});

test('hidden, the app stays under 1 % CPU', async () => {
  const windowMs = Number(process.env['E2E_CPU_WINDOW_MS']) || 10_000;
  test.setTimeout(windowMs + 60_000);
  app = await launchApp({ state: null, args: ['--hidden'] });
  // Let startup finish (pre-warmed detail window, first poll), then sample.
  await new Promise((r) => setTimeout(r, 4_000));
  const visible = await app.electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.isVisible()),
  );
  expect(visible, 'started with --hidden').toBe(false);
  const cpu = () =>
    app!.electron.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
    );
  await cpu(); // baseline: percentCPUUsage is measured since the previous call
  await new Promise((r) => setTimeout(r, windowMs));
  const percent = await cpu();
  test.info().annotations.push({ type: 'cpu %', description: percent.toFixed(3) });
  expect(percent).toBeLessThan(1);
});
