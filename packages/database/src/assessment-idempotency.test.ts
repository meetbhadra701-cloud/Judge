import { sha256Hex } from '@judge-copilot/context';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseConnection } from './client.js';
import { AssessmentStore } from './assessment-store.js';
import { assessmentRequests, assessmentRunInputs, type JudgeDatabase } from './index.js';
import {
  createdRunId,
  freshKey,
  newRunStore,
  requestInput,
} from './testing/assessment-fixtures.js';
import { extractAndBind, scoreRun, startRun } from './testing/assessment-pipeline.js';
import { seedSnapshot } from './testing/graph-world.js';
import {
  defaultLimits,
  seedAssessmentWorld,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgMessage,
  openPostgres,
  probe,
  rows,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';

/*
 * R4 F5: request identity and assessment identity (design §8.6). The identity of a request is computed by the store from the project,
 * the mode, the target, the pipeline configuration and the limits; the identity of the intended assessment is frozen with the run and
 * is the only key a persisted assessment can carry. No caller supplies a hash.
 */

describe.each(testDatabaseTargets())('R4 F5 idempotency matrix on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });
  afterAll(async () => {
    await testDb.close();
  });

  const newWorld = (): Promise<AssessmentWorld> =>
    seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
    });
  const runCount = async (projectId: string) =>
    Number(
      (
        await rows<{ n: number }>(
          db,
          sql`SELECT count(*)::int AS n FROM analysis_runs WHERE project_id = ${projectId}`,
        )
      )[0]?.n,
    );

  it("the same actor and key for ANOTHER PROJECT is key_reused: it never replays the first project's run", async () => {
    const [one, two] = [await newWorld(), await newWorld()];
    const store = newRunStore(db);
    const key = freshKey();
    const first = await store.requestAssessment(requestInput(one, { idempotencyKey: key }));
    const crossed = await store.requestAssessment(
      requestInput(two, { idempotencyKey: key, actorId: one.actor.id }),
    );
    expect(first.kind).toBe('run_created');
    expect(crossed).toEqual({ kind: 'key_reused' });
    expect(await runCount(two.project.id)).toBe(0);
    // and the first project's own retry still replays
    expect((await store.requestAssessment(requestInput(one, { idempotencyKey: key }))).kind).toBe(
      'run_active',
    );
  });

  it.each([
    ['a different target', { target: { kind: 'track', trackKey: 'health' } as const }],
    ['a different mode', { mode: 'reassess' } as const],
    ['a different pipeline configuration', { pipelineConfig: { pipeline: 'other/v9' } }],
    ['different limits', { limits: { ...defaultLimits(), maxCalls: 7 } }],
    ['a different price table', { priceTableId: 'prices/v2' }],
  ])('the same key with %s is key_reused and creates nothing', async (_label, overrides) => {
    const w = await newWorld();
    const store = newRunStore(db);
    const key = freshKey();
    await store.requestAssessment(requestInput(w, { idempotencyKey: key }));
    const runs = await runCount(w.project.id);
    const other = await store.requestAssessment(
      requestInput(w, { idempotencyKey: key, ...overrides }),
    );
    expect(other).toEqual({ kind: 'key_reused' });
    expect(await runCount(w.project.id)).toBe(runs);
  });

  it('a retry after a FAILED run returns the recorded failure and starts nothing; a NEW key starts exactly one new run', async () => {
    const w = await newWorld();
    const store = newRunStore(db);
    const key = freshKey();
    const created = await store.requestAssessment(requestInput(w, { idempotencyKey: key }));
    const runId = createdRunId(created);
    const lease = await store.claimRun(runId, 600_000);
    await store.finishRun({
      runId,
      leaseToken: lease ?? '',
      state: 'failed',
      failureCategory: 'internal_error',
      failureCode: 'test_failure',
    });
    const runs = await runCount(w.project.id);
    const retry = await store.requestAssessment(requestInput(w, { idempotencyKey: key }));
    expect(retry).toMatchObject({ kind: 'run_failed', runId, replayed: true });
    expect(await runCount(w.project.id)).toBe(runs);
    const fresh = await store.requestAssessment(requestInput(w));
    expect(fresh.kind).toBe('run_created');
    expect(await runCount(w.project.id)).toBe(runs + 1);
  });

  it('the assessment identity is frozen with the run and is what the persisted assessment carries; a repeated assess spends nothing', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    const [inputs] = await db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, run.runId));
    expect(inputs?.assessmentKey).toBe(sha256Hex(inputs?.assessmentIdentityCanonical ?? ''));
    const identity = JSON.parse(inputs?.assessmentIdentityCanonical ?? '{}') as Record<
      string,
      unknown
    >;
    expect(identity).toMatchObject({
      projectId: w.project.id,
      contextVersionId: w.context.versionId,
      lockedContentHash: w.context.hash,
      targetKind: 'overall',
      salt: '',
    });
    const persisted = await new AssessmentStore(db).persist(scored.persist);
    if (persisted.kind !== 'persisted') throw new Error('not persisted');
    const [stored] = await rows<{ assessment_key: string }>(
      db,
      sql`SELECT assessment_key FROM pre_interview_assessments WHERE id = ${persisted.assessmentId}`,
    );
    expect(stored?.assessment_key).toBe(inputs?.assessmentKey);
    // the repeated, identical request is answered with the assessment that exists: no second billable run
    const runs = await runCount(w.project.id);
    const again = await newRunStore(db).requestAssessment(requestInput(w));
    expect(again).toMatchObject({ kind: 'already_assessed', assessmentId: persisted.assessmentId });
    expect(await runCount(w.project.id)).toBe(runs);
  });

  it('a new capture changes what the assessment is about: the earlier assessment is not answered for it', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    expect((await new AssessmentStore(db).persist(scored.persist)).kind).toBe('persisted');
    const store = newRunStore(db);
    expect((await store.requestAssessment(requestInput(w))).kind).toBe('already_assessed');
    await seedSnapshot(db, w.project, 'deployment', 'captured', [
      { key: 'deploy.json', kind: 'file', mediaType: 'application/json', text: '{"ok":true}' },
    ]);
    expect((await store.requestAssessment(requestInput(w))).kind).toBe('run_created');
  });

  it('another pipeline configuration over the same inputs is a different assessment: it is NOT answered with the equal one', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    expect((await new AssessmentStore(db).persist(scored.persist)).kind).toBe('persisted');
    const store = newRunStore(db);
    const same = await store.requestAssessment(requestInput(w));
    expect(same.kind).toBe('already_assessed');
    const other = await store.requestAssessment(
      requestInput(w, { pipelineConfig: { pipeline: 'test/v2' } }),
    );
    expect(other.kind).toBe('run_created');
  });

  it('an explicit reassess is salted with its own request id: a new version with a different frozen key', async () => {
    const w = await newWorld();
    const store = newRunStore(db);
    const created = await store.requestAssessment(requestInput(w, { mode: 'reassess' }));
    const runId = createdRunId(created);
    const [inputs] = await db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, runId));
    const [request] = await db
      .select()
      .from(assessmentRequests)
      .where(eq(assessmentRequests.runId, runId));
    const identity = JSON.parse(inputs?.assessmentIdentityCanonical ?? '{}') as { salt?: string };
    expect(identity.salt).toBe(request?.id);
    expect(request?.id).toBeTruthy();
  });

  it('the database refuses a run whose frozen identity is missing, forged or inconsistent with its pins, and a different key at persistence', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    const [inputs] = await db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, run.runId));
    expect(inputs).toBeDefined();
    // 1. a direct-SQL assessment carrying another key than the frozen one
    await expectPgMessage(
      probe(db, async (tx) => {
        await tx.execute(sql`INSERT INTO pre_interview_assessments
          (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
           extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
           input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
           pipeline_config_hash, provider_mode)
          SELECT p.id, p.event_id, ${run.runId}, 1, ${sha256Hex('another key')}, i.context_version_id, i.locked_content_hash,
                 (SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${run.runId}),
                 (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${run.runId} AND kind = 'source'),
                 (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${run.runId} AND kind = 'context_evidence'),
                 i.target_kind, ${scored.report.engineVersion}, ${scored.report.parametersHash}, ${scored.report.rubric.fingerprint},
                 ${scored.report.rubric.source}, ${scored.report.inputFingerprint}, ${scored.report.graphFingerprint},
                 ${scored.report.outputHash}, '{}', ${sha256Hex('{}')}, '{}'::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
          FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${run.runId}`);
      }),
      'frozen',
    );
    // 2. a new run whose key is not the SHA-256 of its identity text, whose identity names another project, or which has none
    const fresh = await newWorld();
    const store = newRunStore(db);
    const other = createdRunId(await store.requestAssessment(requestInput(fresh)));
    // end the donor run so that the project has no active run (one active run per project) and its pins can be reused below
    const donorLease = await store.claimRun(other, 600_000);
    await store.finishRun({
      runId: other,
      leaseToken: donorLease ?? '',
      state: 'failed',
      failureCategory: 'internal_error',
      failureCode: 'donor',
    });
    const [donor] = await db
      .select()
      .from(assessmentRunInputs)
      .where(eq(assessmentRunInputs.runId, other));
    expect(donor).toBeDefined();
    const insertInputs = (overrides: { key?: string | null; identity?: string | null }) =>
      probe(db, async (tx) => {
        // a pending run of the same project to pin (the run row is created inside the rolled-back transaction)
        const [pending] = await rows<{ id: string }>(
          tx,
          sql`INSERT INTO analysis_runs (run_type, state, event_id, project_id, context_version_id, started_at)
              VALUES ('pre_interview_assessment', 'pending', ${fresh.event.id}, ${fresh.project.id}, ${fresh.context.versionId}, NULL) RETURNING id`,
        );
        await tx.execute(sql`INSERT INTO assessment_run_inputs
          (run_id, project_id, event_id, context_version_id, locked_content_hash, declared_track_keys, track_selection_ids,
           track_selection_set_hash, target_kind, inputs_fingerprint, pipeline_config, pipeline_config_hash, assessment_key, assessment_identity_canonical)
          VALUES (${pending?.id ?? ''}, ${donor?.projectId ?? ''}, ${donor?.eventId ?? ''}, ${donor?.contextVersionId ?? ''}, ${donor?.lockedContentHash ?? ''},
                  ${sql.raw(`ARRAY[${donor?.declaredTrackKeys.map((k) => `'${k}'`).join(',') ?? ''}]::text[]`)},
                  ${sql.raw(`ARRAY[${donor?.trackSelectionIds.map((k) => `'${k}'`).join(',') ?? ''}]::uuid[]`)},
                  ${donor?.trackSelectionSetHash ?? ''}, 'overall', ${donor?.inputsFingerprint ?? ''}, '{}'::jsonb, ${donor?.pipelineConfigHash ?? ''},
                  ${overrides.key === undefined ? donor?.assessmentKey : overrides.key},
                  ${overrides.identity === undefined ? donor?.assessmentIdentityCanonical : overrides.identity})`);
      });
    expect(await insertInputs({})).toBe('accepted');
    await expectPgMessage(
      insertInputs({ key: sha256Hex('x') }),
      'SHA-256 of its canonical identity',
    );
    await expectPgMessage(
      insertInputs({ key: null, identity: null }),
      'frozen assessment identity',
    );
    const forged = JSON.stringify({
      ...JSON.parse(donor?.assessmentIdentityCanonical ?? '{}'),
      projectId: w.project.id,
    });
    await expectPgMessage(
      insertInputs({ key: sha256Hex(forged), identity: forged }),
      'disagrees with the pinned inputs',
    );
  });
});

