import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentStore } from './assessment-store.js';
import { createDatabase, type DatabaseConnection } from './client.js';
import {
  analysisRuns,
  assessmentRunOutcomes,
  preInterviewAssessments,
  type JudgeDatabase,
} from './index.js';
import { freshKey, newRunStore, requestInput } from './testing/assessment-fixtures.js';
import { extractAndBind, scoreRun, startRun } from './testing/assessment-pipeline.js';
import {
  declareTrack,
  seedAssessmentWorld,
  seedLockedContext,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import { openPostgres, rows } from './testing/databases.js';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import { GraphExtractionStore } from './extraction-store.js';
import { sha256 } from './testing/graph-world.js';
import { sourceExtraction } from './testing/assessment-world.js';
import { deterministicIdAllocator } from '@judge-copilot/evidence';
import { AssessmentInputReader } from './assessment-input-reader.js';

/*
 * Real concurrent transactions on real PostgreSQL connections (never promise an ordering on one connection). Skipped without
 * TEST_DATABASE_URL: PGlite is a single connection and cannot interleave transactions.
 */

const URL_ = process.env['TEST_DATABASE_URL'];

describe.skipIf(!URL_)('M5 P4 concurrency, lock order and stale inputs (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let pool: DatabaseConnection;
  let db: JudgeDatabase;

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    pool = createDatabase(url, { maxConnections: 24 });
    db = pool.db;
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const newWorld = (declare: string[] = ['health']): Promise<AssessmentWorld> =>
    seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare,
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
    });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Polls until some backend other than ours waits on a lock (the operation under test is really blocked). */
  async function waitUntilBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((row?.n ?? 0) > 0) return;
      await sleep(25);
    }
    throw new Error('nothing became blocked on a lock');
  }

  it('createGraphInTransaction takes the project lock FIRST: it waits on it before reading or writing anything (lock order)', async () => {
    const w = await newWorld();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${w.project.id} FOR NO KEY UPDATE`);
      await gate;
    });
    await sleep(100);
    const store = new EvidenceGraphStore({ db, ids: deterministicIdAllocator('lock-order') });
    const writer = db.transaction((tx) =>
      store.createGraphInTransaction(
        tx,
        w.project.id,
        {
          claims: [
            { ref: 'c', text: 'A claim written after the lock.', verificationLevel: 'unverified' },
          ],
        },
        w.actor.id,
      ),
    );
    try {
      await waitUntilBlocked();
      // the blocked statement is the project row lock, and nothing of the writer exists yet
      const [waiting] = await rows<{ query: string }>(
        db,
        sql`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() LIMIT 1`,
      );
      expect(waiting?.query.toLowerCase()).toContain('for no key update');
      expect(waiting?.query.toLowerCase()).toContain('"projects"');
      const [seen] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM claims WHERE project_id = ${w.project.id}`,
      );
      expect(seen?.n).toBe(0);
    } finally {
      release();
    }
    await holder;
    expect((await writer).claims).toHaveLength(1);
  });

  it('simultaneous identical requests create exactly ONE run; the rest replay the same run', async () => {
    const w = await newWorld();
    const input = requestInput(w);
    const store = newRunStore(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.requestAssessment(input)),
    );
    const created = results.filter((r) => r.kind === 'run_created');
    expect(created).toHaveLength(1);
    const runIds = new Set(results.map((r) => ('runId' in r ? r.runId : null)));
    expect(runIds.size).toBe(1);
    expect(results.filter((r) => r.kind === 'run_active')).toHaveLength(7);
    const [n] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM analysis_runs WHERE project_id = ${w.project.id}`,
    );
    expect(n?.n).toBe(1);
  });

  it('simultaneous requests with DIFFERENT keys: one run, the others conflict (one active run per project)', async () => {
    const w = await newWorld();
    const store = newRunStore(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.requestAssessment(requestInput(w, { idempotencyKey: freshKey() })),
      ),
    );
    expect(results.filter((r) => r.kind === 'run_created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'run_active_conflict')).toHaveLength(7);
    const [n] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM analysis_runs WHERE project_id = ${w.project.id} AND state IN ('pending','running')`,
    );
    expect(n?.n).toBe(1);
  });

  it('concurrent graph writers and extraction writers of ONE project all complete, and every extraction stays valid', async () => {
    const w = await newWorld();
    let n = 0;
    const graphs = () =>
      new EvidenceGraphStore({ db, ids: deterministicIdAllocator(`conc-${String((n += 1))}`) });
    const extractions = (i: number) =>
      new GraphExtractionStore(
        db,
        new EvidenceGraphStore({ db, ids: deterministicIdAllocator(`conc-x-${String(i)}`) }),
      );
    const solo = (i: number) =>
      graphs().createGraph(
        w.project.id,
        {
          claims: [
            {
              ref: 'c',
              text: `A standalone claim number ${String(i)}.`,
              verificationLevel: 'unverified',
            },
          ],
        },
        null,
      );
    const extraction = (i: number) =>
      extractions(i).createExtraction(
        sourceExtraction(w, { key: sha256(`concurrent-${String(i)}`) }),
      );
    const results = await Promise.all([
      solo(1),
      extraction(1),
      solo(2),
      extraction(2),
      solo(3),
      extraction(3),
      solo(4),
    ]);
    expect(results).toHaveLength(7);
    // every extraction satisfies the deferred completeness trigger (it committed) and lists only its own records
    const [orphans] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM graph_extractions e WHERE e.project_id = ${w.project.id}
          AND graph_extraction_members_hash(e.id) <> e.members_hash`,
    );
    expect(orphans?.n).toBe(0);
    const [ext] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM graph_extractions WHERE project_id = ${w.project.id}`,
    );
    expect(ext?.n).toBe(3);
  });

  it('a context superseded WHILE the assessment is being persisted cancels the run and writes nothing (persist waits on the version lock)', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    const store = new AssessmentStore(db);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // the supersession transaction (M1 order: version row UPDATE) is open and holds the row lock
    const superseding = db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE event_context_versions SET status = 'superseded' WHERE id = ${w.context.versionId}`,
      );
      await gate;
    });
    await sleep(100);
    const persisting = store.persist(scored.persist);
    try {
      await waitUntilBlocked();
    } finally {
      release();
    }
    await superseding;
    expect(await persisting).toEqual({ kind: 'cancelled', reason: 'context_superseded' });
    const [runRow] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, run.runId));
    expect(runRow?.state).toBe('cancelled');
    const [outcome] = await db
      .select()
      .from(assessmentRunOutcomes)
      .where(eq(assessmentRunOutcomes.runId, run.runId));
    expect(outcome?.failureCode).toBe('context_superseded');
    const found = await db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.runId, run.runId));
    expect(found).toEqual([]);
  });

  it('the opposite order: persist holds the version FOR SHARE, so a concurrent supersession waits and then proceeds', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM event_context_versions WHERE id = ${w.context.versionId} FOR SHARE`,
      );
      await gate;
    });
    await sleep(100);
    const superseding = (async () => {
      await db.execute(
        sql`UPDATE event_context_versions SET status = 'superseded' WHERE id = ${w.context.versionId}`,
      );
    })();
    try {
      await waitUntilBlocked();
    } finally {
      release();
    }
    await holding;
    await superseding;
    // the persist now observes the supersession
    expect(await new AssessmentStore(db).persist(scored.persist)).toEqual({
      kind: 'cancelled',
      reason: 'context_superseded',
    });
  });

  it('no deadlock between context lock/supersede (event -> version) and request/persist (project -> version): 20 interleavings', async () => {
    const worlds = await Promise.all(Array.from({ length: 5 }, () => newWorld()));
    const attempts = worlds.flatMap((w) =>
      Array.from({ length: 4 }, (_, i) => [
        newRunStore(db).requestAssessment(requestInput(w, { idempotencyKey: freshKey() })),
        // M1 lock order: a NEW locked version supersedes the old one (event row, then version rows)
        i % 2 === 0
          ? seedLockedContext(db, w.event.id, { trackKeys: ['health', 'robotics'] })
          : Promise.resolve(null),
      ]),
    );
    const settled = await Promise.allSettled(attempts.flat());
    const failures = settled.filter((r) => r.status === 'rejected');
    // a deadlock would surface as SQLSTATE 40P01; unique/active conflicts are typed results, not errors
    const deadlocks = failures.filter((r) => /deadlock|40P01/.test(String(r.reason)));
    expect(deadlocks).toEqual([]);
  });

  it('a track declared concurrently with a request is pinned consistently (all or nothing) and the read verifies', async () => {
    const w = await newWorld([]);
    const store = newRunStore(db);
    const [request] = await Promise.all([
      store.requestAssessment(requestInput(w)),
      declareTrack(db, w.project.id, w.event.id, w.context.versionId, 'health', w.actor.id),
    ]);
    expect(request.kind).toBe('run_created');
    if (request.kind !== 'run_created') return;
    const [pin] = await rows<{ declared: string[]; selections: string[] }>(
      db,
      sql`SELECT declared_track_keys AS declared, track_selection_ids AS selections FROM assessment_run_inputs WHERE run_id = ${request.runId}`,
    );
    expect(pin?.declared.length).toBe(pin?.selections.length);
    // whichever won, the pin is internally valid: the trusted reader accepts its track part
    await store.claimRun(request.runId, 600_000);
    const reader = new AssessmentInputReader(db);
    await expect(reader.read(request.runId)).rejects.toMatchObject({
      code: 'extraction_not_bound',
    });
  });

  it('a worker crash between graph commit and assessment commit: recovery, no assessment, reusable extraction', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    const keys = { source: sha256('crash-s'), context: sha256('crash-c') };
    const bound = await extractAndBind(w, run, keys);
    const recovered = await run.store.recoverExpiredRuns(new Date(Date.now() + 3_600_000 * 24));
    expect(recovered).toContain(run.runId);
    const [n] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM pre_interview_assessments WHERE run_id = ${run.runId}`,
    );
    expect(n?.n).toBe(0);
    const again = await new GraphExtractionStore(
      db,
      new EvidenceGraphStore({ db }),
    ).createExtraction(sourceExtraction(w, { key: keys.source }));
    expect(again.created).toBe(false);
    expect(again.extraction.id).toBe(bound.source.extraction.id);
  });
});
