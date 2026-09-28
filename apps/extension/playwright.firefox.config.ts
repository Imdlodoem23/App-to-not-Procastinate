/**
 * Firefox smoke for the extension (e2e/firefox/): Playwright runs the tests, each of which
 * starts a real Firefox through geckodriver, installs the built extension as a temporary
 * add-on and drives it against the mock guardian (test/mock-guardian.ts).
 *
 *   npm run e2e:firefox -w apps/extension          # builds dist/ first
 *   GECKODRIVER_PATH=/path/geckodriver FIREFOX_BIN=/path/firefox npm run e2e:firefox -w apps/extension
 *
 * - geckodriver: `GECKODRIVER_PATH`, `$GECKOWEBDRIVER` (GitHub's images) or the PATH;
 *   Firefox: `FIREFOX_BIN` or the one geckodriver finds. Missing: skipped locally, a
 *   failure on CI.
 * - Headless unless `CENTRATE_E2E_HEADED=1` (Firefox's headless mode runs extensions).
 * - `CENTRATE_E2E_DIST` (the build) and `CENTRATE_E2E_FIREFOX_ADDON` (a zip or .xpi to
 *   install instead) as in e2e/firefox/harness.ts.
 * - Specs are `e2e/firefox/*.firefox.ts`; the Chromium config only takes `*.e2e.ts`.
 */
import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env['CI']);
const workersEnv = Number(process.env['E2E_WORKERS']);

export default defineConfig({
  testDir: './e2e/firefox',
  testMatch: /\.firefox\.ts$/,
  outputDir: './test-results/firefox',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: Number.isInteger(workersEnv) && workersEnv > 0 ? workersEnv : 2,
  reporter: ci ? [['list'], ['github']] : [['list']],
});