const URL_ = process.env['TEST_DATABASE_URL'];

describe.skipIf(!URL_)('R4 F5 concurrent requests (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let pool: DatabaseConnection;
  let db: JudgeDatabase;

  beforeAll(async () => {
    setup = await openPostgres(URL_ ?? '');
    pool = createDatabase(URL_ ?? '', { maxConnections: 24 });
    db = pool.db;
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const newWorld = (): Promise<AssessmentWorld> =>
    seedAssessmentWorld(db, {
      trackKeys: ['health'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
    });

  it('concurrent requests with the same actor and key for DIFFERENT projects: one run is created, the rest are key_reused (never a raw unique violation)', async () => {
    for (let round = 0; round < 6; round += 1) {
      const worlds = await Promise.all(Array.from({ length: 4 }, () => newWorld()));
      const actor = worlds[0]?.actor.id ?? '';
      const key = freshKey();
      const store = newRunStore(db);
      const results = await Promise.allSettled(
        worlds.map((world) =>
          store.requestAssessment(requestInput(world, { idempotencyKey: key, actorId: actor })),
        ),
      );
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toEqual([]);
      const kinds = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : 'rejected'));
      expect(kinds.filter((k) => k === 'run_created')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'key_reused')).toHaveLength(3);
      const [requests] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM assessment_requests WHERE actor_id = ${actor} AND idempotency_key = ${key}`,
      );
      expect(requests?.n).toBe(1);
    }
  });

  it('concurrent identical requests, and concurrent different keys for one project, stay exactly-once', async () => {
    const w = await newWorld();
    const store = newRunStore(db);
    const key = freshKey();
    const same = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.requestAssessment(requestInput(w, { idempotencyKey: key })),
      ),
    );
    expect(same.filter((r) => r.kind === 'run_created')).toHaveLength(1);
    expect(same.filter((r) => r.kind === 'run_active')).toHaveLength(7);
    const w2 = await newWorld();
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => store.requestAssessment(requestInput(w2))),
    );
    expect(keys.filter((r) => r.kind === 'run_created')).toHaveLength(1);
    expect(keys.filter((r) => r.kind === 'run_active_conflict')).toHaveLength(7);
  });
});
