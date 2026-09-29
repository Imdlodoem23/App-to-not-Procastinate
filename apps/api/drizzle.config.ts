import { defineConfig } from 'drizzle-kit';

// `npm run db:generate -w apps/api` writes SQL migrations to ./drizzle (no database needed).
// The server applies them at boot; tests apply the same files to PGlite.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/centrate' },
  strict: true,
  verbose: true,
});
