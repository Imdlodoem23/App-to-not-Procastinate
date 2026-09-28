/**
 * Layout matrix (PROMPT §10 «Criterios de aceptación», docs/DESKTOP.md §8.3, §12): every
 * harness fixture on every display preset of the screenshot matrix, rendered by the real app
 * on the harness's fake display (one app per scale factor, fixtures switched in-process).
 *
 * For each state × preset (one step each; a failing step does not hide the others):
 * - the main window never scrolls: no scroll mode, `scrollHeight <= clientHeight` for the
 *   document and the section column;
 * - no clipped text (`[data-fit]` and every text element that clips its overflow);
 * - 440 DIP wide, 10 DIP from the work area on its anchored corner;
 * - on the fixture's own preset, the density the fixture expects;
 * - on 1920×1080 at 100 %: content ≤ 540 DIP at rest and ≤ 600 in any state;
 * - detail fixtures: the detail window is shown beside the main window, inside the work area,
 *   600 DIP wide, with no horizontal overflow or clipped text (it may scroll vertically).
 */
import { DISPLAY_PRESETS, SCREEN_INSET, type DisplayPresetId } from '../src/shared/fixtures';
import type { HarnessFixture } from '../src/shared/fixtures';
import type { LaunchedApp } from './support/app';
import {
  BUDGET_PRESET,
  EXPECTED_ANCHOR,
  HEIGHT_ANY_STATE,
  HEIGHT_AT_REST,
  isRestState,
  probeLayout,
  settleMain,
} from './support/checks';
import { presetsByScale, selectedFixtures } from './support/matrix';
import { expect, test } from './support/test';

/**
 * Electron on X11 with a fractional `--force-device-scale-factor` makes every window 1–2 DIP
 * wider than asked, whatever the bounds call (checked with `setBounds` and aligned origins:
 * 440 → 441 DIP content, 442 CSS px viewport at 125 %). Tolerated there only; integer scales
 * and Windows/macOS must be exact.
 */
function widthTolerance(scaleFactor: number): number {
  return process.platform === 'linux' && !Number.isInteger(scaleFactor) ? 2 : 0;
}

async function checkLayout(
  app: LaunchedApp,
  fixture: HarnessFixture,
  presetId: DisplayPresetId,
): Promise<void> {
  const soft = expect.soft;
  const where = `${fixture.id} on ${presetId}`;
  await app.harness.load(fixture.id, { display: presetId, theme: 'light' });
  const settle = await settleMain(app);
  soft(settle.settled, `${where}: the window did not settle (${settle.detail})`).toBe(true);
  const main = await app.page('main');
  const probe = await probeLayout(main);
  const bounds = await app.harness.bounds();

  // No scroll, no clipped text.
  soft(probe.scrollMode, `${where}: the section column switched to scroll`).toBe(false);
  soft(probe.document.scrollHeight, `${where}: document scrollHeight`).toBeLessThanOrEqual(
    probe.document.clientHeight,
  );
  soft(probe.document.scrollWidth, `${where}: document scrollWidth`).toBeLessThanOrEqual(
    probe.document.clientWidth,
  );
  soft(probe.column, `${where}: no section column ([data-scroll-root])`).not.toBeNull();
  if (probe.column) {
    soft(probe.column.scrollHeight, `${where}: section column scrollHeight`).toBeLessThanOrEqual(
      probe.column.clientHeight,
    );
  }
  soft(probe.clipped, `${where}: clipped text`).toEqual([]);

  // 440 DIP wide, anchored 10 DIP from the work area's corner.
  const outer = bounds.main?.outer;
  const content = bounds.main?.content;
  const wa = bounds.display.workArea;
  expect(outer && content, `${where}: main window bounds`).toBeTruthy();
  if (!outer || !content) return;
  soft(bounds.main?.visible, `${where}: main window shown`).toBe(true);
  const tolerance = widthTolerance(app.scaleFactor);
  soft(
    Math.abs(content.width - 440),
    `${where}: content bounds width ${content.width} DIP (want 440)`,
  ).toBeLessThanOrEqual(tolerance);
  soft(
    Math.abs(probe.width - 440),
    `${where}: viewport width ${probe.width} CSS px (want 440)`,
  ).toBeLessThanOrEqual(tolerance);
  soft(wa.x + wa.width - (outer.x + outer.width), `${where}: right inset`).toBe(SCREEN_INSET);
  if (EXPECTED_ANCHOR === 'bottom') {
    soft(wa.y + wa.height - (outer.y + outer.height), `${where}: bottom inset`).toBe(SCREEN_INSET);
  } else {
    soft(outer.y - wa.y, `${where}: top inset`).toBe(SCREEN_INSET);
  }
  soft(outer.y, `${where}: top edge inside the work area`).toBeGreaterThanOrEqual(
    wa.y + SCREEN_INSET,
  );

  if (presetId === fixture.display) {
    soft(probe.density, `${where}: density`).toBe(fixture.expect.density);
  }
  if (presetId === BUDGET_PRESET) {
    const budget = isRestState(fixture) ? HEIGHT_AT_REST : HEIGHT_ANY_STATE;
    soft(content.height, `${where}: content height (budget ${budget})`).toBeLessThanOrEqual(budget);
  }

  if (fixture.window === 'main') return;
  const detailBounds = bounds.detail;
  soft(detailBounds?.visible, `${where}: detail window shown`).toBe(true);
  soft(
    Math.abs((detailBounds?.content.width ?? 0) - 600),
    `${where}: detail width ${detailBounds?.content.width} DIP (want 600)`,
  ).toBeLessThanOrEqual(tolerance);
  const detailOuter = detailBounds?.outer;
  if (detailOuter) {
    const overlaps =
      detailOuter.x < outer.x + outer.width && outer.x < detailOuter.x + detailOuter.width;
    soft(overlaps, `${where}: detail overlaps the main window`).toBe(false);
    soft(detailOuter.x, `${where}: detail left edge`).toBeGreaterThanOrEqual(wa.x);
    soft(detailOuter.y, `${where}: detail top edge`).toBeGreaterThanOrEqual(wa.y);
    soft(detailOuter.y + detailOuter.height, `${where}: detail bottom edge`).toBeLessThanOrEqual(
      wa.y + wa.height,
    );
  }
  const detail = await app.page('detail');
  const detailProbe = await probeLayout(detail);
  soft(detailProbe.document.scrollWidth, `${where}: detail scrollWidth`).toBeLessThanOrEqual(
    detailProbe.document.clientWidth,
  );
  soft(detailProbe.clipped, `${where}: detail clipped text`).toEqual([]);
}

