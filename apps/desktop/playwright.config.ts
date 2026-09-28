/**
 * Playwright for the Electron app (docs/DESKTOP.md §12). No browser is downloaded: every spec
 * launches the built app with `_electron` (e2e/support/app.ts).
 *
 *   npm run build -w apps/desktop
 *   xvfb-run -a -s "-screen 0 2880x1800x24" npm run e2e -w apps/desktop   # Linux
 *   npm run e2e -w apps/desktop                                           # Windows, macOS
 *
 * Projects:
 * - `electron`: the suite (`e2e/*.spec.ts`): layout matrix, axe, keyboard and ARIA, flows,
 *   perf.
 *
 * Linux: every launch renders in a family of the brief's font stack (Ubuntu, Noto Sans, or
 * Selawik as Segoe UI) through a private fontconfig file (`e2e/support/fonts.ts`); install
 * `fonts-ubuntu` (or `fonts-noto-core`) on the runner.
 * - `capture`: the screenshot matrix (`e2e/capture/*.capture.ts`), only when
 *   `CENTRATE_CAPTURE=1`; run it with `npm run capture -w apps/desktop` (scripts/ui-capture.mjs),
 *   which also writes docs/ui/index.html.
 *
 * Workers: one spec file per worker (each keeps one Electron app per scale factor alive).
 * `E2E_WORKERS` overrides the count.
 */
import { defineConfig, type PlaywrightTestProject } from '@playwright/test';

const ci = Boolean(process.env['CI']);
const capture = process.env['CENTRATE_CAPTURE'] === '1';
const workersEnv = Number(process.env['E2E_WORKERS']);

const projects: PlaywrightTestProject[] = [
  { name: 'electron', testDir: './e2e', testMatch: /\.spec\.ts$/ },
];
if (capture) {
  projects.push({
    name: 'capture',
    testDir: './e2e/capture',
    testMatch: /\.capture\.ts$/,
    // Every scale factor runs in its own worker (one app each).
    fullyParallel: true,
    timeout: 10 * 60_000,
  });
}

export default defineConfig({
  // Downloads the Electron binary once, before the workers race for it (global-setup.ts).
  globalSetup: './e2e/support/global-setup.ts',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: ci,
  // One retry on CI: a flaky timing is reported as «flaky», not hidden.
  retries: ci ? 1 : 0,
  workers: Number.isInteger(workersEnv) && workersEnv > 0 ? workersEnv : ci ? 2 : 3,
  reporter: ci ? [['list'], ['github']] : [['list']],
  projects,
});
