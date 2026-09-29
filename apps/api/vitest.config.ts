import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The server runs in UTC (server.ts pins it); tests do too.
    env: { TZ: 'UTC' },
    // Every test file starts its own PGlite (Postgres in WebAssembly) and applies the
    // migrations: seconds on a busy CI machine.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
