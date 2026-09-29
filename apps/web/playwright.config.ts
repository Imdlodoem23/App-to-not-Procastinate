/**
 * Quality checks of the built site (tests/quality.spec.ts): axe-core, layout, SEO tags and the
 * screenshot matrix of the brief (§ 11, acceptance criteria). Run after a build:
 *
 *   npm run build -w apps/web && npm run test:quality -w apps/web
 *
 * In this cloud container: PW_CHROMIUM_PATH=/opt/pw-browsers/chromium. In CI,
 * `npx playwright install --with-deps chromium` provides the browser.
 */
import { defineConfig } from '@playwright/test';

const port = 4321;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/output',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    // A Spanish browser: the English hint (Base.astro) only shows in the tests that ask for it.
    locale: 'es-ES',
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: `npx astro preview --port ${port}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
  },
});
