/**
 * Playwright for the marketing captures (PROMPT.md §11 «Material visual»). Run through
 * `node scripts/marketing/build-media.mjs`, which sets `MARKETING_OUT` and runs this config
 * under Xvfb on Linux; the specs write PNGs (stills and video frames) there and the script
 * encodes them.
 *
 * Projects:
 * - `desktop` (`*.desktop.ts`): the built Electron app in harness mode (fake guardian on a
 *   frozen clock), launched with `apps/desktop/e2e/support/app.ts` at
 *   `--force-device-scale-factor=2`. Build first: `npm run build -w apps/desktop`.
 * - `extension` (`*.extension.ts`): the built blocked page (`apps/extension/dist`) in
 *   Chromium with a stubbed extension API and Playwright's fake clock. Build first:
 *   `npm run build -w apps/extension`. In the cloud container:
 *   `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`.
 *
 * `MARKETING_ONLY=hero,stills` narrows the run to those jobs (see `jobs.ts`).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const ci = Boolean(process.env['CI']);

export default defineConfig({
  testDir: '.',
  outputDir:
    process.env['MARKETING_TEST_RESULTS'] ?? join(tmpdir(), 'centrate-marketing', 'test-results'),
  timeout: 10 * 60_000,
  expect: { timeout: 10_000 },
  // One app at a time: the whole run takes well under a minute, and several Electron apps side
  // by side on a small runner can miss the harness's readiness timeouts.
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'desktop', testMatch: /\.desktop\.ts$/ },
    { name: 'extension', testMatch: /\.extension\.ts$/ },
  ],
});
