import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Clock strings («17:42») in fixtures and format tests are Madrid time. Set before the
// workers start so they inherit it.
process.env['TZ'] ??= 'Europe/Madrid';

export default defineConfig({
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  test: {
    // Unit tests only: Playwright specs live in e2e/ and run with `npm run e2e`.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    env: { TZ: 'Europe/Madrid' },
  },
});
