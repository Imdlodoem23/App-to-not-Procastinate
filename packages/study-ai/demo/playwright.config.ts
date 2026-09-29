/**
 * Browser smoke test of the real MediaPipe WASM and models (`npm run test:browser -w
 * packages/study-ai`). Not part of `npm test`; the file is `*.pw.ts` so vitest never picks it up.
 *
 * Chromium gets a fake camera (`--use-fake-device-for-media-stream`). In this cloud container
 * run it with PW_CHROMIUM_PATH=/opt/pw-browsers/chromium; in CI,
 * `npx playwright install --with-deps chromium` provides the browser.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const port = Number(process.env.STUDY_AI_DEMO_PORT ?? 5199);

export default defineConfig({
  testDir: '.',
  testMatch: /\.pw\.ts$/,
  outputDir: '../test-results/demo',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  timeout: 180_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    permissions: ['camera'],
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  webServer: {
    command: 'npx vite --config demo/vite.config.ts',
    cwd: pkg,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { STUDY_AI_DEMO_PORT: String(port), STUDY_AI_DEMO_STABLE: '1' },
  },
});
