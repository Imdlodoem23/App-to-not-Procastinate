/**
 * axe-core on every harness fixture, light and dark (PROMPT §10 «0 fallos de axe-core»):
 * axe is injected with `page.evaluate` and run with `axe.run()` on the main window and, for
 * detail fixtures, on the detail window too. Each fixture renders on its own display preset
 * (compact density included); one app per scale factor, one step per state.
 */
import { DISPLAY_PRESETS, type HarnessFixture } from '../src/shared/fixtures';
import type { LaunchedApp } from './support/app';
import { axeViolations, formatViolations, settleMain } from './support/checks';
import { THEMES, selectedFixtures, type CaptureTheme } from './support/matrix';
import { expect, test } from './support/test';

async function checkA11y(
  app: LaunchedApp,
  fixture: HarnessFixture,
  theme: CaptureTheme,
): Promise<void> {
  await app.harness.load(fixture.id, { display: fixture.display, theme });
  await settleMain(app);
  const windows = fixture.window === 'main' ? (['main'] as const) : (['main', 'detail'] as const);
  for (const kind of windows) {
    const page = await app.page(kind);
    // The theme is on <html data-theme> (prefs) or the native theme (forced): both resolve
    // to the color scheme axe measures contrast in.
    await expect
      .soft(async () => {
        const scheme = await page.evaluate(() =>
          matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        );
        expect(scheme).toBe(theme);
      }, `${fixture.id} (${theme}) ${kind}: color scheme`)
      .toPass({ timeout: 2_000 });
    const violations = await axeViolations(page);
    expect
      .soft(violations, `${fixture.id} (${theme}) ${kind}:\n${formatViolations(violations)}`)
      .toEqual([]);
  }
}

/** Fixtures grouped by the scale factor of their own display (one launch per group). */
const byScale = new Map<number, HarnessFixture[]>();
for (const fixture of selectedFixtures()) {
  const scale = DISPLAY_PRESETS[fixture.display].scaleFactor;
  byScale.set(scale, [...(byScale.get(scale) ?? []), fixture]);
}

for (const [scaleFactor, fixtures] of [...byScale.entries()].sort(([a], [b]) => a - b)) {
  for (const theme of THEMES) {
    test(`axe ${theme} @${scaleFactor}x`, async ({ apps }) => {
      test.setTimeout(30_000 + fixtures.length * 8_000);
      const app = await apps.at(scaleFactor);
      for (const fixture of fixtures) {
        await test.step(`${fixture.id} (${theme})`, () => checkA11y(app, fixture, theme));
      }
    });
  }
}
