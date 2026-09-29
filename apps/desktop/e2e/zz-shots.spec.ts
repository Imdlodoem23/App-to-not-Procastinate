import { launchApp } from './support/app';
import { settleWindow } from './support/checks';
import { test } from './support/test';

const OUT = process.env['SHOTS_DIR'] ?? '/tmp';
const STATES = (process.env['SHOT_STATES'] ?? 'limits').split(',');

test('shots', async () => {
  test.setTimeout(300_000);
  for (const state of STATES) {
    const detail = state === 'limits' || state === 'limit-editor';
    const app = await launchApp({ state: state as never, show: true });
    for (const theme of ['light', 'dark'] as const) {
      await app.harness.load(state as never, { theme });
      const kind = detail ? 'detail' : 'main';
      await settleWindow(app, kind);
      const page = await app.page(kind);
      if (detail) {
        await page.evaluate(() =>
          document.querySelector('[data-section="blq-limits"]')?.scrollIntoView({ block: 'start' }),
        );
      }
      await page.screenshot({ path: `${OUT}/${state}-${theme}.png` });
      if (state === 'limit-editor') {
        await page.evaluate(() =>
          document.querySelector('[data-limit-editor]')?.lastElementChild?.scrollIntoView({ block: 'end' }),
        );
        await page.screenshot({ path: `${OUT}/${state}-${theme}-2.png` });
      }
    }
    await app.close();
  }
});
