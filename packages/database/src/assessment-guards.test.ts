import { storedFormOf } from '@judge-copilot/assessment';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentPersistError, AssessmentStore } from './assessment-store.js';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import type { JudgeDatabase } from './index.js';
import { extractAndBind, scoreRun, startRun } from './testing/assessment-pipeline.js';
import {
  seedAssessmentWorld,
  seedLockedContext,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgMessage,
  probe,
  rows,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';

/*
 * Each test isolates ONE database guard: the assessment is written by hand (direct SQL) inside a transaction that is always rolled
 * back, so only the IMMEDIATE triggers and constraints can reject it, and the rejection must name that guard. The control must pass.
 */

describe.each(testDatabaseTargets())(
  'M5 P4 assessment guards, one at a time, on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
    });
    afterAll(async () => {
      await testDb.close();
    });

    const newWorld = (declare = ['health']) =>
      seedAssessmentWorld(db, {
        trackKeys: ['health', 'robotics'],
        declare,
        rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      });

    async function ready(w?: AssessmentWorld, keys: { source?: string; context?: string } = {}) {
      const world = w ?? (await newWorld());
      const run = await startRun(db, world);
      const bound = await extractAndBind(world, run, keys);
      const scored = await scoreRun(db, world, run);
      return { w: world, run, bound, scored };
    }

    type Overrides = {
      hash?: string;
      mirror?: string;
      output?: string;
      extraction?: string;
      contextExtraction?: string;
      runId?: string;
      pins?: unknown;
    };
    /** Writes an assessment row by hand (no store), as an attacker with SQL access would. */
    function insertAssessment(
      tx: JudgeDatabase,
      scored: Awaited<ReturnType<typeof ready>>['scored'],
      run: { runId: string },
      overrides: Overrides = {},
    ) {
      const stored = storedFormOf(scored.report);
      return tx.execute(sql`INSERT INTO pre_interview_assessments
      (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
       extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
       input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
       pipeline_config_hash, provider_mode)
      SELECT p.id, p.event_id, ${overrides.runId ?? run.runId}, 1, ${sha256(`forged-${String(Math.random())}`)}, i.context_version_id, i.locked_content_hash,
             ${overrides.pins ?? sql`(SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${run.runId})`},
             ${overrides.extraction ?? sql`(SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${run.runId} AND kind = 'source')`},
             ${overrides.contextExtraction ?? sql`(SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${run.runId} AND kind = 'context_evidence')`},
             i.target_kind, ${scored.report.engineVersion}, ${scored.report.parametersHash}, ${scored.report.rubric.fingerprint},
             ${scored.report.rubric.source}, ${scored.report.inputFingerprint}, ${scored.report.graphFingerprint},
             ${overrides.output ?? scored.report.outputHash}, ${stored.reportCanonical}, ${overrides.hash ?? stored.reportTextSha256},
             ${overrides.mirror ?? stored.reportCanonical}::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
      FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${run.runId}`);
    }

    it('control: an honest hand-written assessment passes every immediate check', async () => {
      const { run, scored } = await ready();
      expect(await probe(db, (tx) => insertAssessment(tx, scored, run).then(() => undefined))).toBe(
        'accepted',
      );
    });

    it('the text hash must be the SHA-256 of report_canonical', async () => {
      const { run, scored } = await ready();
      await expectPgMessage(
        probe(db, (tx) =>
          insertAssessment(tx, scored, run, { hash: sha256('x') }).then(() => undefined),
        ),
        'report_text_sha256',
      );
    });

    it('the jsonb mirror must be the parsed report_canonical', async () => {
      const { run, scored } = await ready();
      await expectPgMessage(
        probe(db, (tx) =>
          insertAssessment(tx, scored, run, { mirror: '{"a":1}' }).then(() => undefined),
        ),
        'jsonb report',
      );
    });

    it('the identity columns must equal the report they summarize', async () => {
      const { run, scored } = await ready();
      await expectPgMessage(
        probe(db, (tx) =>
          insertAssessment(tx, scored, run, { output: sha256('o') }).then(() => undefined),
        ),
        'identity columns',
      );
    });

    it('the assessment must use exactly the extractions its run bound', async () => {
      const w = await newWorld();
      // an earlier run of the project (finished) with its own extractions
      const earlier = await startRun(db, w);
      const other = await extractAndBind(w, earlier, {
        source: sha256('o-src'),
        context: sha256('o-ctx'),
      });
      await earlier.store.finishRun({
        runId: earlier.runId,
        leaseToken: earlier.leaseToken,
        state: 'failed',
        failureCode: 'x',
      });
      const { run, scored } = await ready(w, { source: sha256('n-src'), context: sha256('n-ctx') });
      await expectPgMessage(
        probe(db, (tx) =>
          insertAssessment(tx, scored, run, {
            extraction: other.source.extraction.id,
            contextExtraction: other.context.extraction.id,
          }).then(() => undefined),
        ),
        'exactly the extractions its run bound',
      );
    });

    it("the assessment's snapshot ids must equal the run's pins exactly (an extra id is rejected)", async () => {
      const { run, scored } = await ready();
      await expectPgMessage(
        probe(db, (tx) =>
          insertAssessment(tx, scored, run, {
            pins: sql`(SELECT array_agg(s ORDER BY s) FROM (SELECT snapshot_id AS s FROM assessment_run_input_snapshots WHERE run_id = ${run.runId}
                        UNION ALL SELECT gen_random_uuid()) q)`,
          }).then(() => undefined),
        ),
        'must equal the run',
      );
    });

    it('the pinned context must STILL be the locked version when the assessment is written', async () => {
      const { w, run, scored } = await ready();
      await seedLockedContext(db, w.event.id, { trackKeys: ['health', 'robotics'] });
      await expectPgMessage(
        probe(db, (tx) => insertAssessment(tx, scored, run).then(() => undefined)),
        'no longer locked',
      );
    });

    it("a citation must name evidence of the assessment's OWN extractions, even when it is evidence of the same project", async () => {
      const { w, scored } = await ready();
      const standalone = await new EvidenceGraphStore({ db }).createGraph(
        w.project.id,
        {
          claims: [
            { ref: 'c', text: 'A claim outside the extractions.', verificationLevel: 'unverified' },
          ],
          evidence: [
            {
              ref: 'e',
              kind: 'claim',
              origin: 'devpost',
              verificationLevel: 'team_claim',
              text: 'sends a reminder every two hours',
              provenance: {
                snapshotId: w.snapshots.devpost.snapshot.id,
                artifactId: w.snapshots.devpost.artifacts[0]?.id,
                span: { start: 91, end: 123 },
              },
            },
          ],
        },
        null,
      );
      const outsider = standalone.evidence[0]?.id ?? '';
      const judgments = scored.persist.judgments.map((j, i) =>
        i === 0
          ? {
              ...j,
              outcomeKind: 'scored' as const,
              score: 6,
              disposition: 'scored' as const,
              citations: [
                { evidenceId: outsider, directness: 'direct', specificity: 'exact', note: null },
              ],
            }
          : j,
      );
      let caught: unknown;
      try {
        await new AssessmentStore(db).persist({ ...scored.persist, judgments });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AssessmentPersistError);
      expect((caught as AssessmentPersistError).detail).toContain('own extractions');
    });

    it('a run cannot end while a model call is still reserved (the in-flight attempt must be settled or reaped first)', async () => {
      const { run } = await ready();
      const reserved = await run.budget.reserve({
        stage: 'critic',
        model: 'm',
        requestDigest: sha256('open'),
        bounds: { inputTokens: 1, outputTokens: 1, costNanoUsd: 1 },
      });
      expect(reserved.ok).toBe(true);
      await expectPgMessage(
        probe(db, async (tx) => {
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${run.runId}`,
          );
        }),
        'still reserved',
      );
    });

    it('inputs can be pinned only to the CURRENTLY locked version, with its stored hash', async () => {
      const w = await newWorld();
      const old = w.context;
      await seedLockedContext(db, w.event.id, { trackKeys: ['health', 'robotics'] });
      await expectPgMessage(
        probe(db, async (tx) => {
          const [run] = await rows<{ id: string }>(
            tx,
            sql`INSERT INTO analysis_runs (run_type, state, event_id, project_id, context_version_id, started_at)
              VALUES ('pre_interview_assessment', 'pending', ${w.event.id}, ${w.project.id}, ${old.versionId}, NULL) RETURNING id`,
          );
          await tx.execute(sql`INSERT INTO assessment_run_inputs
          (run_id, project_id, event_id, context_version_id, locked_content_hash, declared_track_keys, track_selection_ids,
           track_selection_set_hash, target_kind, inputs_fingerprint, pipeline_config, pipeline_config_hash)
          VALUES (${run?.id ?? ''}, ${w.project.id}, ${w.event.id}, ${old.versionId}, ${old.hash}, '{}', '{}', ${sha256('a')}, 'overall', ${sha256('b')}, '{}'::jsonb, ${sha256('c')})`);
        }),
        'currently locked',
      );
    });

    it("an outcome's totals must equal the ledger totals of its run", async () => {
      const { run } = await ready();
      const reserved = await run.budget.reserve({
        stage: 'critic',
        model: 'm',
        requestDigest: sha256('t'),
        bounds: { inputTokens: 5, outputTokens: 5, costNanoUsd: 10 },
      });
      if (!reserved.ok) throw new Error('denied');
      await run.budget.settle(reserved.callId, { kind: 'unknown', outcomeCode: 'timeout' });
      await expectPgMessage(
        probe(db, async (tx) => {
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${run.runId}`,
          );
          await tx.execute(sql`INSERT INTO assessment_run_outcomes
          (run_id, project_id, outcome, failure_category, failure_code, attempts_started, settled_calls, unknown_calls, released_calls, input_tokens, output_tokens, cost_nano_usd)
          SELECT ${run.runId}, project_id, 'failed', 'internal_error', 'x', 0, 0, 0, 0, 0, 0, 0 FROM analysis_runs WHERE id = ${run.runId}`);
        }),
        'outcome totals must equal',
      );
    });

    it("a citation of reference evidence must carry the member's code-authored metadata (checked on a persisted assessment)", async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      const bound = await extractAndBind(w, run);
      const scored = await scoreRun(db, w, run, { citeReference: true });
      const result = await new AssessmentStore(db).persist(scored.persist);
      if (result.kind !== 'persisted') throw new Error('not persisted');
      const [definition] = await rows<{ record_id: string }>(
        db,
        sql`SELECT record_id FROM graph_extraction_items WHERE extraction_id = ${bound.context.extraction.id} AND reference_applicability = 'declared_track_definition'`,
      );
      // a dimension whose judgment does not yet cite the member, so the control row is not a duplicate
      const [cited] = await rows<{ dimension_id: string }>(
        db,
        sql`SELECT j.dimension_id FROM assessment_dimension_judgments j
            WHERE j.assessment_id = ${result.assessmentId}
              AND NOT EXISTS (SELECT 1 FROM assessment_judgment_citations c
                              WHERE c.assessment_id = j.assessment_id AND c.dimension_id = j.dimension_id AND c.evidence_id = ${definition?.record_id ?? ''})
            LIMIT 1`,
      );
      const insert = (applicability: string | null, trackKey: string | null) =>
        probe(db, async (tx) => {
          await tx.execute(sql`INSERT INTO assessment_judgment_citations
          (assessment_id, project_id, dimension_id, position, evidence_id, reference_applicability, reference_track_key, directness, specificity)
          VALUES (${result.assessmentId}, ${w.project.id}, ${cited?.dimension_id ?? ''}, 98, ${definition?.record_id ?? ''}, ${applicability}, ${trackKey}, 'indirect', 'generic')`);
        });
      expect(await insert('declared_track_definition', 'health')).toBe('accepted'); // the member's own metadata
      await expectPgMessage(insert(null, null), 'reference metadata');
      await expectPgMessage(insert('overall_rule', null), 'reference metadata');
      await expectPgMessage(insert('declared_track_definition', 'robotics'), 'reference metadata');
      // same track, other classification: only the applicability comparison can reject this one
      await expectPgMessage(insert('track_specific_requirement', 'health'), 'reference metadata');
    });
  },
);
