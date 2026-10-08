import { deterministicIdAllocator, validateGraphIntegrity } from '@judge-copilot/evidence';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConnection, type JudgeDatabase } from './client.js';
import { EvidenceGraphStore, GRAPH_READ_TRANSACTION } from './evidence-graph-store.js';
import { instrumentSelects } from './testing/instrument.js';
import { openPostgres, rows, testDatabaseTargets, type TestDatabase } from './testing/databases.js';
import {
  seedGraphWorld,
  seedProject,
  seedSnapshot,
  type GraphWorld,
} from './testing/graph-world.js';

/*
 * M4 prerequisite A: graph reads come from ONE consistent snapshot.
 *
 * `loadGraph` used to issue its statements one by one at READ COMMITTED, each with its own
 * snapshot, so a batch committed between two of them was half visible (false DANGLING_REFERENCE,
 * contradictions silently missing). These tests prove the read now runs in a single read-only
 * REPEATABLE READ transaction, that createGraph was NOT moved to that isolation level, that the
 * transaction is always released, and (PostgreSQL only, with real concurrent connections) that
 * writers can no longer tear a read.
 */

const URL_ = process.env['TEST_DATABASE_URL'];
const must = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error('missing');
  return value;
};

const API_SOURCE = 'export const health = () => ({ status: "ok" });\n';

/** A project of the world's event with its own captured sources (snapshots are project-scoped). */
async function seedSourcedProject(db: JudgeDatabase, w: GraphWorld, name: string) {
  const project = await seedProject(db, w.event.id, name);
  const github = await seedSnapshot(db, project, 'github', 'captured', [
    { key: 'files/src/api.ts', kind: 'file', mediaType: 'text/plain', text: API_SOURCE },
  ]);
  const devpost = await seedSnapshot(db, project, 'devpost', 'captured', [
    { key: 'submission.txt', kind: 'submission_text', mediaType: 'text/plain', text: 'Atlas.' },
  ]);
  const deployment = await seedSnapshot(db, project, 'deployment', 'captured', [
    { key: 'response.json', kind: 'http_response', mediaType: 'application/json', text: '{}' },
  ]);
  return {
    project,
    githubSnapshotId: github.snapshot.id,
    githubArtifactId: must(github.artifacts[0]).id,
    devpostSnapshotId: devpost.snapshot.id,
    deploymentSnapshotId: deployment.snapshot.id,
  };
}
type Sourced = Awaited<ReturnType<typeof seedSourcedProject>>;

/**
 * A self-contained batch whose records all mention `label`, so a reader can check atomicity. It
 * touches every table `loadGraph` reads: five graph tables plus snapshots, artifacts and context
 * versions.
 */
function labelledBatch(w: GraphWorld, src: Sourced, label: string) {
  return {
    claims: [
      { ref: 'c0', text: `${label} claim zero`, verificationLevel: 'team_claim' },
      { ref: 'c1', text: `${label} claim one`, verificationLevel: 'team_claim' },
      { ref: 'c2', text: `${label} claim two`, verificationLevel: 'contradicted' },
    ],
    evidence: [
      {
        ref: 'e0',
        kind: 'claim',
        origin: 'devpost',
        verificationLevel: 'team_claim',
        text: `${label} evidence zero`,
        provenance: { snapshotId: src.devpostSnapshotId },
      },
      {
        ref: 'e1',
        kind: 'fact',
        origin: 'deployment',
        verificationLevel: 'unverified',
        text: `${label} evidence one`,
        provenance: { snapshotId: src.deploymentSnapshotId },
      },
      {
        ref: 'e2',
        kind: 'fact',
        origin: 'event_context',
        verificationLevel: 'unverified',
        text: `${label} evidence two`,
        provenance: { contextVersionId: w.versions.locked.id },
      },
      {
        ref: 'e3',
        kind: 'fact',
        origin: 'github',
        verificationLevel: 'unverified',
        text: `${label} evidence three`,
        provenance: { snapshotId: src.githubSnapshotId, artifactId: src.githubArtifactId },
      },
    ],
    relations: [
      { claim: { ref: 'c0' }, evidence: { ref: 'e0' }, type: 'supports' },
      { claim: { ref: 'c1' }, evidence: { ref: 'e1' }, type: 'supports' },
      { claim: { ref: 'c0' }, evidence: { ref: 'e1' }, type: 'supports' },
    ],
    unknowns: [
      {
        unknownType: 'unverifiable',
        text: `${label} unknown`,
        claims: [{ ref: 'c2' }],
        evidence: [{ ref: 'e2' }],
      },
    ],
    contradictions: [
      {
        sideA: { type: 'claim', ref: 'c2' },
        sideB: { type: 'evidence', ref: 'e1' },
        description: `${label} contradiction`,
      },
    ],
  };
}

