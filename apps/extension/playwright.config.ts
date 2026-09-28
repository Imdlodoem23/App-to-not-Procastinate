/**
 * Playwright for the extension: every test loads the built MV3 extension (`dist/`) into a
 * fresh Chromium profile and drives it against the mock guardian (test/mock-guardian.ts).
 *
 *   npm run e2e -w apps/extension                       # builds dist/ first
 *   xvfb-run -a npm run e2e -w apps/extension           # Linux without a display
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium xvfb-run -a npm run e2e -w apps/extension
 *
 * - Browser: `PW_CHROMIUM_PATH` when set (this container), else the one from
 *   `npx playwright install chromium` (CI). Branded Chrome ignores `--load-extension`
 *   since 137, so only Chromium builds work.
 * - Headed by default (extensions need a display: use xvfb on Linux);
 *   `CENTRATE_E2E_HEADLESS=1` uses Chromium's new headless mode instead.
 * - Specs are `e2e/*.e2e.ts` (not `*.spec.ts`, which vitest would pick up). Firefox has its
 *   own smoke suite: playwright.firefox.config.ts (e2e/firefox/, through geckodriver).
 * - No real network: blocked hosts never leave the browser (declarativeNetRequest redirects
 *   them), and every other http(s) page is fulfilled locally (e2e/support/extension.ts).
 */
import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env['CI']);
const workersEnv = Number(process.env['E2E_WORKERS']);

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.e2e\.ts$/,
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: ci,
  // One retry on CI: a flaky timing is reported as «flaky», not hidden.
  retries: ci ? 1 : 0,
  workers: Number.isInteger(workersEnv) && workersEnv > 0 ? workersEnv : 2,
  reporter: ci ? [['list'], ['github']] : [['list']],
});
