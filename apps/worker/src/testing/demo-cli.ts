/*
 * `pnpm demo:prepare` -- prepares the OFFLINE replay demonstration (docs/DEMO_RUNBOOK.md). Development only.
 *
 *   --fixture <path>   where to write the replay fixture   (default: demo-data/replay-fixture.json)
 *   --seed             also insert the labelled SYNTHETIC hackathon + project into DATABASE_URL (the database must be migrated)
 *
 * It refuses to run with NODE_ENV=production, writes nothing outside the given fixture path, uses no network and calls no model.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createDatabase } from '@judge-copilot/database';
import { recordReplayFixture, seedDemo } from './demo.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'demo:prepare writes synthetic demonstration data and is refused in production',
    );
  }
  const target = resolve(option('--fixture') ?? 'demo-data/replay-fixture.json');
  const fixture = await recordReplayFixture();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Replay fixture written: ${target}\n  ${String(fixture.entries.length)} hand-written answers for the built-in synthetic project (no model produced them).\n`,
  );
  if (!process.argv.includes('--seed')) {
    process.stdout.write(
      'Add --seed (with DATABASE_URL set to a migrated database) to also create the synthetic demo hackathon and project.\n',
    );
    return;
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('--seed needs DATABASE_URL (a migrated database)');
  const connection = createDatabase(url, { maxConnections: 2 });
  try {
    const seeded = await seedDemo(connection.db);
    process.stdout.write(
      [
        'Synthetic demo data created (clearly labelled SYNTHETIC DEMO):',
        `  hackathon  /events/${seeded.eventId}            (locked Event Context; practise the submit flow here: /events/${seeded.eventId}/submit)`,
        `  project    /projects/${seeded.projectId}/assessment   (press "Run assessment": the worker replays the recorded answers)`,
        '',
      ].join('\n'),
    );
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `demo:prepare failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