const LABEL = /^(L\d+)\b/;
type Counted = {
  claims: number;
  evidence: number;
  relations: number;
  unknowns: number;
  contra: number;
};

/** Per batch label: how many of each record kind a loaded graph contains. */
function countByLabel(loaded: NonNullable<Awaited<ReturnType<EvidenceGraphStore['loadGraph']>>>) {
  const { graph } = loaded;
  const byLabel = new Map<string, Counted>();
  const bucket = (label: string) => {
    let entry = byLabel.get(label);
    if (!entry) {
      entry = { claims: 0, evidence: 0, relations: 0, unknowns: 0, contra: 0 };
      byLabel.set(label, entry);
    }
    return entry;
  };
  const labelOf = (text: string) => LABEL.exec(text)?.[1] ?? null;
  for (const claim of graph.ordered.claims) {
    const label = labelOf(claim.text);
    if (label) bucket(label).claims += 1;
  }
  for (const item of graph.ordered.evidence) {
    const label = labelOf(item.text);
    if (label) bucket(label).evidence += 1;
  }
  for (const relation of graph.ordered.relations) {
    const label = labelOf(graph.claims.get(relation.claimId)?.text ?? '');
    if (label) bucket(label).relations += 1;
  }
  for (const unknown of graph.ordered.unknowns) {
    const label = labelOf(unknown.text);
    if (label) bucket(label).unknowns += 1;
  }
  for (const contradiction of graph.ordered.contradictions) {
    const label = labelOf(contradiction.description);
    if (label) bucket(label).contra += 1;
  }
  return byLabel;
}
const COMPLETE: Counted = { claims: 3, evidence: 4, relations: 3, unknowns: 1, contra: 1 };

