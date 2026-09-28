/**
 * Stills for the web (PROMPT.md §11 «Material visual»): the curated harness states of
 * media.json, in light and dark, at the scale factor of media.json, from the real app on
 * its fake display. Detail states (Bloqueos, Emergencia…) keep the detail window only.
 *
 * Writes `stills/<state>-<theme>.png` and `stills/index.json` to MARKETING_OUT; encode.mjs
 * turns them into AVIF and WebP.
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { ThemeName } from '@centrate/shared/design/tokens';
import { harnessFixture, type HarnessStateId } from '../../apps/desktop/src/shared/fixtures';
import { CONFIG, LANG, freshDir, wanted, writeJson } from './lib/config';
import { checkFont, launchDesktop, settled } from './lib/desktop';
import { assertNeutralIcons, pngSize } from './lib/recorder';

const THEMES = ['light', 'dark'] as const;

test('stills', async () => {
  test.skip(!wanted('stills'), 'not in MARKETING_ONLY');
  const dir = freshDir('stills');
  const app = await launchDesktop('idle', 'light');
  try {
    const font = await checkFont(app);
    /** `load` waits for every open window; one retry covers a window slow to answer. */
    const loadFixture = async (state: HarnessStateId, theme: ThemeName): Promise<void> => {
      const options = { display: CONFIG.display, theme, lang: LANG };
      try {
        await app.harness.load(state, options);
      } catch (error) {
        console.warn(`[stills] ${state} ${theme}: ${String(error)}; loading it again.`);
        await app.harness.load(state, options);
      }
    };
    const entries = [];
    for (const theme of THEMES) {
      for (const still of CONFIG.stills) {
        const fixture = harnessFixture(still.state);
        await loadFixture(still.state, theme);
        await settled(app, 'main');
        const kind = fixture.window === 'main' ? 'main' : 'detail';
        if (kind === 'detail') {
          await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
          await settled(app, 'detail');
        }
        const page = await app.page(kind);
        await assertNeutralIcons(page, { requireSwitch: true });
        const png = await page.screenshot({
          scale: 'device',
          animations: 'disabled',
          caret: 'hide',
        });
        const file = `${still.state}-${theme}.png`;
        writeFileSync(join(dir, file), png);
        entries.push({
          state: still.state,
          theme,
          window: fixture.window,
          label: fixture.label,
          alt: still.alt[LANG],
          file,
          ...pngSize(png),
        });
      }
    }
    writeJson(join(dir, 'index.json'), {
      lang: LANG,
      scaleFactor: CONFIG.scaleFactor,
      font,
      entries,
    });
  } finally {
    await app.close();
  }
});
