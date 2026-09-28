/**
 * Playwright `test` for the Electron suite: a worker-scoped pool of harness apps, one per
 * device scale factor (`--force-device-scale-factor` is process-wide), reused across the
 * tests of a worker and switched between fixtures in-process with `harness.load()`. A failed
 * test restarts the worker, and the next test launches a fresh app.
 */
import { test as base } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

export class AppPool {
  private current: LaunchedApp | null = null;

  /** A shown harness app at `scaleFactor` (relaunches only when the scale changes). */
  async at(scaleFactor: number): Promise<LaunchedApp> {
    const current = this.current;
    if (
      current &&
      current.scaleFactor === scaleFactor &&
      current.electron.process().exitCode === null
    ) {
      return current;
    }
    await this.close();
    this.current = await launchApp({ state: 'idle', show: true, scaleFactor });
    return this.current;
  }

  async close(): Promise<void> {
    const current = this.current;
    this.current = null;
    await current?.close();
  }
}

export const test = base.extend<Record<never, never>, { apps: AppPool }>({
  apps: [
    // Playwright requires the destructuring pattern even when no fixture is used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const pool = new AppPool();
      await use(pool);
      await pool.close();
    },
    { scope: 'worker', timeout: 60_000 },
  ],
});

export { expect } from '@playwright/test';