const fixtures = selectedFixtures();

for (const group of presetsByScale()) {
  for (const presetId of group.presets) {
    test(`layout ${presetId} (${DISPLAY_PRESETS[presetId].label})`, async ({ apps }) => {
      test.setTimeout(30_000 + fixtures.length * 5_000);
      const app = await apps.at(group.scaleFactor);
      for (const fixture of fixtures) {
        await test.step(fixture.id, () => checkLayout(app, fixture, presetId));
      }
    });
  }
}

/**
 * Fixtures that arm an in-place «¿Seguro?» (`main.armed` / `detail.armed`, e.g.
 * `emergency-ready`) must render it armed once loaded, detail window retargeted and shown:
 * red outline (`data-outline="armed"`), label «¿Seguro? …» and the consequence in red on the
 * row's help line. The screenshot matrix shows exactly this state, always after another
 * fixture: so each one is loaded after a main-window fixture and after a detail one (the
 * retarget and the show must not disarm it).
 */
const armedFixtures = fixtures.filter((f) => f.main.armed !== null || f.detail.armed !== null);

test('armed fixtures render the in-place «¿Seguro?»', async ({ apps }) => {
  test.skip(armedFixtures.length === 0, 'no armed fixture selected');
  const combos = armedFixtures.flatMap((fixture) =>
    (['idle', 'emergencia'] as const).map((before) => ({ fixture, before })),
  );
  for (const { fixture, before } of combos) {
    await test.step(`${before} → ${fixture.id}`, async () => {
      const app = await apps.at(DISPLAY_PRESETS[fixture.display].scaleFactor);
      await app.harness.load(before, { display: fixture.display, theme: 'light' });
      await settleMain(app);
      await app.harness.load(fixture.id, { display: fixture.display, theme: 'light' });
      await settleMain(app);
      const kind = fixture.detail.armed !== null && fixture.window !== 'main' ? 'detail' : 'main';
      if (kind === 'detail') {
        await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
      }
      const page = await app.page(kind);
      const armed = page.locator('.c-tile[data-outline="armed"]');
      const where = `${fixture.id} after ${before}`;
      await expect.soft(armed, `${where}: one armed tile (red outline)`).toHaveCount(1);
      await expect.soft(armed.first(), `${where}: «¿Seguro? …» label`).toHaveText(/^¿Seguro\?/);
      const help =
        (await armed.count()) === 1 ? await armed.first().getAttribute('aria-describedby') : null;
      if (help) {
        await expect
          .soft(page.locator(`[id="${help}"]`), `${where}: consequence in red`)
          .toHaveAttribute('data-tone', 'red');
      }
    });
  }
});
