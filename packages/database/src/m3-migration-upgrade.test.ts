import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicIdAllocator } from '@judge-copilot/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from './client.js';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import {
  emptyDatabaseTargets,
  migrateFolder,
  rows,
  sql,
  type TestDatabase,
} from './testing/databases.js';
import { README_TEXT, seedGraphWorld, span } from './testing/graph-world.js';

/*
 * M3 over an existing, populated M2 database: migrations 0000-0006 are applied, M2 data is
 * written, then 0007-0008 are applied on top. Nothing M2 wrote may change, and the new graph can
 * cite the pre-existing snapshots.
 */

function m2OnlyFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'judge-m2-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((entry) => entry.idx <= 6);
  expect(kept.map((entry) => entry.tag).at(-1)).toBe('0006_m2_partial_reason_html_structure_limit');
  for (const entry of kept)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

describe.each(emptyDatabaseTargets())('M2 -> M3 migration upgrade on %s', (_name, open) => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  it('adds the evidence graph over populated M2 data without changing any of it', async () => {
    await migrateFolder(testDb, m2OnlyFolder());
    const m2Tables = await rows<{ table_name: string }>(
      testDb.db,
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('claims', 'evidence_items')`,
    );
    expect(m2Tables).toEqual([]);

    const world = await seedGraphWorld(testDb.db);
    const snapshotsBefore = await rows<{ id: string; content_hash: string | null; status: string }>(
      testDb.db,
      sql`SELECT id, content_hash, status FROM source_snapshots ORDER BY id`,
    );
    const artifactsBefore = await rows<{ id: string; content_hash: string; byte_length: number }>(
      testDb.db,
      sql`SELECT id, content_hash, byte_length FROM source_snapshot_artifacts ORDER BY id`,
    );

    await migrateFolder(testDb, migrationsFolder);

    const tables = await rows<{ table_name: string }>(
      testDb.db,
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('claims', 'evidence_items', 'evidence_relations', 'unknowns', 'contradictions') ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'claims',
      'contradictions',
      'evidence_items',
      'evidence_relations',
      'unknowns',
    ]);
    expect(
      await rows(testDb.db, sql`SELECT id, content_hash, status FROM source_snapshots ORDER BY id`),
    ).toEqual(snapshotsBefore);
    expect(
      await rows(
        testDb.db,
        sql`SELECT id, content_hash, byte_length FROM source_snapshot_artifacts ORDER BY id`,
      ),
    ).toEqual(artifactsBefore);

    // M2 immutability still holds after the upgrade.
    await expect(
      testDb.db.execute(
        sql`DELETE FROM source_snapshots WHERE id = ${world.snapshots.github.snapshot.id}`,
      ),
    ).rejects.toThrow();

    // The new graph can cite snapshots that existed before it did.
    const store = new EvidenceGraphStore({
      db: testDb.db,
      ids: deterministicIdAllocator('upgrade'),
    });
    const readme = world.snapshots.github.artifacts.find((a) => a.key === 'README.md');
    const created = await store.createGraph(
      world.project.id,
      {
        claims: [
          {
            ref: 'c',
            text: 'The project documents a health endpoint.',
            verificationLevel: 'team_claim',
          },
        ],
        evidence: [
          {
            ref: 'e',
            kind: 'fact',
            origin: 'github',
            verificationLevel: 'unverified',
            text: 'README mentions GET /health.',
            provenance: {
              snapshotId: world.snapshots.github.snapshot.id,
              artifactId: readme?.id,
              span: span(README_TEXT, 'GET /health'),
            },
          },
        ],
        relations: [{ claim: { ref: 'c' }, evidence: { ref: 'e' }, type: 'supports' }],
      },
      null,
    );
    expect(created.evidence[0]?.provenance.excerpt).toBe('GET /health');
    expect(await store.verifyIntegrity(world.project.id)).toEqual([]);
  });
});