describe.each(testDatabaseTargets())('M4 consistent graph reads on %s', (name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let w: GraphWorld;
  let n = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    w = await seedGraphWorld(db);
  });
  afterAll(async () => {
    await testDb.close();
  });

  const storeOn = (target: JudgeDatabase) => {
    n += 1;
    return new EvidenceGraphStore({
      db: target,
      ids: deterministicIdAllocator(`snapshot-reads-${name}-${String(n)}`),
    });
  };

  it('declares a read-only REPEATABLE READ transaction for reads', () => {
    expect(GRAPH_READ_TRANSACTION).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  });

  it('runs every statement of loadGraph (project, five graph tables, provenance) in ONE read-only REPEATABLE READ transaction', async () => {
    const src = await seedSourcedProject(db, w, 'Snapshot Reads Shape');
    await storeOn(db).createGraph(src.project.id, labelledBatch(w, src, 'L1'), null);

    const seen: {
      table: string;
      isolation: string;
      readOnly: string;
      snapshot: string;
      startedAt: string;
    }[] = [];
    const observed = instrumentSelects(db, async (event) => {
      const [state] = await rows<{
        isolation: string;
        read_only: string;
        snapshot: string;
        started_at: string;
      }>(
        event.scope,
        sql`SELECT current_setting('transaction_isolation') AS isolation,
                   current_setting('transaction_read_only') AS read_only,
                   pg_current_snapshot()::text AS snapshot,
                   now()::text AS started_at`,
      );
      const row = must(state);
      seen.push({
        table: event.table,
        isolation: row.isolation,
        readOnly: row.read_only,
        snapshot: row.snapshot,
        startedAt: row.started_at,
      });
    });

    const loaded = must(await storeOn(observed).loadGraph(src.project.id));
    expect(loaded.graph.ordered.claims).toHaveLength(3);
    expect(seen.map((s) => s.table)).toEqual([
      'projects',
      'claims',
      'evidence_items',
      'evidence_relations',
      'unknowns',
      'contradictions',
      'source_snapshots',
      'source_snapshot_artifacts',
      'event_context_versions',
    ]);
    for (const s of seen) {
      expect(s.isolation, s.table).toBe('repeatable read');
      expect(s.readOnly, s.table).toBe('on');
    }
    // One snapshot, one transaction for every statement.
    expect(new Set(seen.map((s) => s.snapshot)).size).toBe(1);
    expect(new Set(seen.map((s) => s.startedAt)).size).toBe(1);
    expect(validateGraphIntegrity(loaded.graph, loaded.known)).toEqual([]);
  });

  it('keeps createGraph at READ COMMITTED (its FOR NO KEY UPDATE lock depends on it)', async () => {
    const src = await seedSourcedProject(db, w, 'Snapshot Reads Writer');
    const states: { table: string; isolation: string; readOnly: string }[] = [];
    const observed = instrumentSelects(db, async (event) => {
      const [row] = await rows<{ isolation: string; read_only: string }>(
        event.scope,
        sql`SELECT current_setting('transaction_isolation') AS isolation,
                   current_setting('transaction_read_only') AS read_only`,
      );
      states.push({
        table: event.table,
        isolation: must(row).isolation,
        readOnly: must(row).read_only,
      });
    });
    await storeOn(observed).createGraph(src.project.id, labelledBatch(w, src, 'L2'), null);
    expect(states.length).toBeGreaterThan(0);
    // The FIRST statement is the project row lock.
    expect(states[0]?.table).toBe('projects');
    for (const s of states) {
      expect(s.isolation, s.table).toBe('read committed');
      expect(s.readOnly, s.table).toBe('off');
    }
  });

  it('returns null for an unknown project and leaves no transaction open', async () => {
    const store = storeOn(db);
    expect(await store.loadGraph('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e')).toBeNull();
    expect(await store.verifyIntegrity('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e')).toBeNull();
    // A normal transaction and a normal read still work afterwards.
    const project = await seedProject(db, w.event.id, 'Snapshot Reads Null');
    expect(must(await store.loadGraph(project.id)).graph.ordered.claims).toEqual([]);
  });

  it('keeps the established ordering (seq) and passes the integrity audit', async () => {
    const src = await seedSourcedProject(db, w, 'Snapshot Reads Order');
    await storeOn(db).createGraph(src.project.id, labelledBatch(w, src, 'L3'), null);
    await storeOn(db).createGraph(src.project.id, labelledBatch(w, src, 'L4'), null);
    const loaded = must(await storeOn(db).loadGraph(src.project.id));
    for (const list of [
      loaded.graph.ordered.claims,
      loaded.graph.ordered.evidence,
      loaded.graph.ordered.relations,
      loaded.graph.ordered.unknowns,
      loaded.graph.ordered.contradictions,
    ]) {
      const seqs = list.map((record) => record.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
    expect(loaded.graph.ordered.claims.map((c) => c.text.slice(0, 2))).toEqual([
      'L3',
      'L3',
      'L3',
      'L4',
      'L4',
      'L4',
    ]);
    expect(await storeOn(db).verifyIntegrity(src.project.id)).toEqual([]);
  });

  describe('failure handling', () => {
    it('propagates a failure in the middle of a read, rolls back, and the database stays usable', async () => {
      const src = await seedSourcedProject(db, w, 'Snapshot Reads Failure');
      const project = src.project;
      await storeOn(db).createGraph(project.id, labelledBatch(w, src, 'L5'), null);
      const boom = new Error('injected read failure');
      const failing = instrumentSelects(db, (event) => {
        if (event.table === 'evidence_relations') throw boom;
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(storeOn(failing).loadGraph(project.id)).rejects.toBe(boom);
      }
      const [open] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
      );
      expect(must(open).n).toBe(0);
      // Same handle, immediately usable for both reading and writing.
      expect(must(await storeOn(db).loadGraph(project.id)).graph.ordered.claims).toHaveLength(3);
      await storeOn(db).createGraph(project.id, labelledBatch(w, src, 'L6'), null);
    });

    it('the read transaction cannot write', async () => {
      const project = await seedProject(db, w.event.id, 'Snapshot Reads ReadOnly');
      const attempt = instrumentSelects(db, async (event) => {
        if (event.table !== 'claims') return;
        await event.execute(
          sql`INSERT INTO claims (project_id, text, verification_level)
              VALUES (${project.id}::uuid, 'written from a read transaction', 'unverified')`,
        );
      });
      await expect(storeOn(attempt).loadGraph(project.id)).rejects.toThrow();
      const [written] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${project.id}`,
      );
      expect(must(written).n).toBe(0);
      expect(must(await storeOn(db).loadGraph(project.id)).graph.ordered.claims).toEqual([]);
    });
  });
});

describe.skipIf(!URL_)('M4 consistent graph reads under concurrent writers (PostgreSQL)', () => {
  let setup: TestDatabase;
  let pool: DatabaseConnection;
  let w: GraphWorld;
  let n = 0;

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    w = await seedGraphWorld(setup.db);
    pool = createDatabase(url, { maxConnections: 24 });
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const storeOn = (target: JudgeDatabase) => {
    n += 1;
    return new EvidenceGraphStore({
      db: target,
      ids: deterministicIdAllocator(`snapshot-race-${String(n)}`),
    });
  };

  const GRAPH_TABLES = [
    'claims',
    'evidence_items',
    'evidence_relations',
    'unknowns',
    'contradictions',
  ] as const;

  it.each(GRAPH_TABLES)(
    'a batch committed right before the read of %s is invisible to the whole read (no torn graph)',
    async (table) => {
      const src = await seedSourcedProject(setup.db, w, `Interleave ${table}`);
      const project = src.project;
      await storeOn(pool.db).createGraph(project.id, labelledBatch(w, src, 'L1'), null);

      let committed = false;
      const racing = instrumentSelects(pool.db, async (event) => {
        // Commit a complete second batch, from another connection, at exactly this point of the
        // read: after the earlier tables were read, before `table` is.
        if (event.table !== table || committed) return;
        committed = true;
        await storeOn(pool.db).createGraph(project.id, labelledBatch(w, src, 'L2'), null);
      });

      const loaded = must(await storeOn(racing).loadGraph(project.id));
      expect(committed).toBe(true);

      // One snapshot: exactly the first batch, whole; no dangling reference, nothing omitted.
      expect(validateGraphIntegrity(loaded.graph, loaded.known)).toEqual([]);
      const byLabel = countByLabel(loaded);
      expect([...byLabel.keys()]).toEqual(['L1']);
      expect(byLabel.get('L1')).toEqual(COMPLETE);

      // The next read (a new snapshot) sees both batches completely.
      const after = must(await storeOn(pool.db).loadGraph(project.id));
      expect(validateGraphIntegrity(after.graph, after.known)).toEqual([]);
      const afterLabels = countByLabel(after);
      expect([...afterLabels.keys()].sort()).toEqual(['L1', 'L2']);
      expect(afterLabels.get('L1')).toEqual(COMPLETE);
      expect(afterLabels.get('L2')).toEqual(COMPLETE);
    },
  );

  it('verifyIntegrity does not report a false DANGLING_REFERENCE when a writer commits mid-read', async () => {
    const src = await seedSourcedProject(setup.db, w, 'Interleave verifyIntegrity');
    const project = src.project;
    await storeOn(pool.db).createGraph(project.id, labelledBatch(w, src, 'L1'), null);
    let committed = false;
    const racing = instrumentSelects(pool.db, async (event) => {
      if (event.table !== 'evidence_relations' || committed) return;
      committed = true;
      await storeOn(pool.db).createGraph(project.id, labelledBatch(w, src, 'L2'), null);
    });
    expect(await storeOn(racing).verifyIntegrity(project.id)).toEqual([]);
    expect(committed).toBe(true);
  });

  it('stress: concurrent writers and readers never observe a half-committed batch', async () => {
    const src = await seedSourcedProject(setup.db, w, 'Stress Reads');
    const project = src.project;
    const writers = 6;
    const batchesPerWriter = 8;
    let writing = writers;
    let reads = 0;
    const violations: string[] = [];

    const writer = async (index: number) => {
      try {
        for (let b = 0; b < batchesPerWriter; b += 1) {
          await storeOn(pool.db).createGraph(
            project.id,
            labelledBatch(w, src, `L${String(index * 100 + b)}`),
            null,
          );
        }
      } finally {
        writing -= 1;
      }
    };
    const reader = async () => {
      do {
        const loaded = must(await storeOn(pool.db).loadGraph(project.id));
        reads += 1;
        const issues = validateGraphIntegrity(loaded.graph, loaded.known);
        if (issues.length > 0) {
          violations.push(`integrity: ${issues.map((i) => i.code).join(',')}`);
        }
        for (const [label, counted] of countByLabel(loaded)) {
          if (JSON.stringify(counted) !== JSON.stringify(COMPLETE)) {
            violations.push(`${label} partially visible: ${JSON.stringify(counted)}`);
          }
        }
      } while (writing > 0);
    };

    await Promise.all([
      ...Array.from({ length: writers }, (_, i) => writer(i + 1)),
      ...Array.from({ length: 8 }, () => reader()),
    ]);

    expect(violations).toEqual([]);
    expect(reads).toBeGreaterThan(8);
    const finalGraph = must(await storeOn(pool.db).loadGraph(project.id));
    expect(finalGraph.graph.ordered.claims).toHaveLength(writers * batchesPerWriter * 3);
    expect(validateGraphIntegrity(finalGraph.graph, finalGraph.known)).toEqual([]);
  });

  it('never leaks a transaction connection, even when reads fail', async () => {
    const small = createDatabase(URL_ ?? '', { maxConnections: 2 });
    try {
      const src = await seedSourcedProject(setup.db, w, 'Leak Check');
      const project = src.project;
      await storeOn(small.db).createGraph(project.id, labelledBatch(w, src, 'L1'), null);
      const failing = instrumentSelects(small.db, (event) => {
        if (event.table === 'unknowns') throw new Error('injected');
      });
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? storeOn(failing).loadGraph(project.id)
            : storeOn(small.db).loadGraph(project.id),
        ),
      );
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(20);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
      const [open] = await rows<{ n: number }>(
        setup.db,
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
      );
      expect(must(open).n).toBe(0);
      // A pool of two connections would have been exhausted by any leak.
      expect(must(await storeOn(small.db).loadGraph(project.id)).graph.ordered.claims).toHaveLength(
        3,
      );
    } finally {
      await small.close();
    }
  });
});
