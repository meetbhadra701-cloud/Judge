import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrationsFolder, schema } from '../src/client.js';
import { checkMigrationJournal } from '../src/migration-journal.js';
import { diagnoseMigrations, verifySchemaObjects } from '../src/schema-state.js';

/*
 * Operator preflight / post-migration check (READ-ONLY): `DATABASE_URL=postgres://... pnpm db:verify-schema`.
 * It runs SELECTs only. It never repairs, so it is safe against a database you do not want to touch.
 * Exit 0: the journal is consistent, every journal entry is recorded, and every schema object exists. Exit 1 otherwise, with what is wrong.
 */
const url = process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('DATABASE_URL is required (read-only checks are run against it)\n');
  process.exit(2);
}
const folder = migrationsFolder;
const client = postgres(url, { max: 1, onnotice: () => undefined });
let failed = false;
try {
  const db = drizzle(client, { schema });
  const journal = checkMigrationJournal(folder);
  const state = await diagnoseMigrations(db, folder);
  const objects = await verifySchemaObjects(db, folder);
  const say = (text: string) => process.stdout.write(`${text}\n`);
  say(`journal problems: ${String(journal.length)}`);
  for (const p of journal) say(`  - ${p}`);
  say(`migrations not applied: ${state.notApplied.join(', ') || 'none'}`);
  say(
    `  of which SKIPPED (an older timestamp than an applied one; the migrator will never apply them): ${state.skipped.join(', ') || 'none'}`,
  );
  say(
    `migrations applied under different SQL text (informational): ${state.hashDiffers.join(', ') || 'none'}`,
  );
  say(`schema objects missing: ${String(objects.missing.length)}`);
  for (const m of objects.missing) say(`  - ${m}`);
  failed = journal.length > 0 || !state.ok || !objects.ok;
} finally {
  await client.end();
}
process.exit(failed ? 1 : 0);
