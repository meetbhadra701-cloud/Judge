import { fileURLToPath } from 'node:url';
import { checkMigrationJournal } from '../src/migration-journal.js';

/*
 * `pnpm db:check` runs this BEFORE drizzle-kit's own check. It fails (exit 1) on any journal inconsistency, in particular a migration whose
 * `when` does not exceed its predecessor's: the migrator would skip it on existing databases and still report success.
 */
const folder = process.argv[2] ?? fileURLToPath(new URL('../drizzle', import.meta.url));
const problems = checkMigrationJournal(folder);
if (problems.length > 0) {
  process.stderr.write(`migration journal check FAILED (${folder}):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write('migration journal check passed\n');
