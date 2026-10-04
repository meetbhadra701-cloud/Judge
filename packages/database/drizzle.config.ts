import { defineConfig } from 'drizzle-kit';

/*
 * `drizzle-kit generate` / `check` work offline from the schema files.
 * Only `drizzle-kit migrate` connects, and it requires DATABASE_URL.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env['DATABASE_URL'] ?? '' },
});
