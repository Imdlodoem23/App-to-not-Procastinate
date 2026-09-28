import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({ permissions: ['camera'], colorScheme: scheme, viewport: { width: 1150, height: 1000 } });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text()); });
  await page.goto('http://127.0.0.1:5199/');
  await page.click('#start-camera');
  await page.waitForTimeout(14000);
  await page.screenshot({ path: `${process.env.SP}/demo-${scheme}.png`, fullPage: true });
  await page.click('#stop');
  await page.waitForTimeout(1000);
  await context.close();
}
await browser.close();
