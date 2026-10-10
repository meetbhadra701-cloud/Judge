import { verifyStoredAssessment } from '@judge-copilot/assessment';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import { GraphExtractionStore } from './extraction-store.js';
import { DatabaseRunBudget } from './run-budget-store.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssessmentPersistError,
  AssessmentStore,
  type PersistAssessmentInput,
} from './assessment-store.js';
import {
  analysisRuns,
  assessmentDimensionJudgments,
  assessmentJudgmentCitations,
  assessmentRunExtractions,
  assessmentRunOutcomes,
  graphExtractions,
  preInterviewAssessments,
  type JudgeDatabase,
} from './index.js';
import { newRunStore, requestInput } from './testing/assessment-fixtures.js';
import {
  extractAndBind,
  scoreRun,
  startRun,
  type PreparedRun,
} from './testing/assessment-pipeline.js';
import {
  seedAssessmentWorld,
  seedLockedContext,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgError,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';

const { CHECK_VIOLATION, RESTRICT_VIOLATION, FOREIGN_KEY_VIOLATION } = SQLSTATE;

describe.each(testDatabaseTargets())(
  'M5 P4 immutable assessment persistence on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let store: AssessmentStore;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      store = new AssessmentStore(db);
    });
    afterAll(async () => {
      await testDb.close();
    });

    const newWorld = (declare: string[] = ['health']) =>
      seedAssessmentWorld(db, {
        trackKeys: ['health', 'robotics'],
        declare,
        rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
        requirements: [
          {
            statement: 'Health projects must cite their data source.',
            certainty: 'explicit',
            trackKey: 'health',
          },
        ],
      });
    async function prepared(w?: AssessmentWorld, keys: { source?: string; context?: string } = {}) {
      const world = w ?? (await newWorld());
      const run = await startRun(db, world);
      const bound = await extractAndBind(world, run, keys);
      const scored = await scoreRun(db, world, run);
      return { w: world, run, bound, scored };
    }
    const count = async (table: string, where = 'true') =>
      Number(
        (
          await rows<{ n: number }>(
            db,
            sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
          )
        )[0]?.n,
      );
    const noAssessmentFor = async (runId: string) => {
      expect(await count('pre_interview_assessments', `run_id = '${runId}'`)).toBe(0);
      expect(
        await count(
          'assessment_dimension_judgments',
          `assessment_id IN (SELECT id FROM pre_interview_assessments WHERE run_id = '${runId}')`,
        ),
      ).toBe(0);
    };
    const persistError = async (input: PersistAssessmentInput) => {
      try {
        await store.persist(input);
      } catch (error) {
        if (error instanceof AssessmentPersistError) return error;
        throw error;
      }
      throw new Error('expected the persist to be rejected');
    };

    describe('a successful assessment', () => {
      it('is written once, atomically, with its judgments, citations and outcome; the run succeeds', async () => {
        const { run, scored } = await prepared();
        const result = await store.persist(scored.persist);
        expect(result).toMatchObject({ kind: 'persisted', versionNumber: 1 });
        if (result.kind !== 'persisted') return;
        const [assessment] = await db
          .select()
          .from(preInterviewAssessments)
          .where(eq(preInterviewAssessments.id, result.assessmentId));
        expect(assessment).toMatchObject({
          runId: run.runId,
          kind: 'pre_interview',
          outputHash: scored.report.outputHash,
          engineVersion: scored.report.engineVersion,
          parametersHash: scored.report.parametersHash,
          inputFingerprint: scored.report.inputFingerprint,
          graphFingerprint: scored.report.graphFingerprint,
          providerMode: 'scripted',
        });
        const judgments = await store.judgments(result.assessmentId);
        expect(judgments.map((j) => j.dimensionId)).toEqual(
          scored.report.dimensions.map((d) => d.id),
        );
        expect(judgments.some((j) => j.citations.length > 0)).toBe(true);
        const [stateRow] = await db
          .select()
          .from(analysisRuns)
          .where(eq(analysisRuns.id, run.runId));
        expect(stateRow?.state).toBe('succeeded');
        const [outcome] = await db
          .select()
          .from(assessmentRunOutcomes)
          .where(eq(assessmentRunOutcomes.runId, run.runId));
        expect(outcome).toMatchObject({
          outcome: 'succeeded',
          failureCategory: null,
          unknownCalls: 0,
        });
        expect(outcome?.settledCalls).toBeGreaterThan(0);
      });

      it('round-trips: the stored bytes verify, and the M4 outputHash is NOT the hash of the stored text', async () => {
        const { scored } = await prepared();
        const result = await store.persist(scored.persist);
        if (result.kind !== 'persisted') throw new Error('not persisted');
        const verified = await store.getVerified(result.assessmentId);
        expect(verified).toMatchObject({ verified: true, failed: null });
        const stored = verified?.assessment;
        expect(stored?.reportTextSha256).not.toBe(stored?.outputHash);
        expect(
          verifyStoredAssessment({
            reportCanonical: stored?.reportCanonical ?? '',
            reportTextSha256: stored?.reportTextSha256 ?? '',
            outputHash: stored?.outputHash ?? '',
            reportJson: stored?.report,
          }),
        ).toEqual({ ok: true });
        // the database independently verifies what it can: the text hash, and the jsonb mirror equals the parsed text
        const [check] = await rows<{ hash_ok: boolean; mirror_ok: boolean }>(
          db,
          sql`SELECT encode(sha256(convert_to(report_canonical, 'UTF8')), 'hex') = report_text_sha256 AS hash_ok,
                   report_canonical::jsonb = report AS mirror_ok
            FROM pre_interview_assessments WHERE id = ${result.assessmentId}`,
        );
        expect(check).toMatchObject({ hash_ok: true, mirror_ok: true });
      });

      it('cites only evidence of its own extractions, with the code-authored reference metadata (incl. Event Context)', async () => {
        const { bound, scored } = await prepared();
        const result = await store.persist(scored.persist);
        if (result.kind !== 'persisted') throw new Error('not persisted');
        const citations = await db
          .select()
          .from(assessmentJudgmentCitations)
          .where(eq(assessmentJudgmentCitations.assessmentId, result.assessmentId));
        const members = new Set([
          ...bound.source.members.evidenceIds,
          ...bound.context.members.evidenceIds,
        ]);
        expect(citations.length).toBeGreaterThan(0);
        expect(citations.every((c) => members.has(c.evidenceId))).toBe(true);
      });

      it("Event-Context reference evidence is citable only as indirect/generic context, with the extraction's code-authored metadata", async () => {
        const w = await newWorld();
        const run = await startRun(db, w);
        const bound = await extractAndBind(w, run);
        const scored = await scoreRun(db, w, run, { citeReference: true });
        const result = await store.persist(scored.persist);
        if (result.kind !== 'persisted') throw new Error('not persisted');
        const citations = await db
          .select()
          .from(assessmentJudgmentCitations)
          .where(eq(assessmentJudgmentCitations.assessmentId, result.assessmentId));
        const reference = citations.find((c) => c.referenceApplicability !== null);
        expect(reference).toMatchObject({ directness: 'indirect', specificity: 'generic' });
        expect(bound.context.members.evidenceIds).toContain(reference?.evidenceId);
        const stored = await rows<{
          reference_applicability: string;
          reference_track_key: string | null;
        }>(
          db,
          sql`SELECT reference_applicability, reference_track_key FROM graph_extraction_items WHERE record_id = ${reference?.evidenceId ?? ''}`,
        );
        expect([reference?.referenceApplicability, reference?.referenceTrackKey]).toEqual([
          stored[0]?.reference_applicability,
          stored[0]?.reference_track_key,
        ]);
        // a citation of reference evidence WITHOUT its metadata, with another applicability, or as direct evidence cannot be added
        const dimension = reference?.dimensionId ?? '';
        const [definition] = await rows<{ record_id: string }>(
          db,
          sql`SELECT record_id FROM graph_extraction_items WHERE extraction_id = ${bound.context.extraction.id} AND reference_applicability = 'declared_track_definition'`,
        );
        const other = definition?.record_id ?? '';
        for (const values of [
          sql`NULL, NULL, 'indirect', 'generic'`,
          sql`'overall_rule', NULL, 'indirect', 'generic'`,
          sql`'declared_track_definition', 'health', 'direct', 'exact'`,
        ]) {
          await expectPgError(
            db.execute(sql`INSERT INTO assessment_judgment_citations
            (assessment_id, project_id, dimension_id, position, evidence_id, reference_applicability, reference_track_key, directness, specificity)
            VALUES (${result.assessmentId}, ${w.project.id}, ${dimension}, 99, ${other}, ${values})`),
            CHECK_VIOLATION,
          );
        }
      });

      it('version numbers are gapless per project and a reassessment is a NEW immutable version beside the old', async () => {
        const w = await newWorld();
        const first = await prepared(w, { source: sha256('src-1'), context: sha256('ctx-1') });
        const one = await store.persist(first.scored.persist);
        expect(one).toMatchObject({ kind: 'persisted', versionNumber: 1 });
        // a second run of the same project (a reassessment) reusing the extractions
        const second = await startRun(db, w, { mode: 'reassess' });
        const reused = await extractAndBind(w, second, {
          source: sha256('src-1'),
          context: sha256('ctx-1'),
        });
        expect(reused.source.created).toBe(false);
        expect(reused.context.created).toBe(false);
        const scored = await scoreRun(db, w, second);
        const two = await store.persist(scored.persist);
        expect(two).toMatchObject({ kind: 'persisted', versionNumber: 2 });
        expect((await store.listVersions(w.project.id)).map((v) => v.versionNumber)).toEqual([
          1, 2,
        ]);
        // an equal assessment key cannot be recorded twice
        await expect(
          (async () => {
            const third = await startRun(db, w, { mode: 'reassess' });
            await extractAndBind(w, third, { source: sha256('src-1'), context: sha256('ctx-1') });
            const again = await scoreRun(db, w, third, {
              assessmentKey: first.scored.persist.assessmentKey,
            });
            return store.persist(again.persist);
          })(),
        ).rejects.toBeInstanceOf(AssessmentPersistError);
      });

      it('the idempotency matrix after success: same-key retry, equal assess, explicit reassess (and no spend)', async () => {
        const w = await newWorld();
        const keyOf = (_pins: unknown, salt: string) => sha256(`K${salt}`);
        const first = requestInput(w, { assessmentKey: keyOf });
        const runStore = newRunStore(db);
        const created = await runStore.requestAssessment(first);
        if (created.kind !== 'run_created') throw new Error('not created');
        const lease = await runStore.claimRun(created.runId, 600_000);
        const full: PreparedRun = {
          runId: created.runId,
          leaseToken: lease ?? '',
          store: runStore,
          extractions: new GraphExtractionStore(db, new EvidenceGraphStore({ db })),
          budget: new DatabaseRunBudget({
            db,
            runId: created.runId,
            measure: (_m, u) => ({
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              costNanoUsd: 1,
            }),
          }),
        };
        await extractAndBind(w, full);
        const scored = await scoreRun(db, w, full, { assessmentKey: sha256('K') });
        const persisted = await store.persist(scored.persist);
        if (persisted.kind !== 'persisted') throw new Error('not persisted');
        const runs = await count('analysis_runs', `project_id = '${w.project.id}'`);
        // 1. the same key again returns the original result and starts nothing
        expect(await runStore.requestAssessment(first)).toMatchObject({
          kind: 'run_succeeded',
          runId: created.runId,
          assessmentId: persisted.assessmentId,
          replayed: true,
        });
        // 2. a NEW key with mode=assess finds the equal assessment: no run, no spend
        const equal = await runStore.requestAssessment(requestInput(w, { assessmentKey: keyOf }));
        expect(equal).toMatchObject({
          kind: 'already_assessed',
          assessmentId: persisted.assessmentId,
          replayed: false,
        });
        // 3. an explicit reassess is a new run, salted with its request id (a different assessment key)
        const reassess = await runStore.requestAssessment(
          requestInput(w, { mode: 'reassess', assessmentKey: keyOf }),
        );
        expect(reassess.kind).toBe('run_created');
        expect(await count('analysis_runs', `project_id = '${w.project.id}'`)).toBe(runs + 1);
      });
    });

    describe('failed, partial and corrupted writes leave nothing', () => {
      it('a corrupted report (one changed character) or a forged output hash is refused before any transaction', async () => {
        const { run, scored } = await prepared();
        const text = JSON.parse(JSON.stringify(scored.report)) as typeof scored.report;
        const corrupted = {
          ...text,
          overall: { ...text.overall, confidence: 0.123 },
        } as typeof scored.report;
        expect((await persistError({ ...scored.persist, report: corrupted })).code).toBe(
          'report_not_verifiable',
        );
        const forgedHash = { ...scored.report, outputHash: 'a'.repeat(64) };
        expect((await persistError({ ...scored.persist, report: forgedHash })).code).toBe(
          'report_not_verifiable',
        );
        await noAssessmentFor(run.runId);
        expect(
          (await db.select().from(analysisRuns).where(eq(analysisRuns.id, run.runId)))[0]?.state,
        ).toBe('running');
      });

      it('a report text containing a NUL character is refused before any transaction (jsonb cannot store it)', async () => {
        const { run, scored } = await prepared();
        const { reportOutputHash } = await import('@judge-copilot/scoring');
        const renamed = {
          ...scored.report,
          rubric: { ...scored.report.rubric, name: 'Official\u0000rubric' },
        };
        const { outputHash: _stale, ...body } = renamed;
        const report = { ...body, outputHash: reportOutputHash(body) };
        expect((await persistError({ ...scored.persist, report })).code).toBe('report_unstorable');
        await noAssessmentFor(run.runId);
      });

      it('a missing judgment (the report has a dimension no judgment covers) fails at COMMIT and rolls everything back', async () => {
        const { run, scored } = await prepared();
        const error = await persistError({
          ...scored.persist,
          judgments: scored.persist.judgments.slice(1),
        });
        expect(error.code).toBe('persistence_failed');
        expect(error.sqlState).toBe(CHECK_VIOLATION);
        await noAssessmentFor(run.runId);
        expect(await count('assessment_run_outcomes', `run_id = '${run.runId}'`)).toBe(0);
        expect(
          (await db.select().from(analysisRuns).where(eq(analysisRuns.id, run.runId)))[0]?.state,
        ).toBe('running');
        // the run is still usable: the honest write then succeeds
        expect((await store.persist(scored.persist)).kind).toBe('persisted');
      });

      it('an extra judgment for a dimension the report does not contain fails', async () => {
        const { run, scored } = await prepared();
        const extra = {
          ...(scored.persist.judgments[0] ?? ({} as never)),
          dimensionId: 'official.invented',
          citations: [],
        };
        const error = await persistError({
          ...scored.persist,
          judgments: [...scored.persist.judgments, { ...extra, assessorCallSeqs: [] }],
        });
        expect(error.sqlState).toBe(CHECK_VIOLATION);
        await noAssessmentFor(run.runId);
      });

      it('a citation of evidence that is not a member of the run extractions is refused', async () => {
        const { run, scored } = await prepared();
        const other = await prepared();
        const foreignEvidence = other.bound.source.members.evidenceIds[0] ?? '';
        const judgments = scored.persist.judgments.map((j, i) =>
          i === 0
            ? {
                ...j,
                outcomeKind: 'scored' as const,
                score: j.score ?? 5,
                disposition: 'scored' as const,
                citations: [
                  {
                    evidenceId: foreignEvidence,
                    directness: 'direct',
                    specificity: 'exact',
                    note: null,
                  },
                ],
              }
            : j,
        );
        const error = await persistError({ ...scored.persist, judgments });
        expect(error.sqlState).toMatch(/23514|23503/);
        await noAssessmentFor(run.runId);
      });

      it('ledger references must be real settled calls of THIS run and of the right stage', async () => {
        const { run, scored } = await prepared();
        const judgments = scored.persist.judgments.map((j, i) =>
          i === 0 ? { ...j, criticCallSeqs: j.assessorCallSeqs } : j,
        );
        expect((await persistError({ ...scored.persist, judgments })).sqlState).toBe(
          CHECK_VIOLATION,
        );
        const ghost = scored.persist.judgments.map((j, i) =>
          i === 0 ? { ...j, assessorCallSeqs: [9_999] } : j,
        );
        expect((await persistError({ ...scored.persist, judgments: ghost })).sqlState).toBe(
          CHECK_VIOLATION,
        );
        await noAssessmentFor(run.runId);
      });

      it('a scored Track judgment cannot be stored without a completed critic review (R3 A4, enforced by the database)', async () => {
        await prepared();
        await expectPgError(
          db.execute(sql`INSERT INTO assessment_dimension_judgments
          (assessment_id, project_id, dimension_id, position, outcome_kind, score, disposition, assessor_attempts, critic_attempts,
           critic_review_required, critic_reviewed)
          VALUES (gen_random_uuid(), gen_random_uuid(), 'track_prize_alignment.centrality', 0, 'scored', 7, 'scored', 1, 0, false, false)`),
          CHECK_VIOLATION,
        );
        await expectPgError(
          db.execute(sql`INSERT INTO assessment_dimension_judgments
          (assessment_id, project_id, dimension_id, position, outcome_kind, score, disposition, assessor_attempts, critic_attempts,
           critic_review_required, critic_reviewed)
          VALUES (gen_random_uuid(), gen_random_uuid(), 'track_prize_alignment.centrality', 0, 'scored', 7, 'scored', 1, 0, true, false)`),
          CHECK_VIOLATION,
        );
        // a review that claims to be complete must name critic calls
        await expectPgError(
          db.execute(sql`INSERT INTO assessment_dimension_judgments
          (assessment_id, project_id, dimension_id, position, outcome_kind, score, disposition, assessor_attempts, critic_attempts,
           critic_review_required, critic_reviewed)
          VALUES (gen_random_uuid(), gen_random_uuid(), 'track_prize_alignment.centrality', 0, 'scored', 7, 'scored', 1, 1, true, true)`),
          CHECK_VIOLATION,
        );
      });

      it('direct SQL cannot weaken the report integrity: wrong text hash, mirror or identity columns', async () => {
        const { run, scored } = await prepared();
        const stored = (await import('@judge-copilot/assessment')).storedFormOf(scored.report);
        const base = { runId: run.runId };
        const attempt = (overrides: { hash?: string; mirror?: string; output?: string }) =>
          db.transaction(async (tx) => {
            await tx.execute(sql`INSERT INTO pre_interview_assessments
            (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
             extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
             input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
             pipeline_config_hash, provider_mode)
            SELECT p.id, p.event_id, ${base.runId}, 1, ${sha256('forged')}, i.context_version_id, i.locked_content_hash,
                   (SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${base.runId}),
                   (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${base.runId} AND kind = 'source'),
                   (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${base.runId} AND kind = 'context_evidence'),
                   i.target_kind, ${scored.report.engineVersion}, ${scored.report.parametersHash}, ${scored.report.rubric.fingerprint},
                   ${scored.report.rubric.source}, ${scored.report.inputFingerprint}, ${scored.report.graphFingerprint},
                   ${overrides.output ?? scored.report.outputHash}, ${stored.reportCanonical}, ${overrides.hash ?? stored.reportTextSha256},
                   ${overrides.mirror ?? stored.reportCanonical}::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
            FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${base.runId}`);
          });
        await expectPgError(attempt({ hash: sha256('not the text') }), CHECK_VIOLATION);
        await expectPgError(attempt({ mirror: '{"outputHash":"x"}' }), CHECK_VIOLATION);
        await expectPgError(attempt({ output: sha256('another') }), CHECK_VIOLATION);
      });
    });

    describe('stale inputs', () => {
      it('a context superseded between the read and the commit CANCELS the run and writes no assessment (decision D3)', async () => {
        const { w, run, scored } = await prepared();
        await seedLockedContext(db, w.event.id, { trackKeys: ['health', 'robotics'] });
        const result = await store.persist(scored.persist);
        expect(result).toEqual({ kind: 'cancelled', reason: 'context_superseded' });
        await noAssessmentFor(run.runId);
        const [runRow] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, run.runId));
        expect(runRow?.state).toBe('cancelled');
        const [outcome] = await db
          .select()
          .from(assessmentRunOutcomes)
          .where(eq(assessmentRunOutcomes.runId, run.runId));
        expect(outcome).toMatchObject({ outcome: 'cancelled', failureCode: 'context_superseded' });
      });

      it('the membership the report was computed from must still be the committed one', async () => {
        const { scored } = await prepared();
        const error = await persistError({
          ...scored.persist,
          expected: { ...scored.persist.expected, sourceMembersHash: sha256('another membership') },
        });
        expect(error.code).toBe('members_changed');
      });

      it('a wrong or stale lease cannot persist', async () => {
        const { scored } = await prepared();
        const error = await persistError({
          ...scored.persist,
          leaseToken: '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e',
        });
        expect(error.code).toBe('run_not_persistable');
      });
    });

    describe('crash between graph commit and assessment commit', () => {
      it('leaves a complete, reusable extraction, a failed run and NO assessment; a later run reuses the extraction', async () => {
        const w = await newWorld();
        const run = await startRun(db, w);
        const keys = { source: sha256('crash-src'), context: sha256('crash-ctx') };
        const bound = await extractAndBind(w, run, keys);
        expect(bound.source.created).toBe(true);
        // the worker dies here: its lease expires and the recovery fails the run
        await run.store.recoverExpiredRuns(new Date(Date.now() + 24 * 3_600_000));
        const [dead] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, run.runId));
        expect(dead).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
        await noAssessmentFor(run.runId);
        // the extraction survived whole
        expect(await count('graph_extractions', `id = '${bound.source.extraction.id}'`)).toBe(1);
        // an explicit new run reuses it and completes
        const next = await startRun(db, w);
        const reused = await extractAndBind(w, next, keys);
        expect(reused.source.created).toBe(false);
        expect(reused.source.extraction.id).toBe(bound.source.extraction.id);
        const scored = await scoreRun(db, w, next);
        expect((await store.persist(scored.persist)).kind).toBe('persisted');
      });
    });

    describe('immutability of the stored assessment', () => {
      it('UPDATE, DELETE, TRUNCATE and CASCADE are refused on every assessment table', async () => {
        const { scored } = await prepared();
        const result = await store.persist(scored.persist);
        if (result.kind !== 'persisted') throw new Error('not persisted');
        await expectPgError(
          db
            .update(preInterviewAssessments)
            .set({ outputHash: sha256('x') })
            .where(eq(preInterviewAssessments.id, result.assessmentId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db
            .delete(preInterviewAssessments)
            .where(eq(preInterviewAssessments.id, result.assessmentId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db
            .update(assessmentDimensionJudgments)
            .set({ rationale: 'edited' })
            .where(eq(assessmentDimensionJudgments.assessmentId, result.assessmentId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db
            .delete(assessmentJudgmentCitations)
            .where(eq(assessmentJudgmentCitations.assessmentId, result.assessmentId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db
            .update(graphExtractions)
            .set({ membersHash: sha256('x') })
            .where(eq(graphExtractions.projectId, scored.authorized.data.projectId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db
            .delete(assessmentRunExtractions)
            .where(eq(assessmentRunExtractions.runId, scored.persist.runId)),
          RESTRICT_VIOLATION,
        );
        for (const table of [
          'pre_interview_assessments',
          'assessment_dimension_judgments',
          'assessment_judgment_citations',
          'assessment_requests',
          'assessment_run_inputs',
          'assessment_run_input_snapshots',
          'assessment_run_budget',
          'assessment_run_calls',
          'assessment_run_outcomes',
          'assessment_run_extractions',
          'graph_extractions',
          'graph_extraction_items',
        ]) {
          // a table with referencing foreign keys is refused by PostgreSQL itself (0A000); the guard covers the rest
          await expectPgError(
            db.execute(sql.raw(`TRUNCATE ${table}`)),
            RESTRICT_VIOLATION,
            '0A000',
          );
          await expectPgError(db.execute(sql.raw(`TRUNCATE ${table} CASCADE`)), RESTRICT_VIOLATION);
        }
        // the parents cannot be removed from under it either
        await expectPgError(
          db.execute(sql`TRUNCATE projects CASCADE`),
          RESTRICT_VIOLATION,
          FOREIGN_KEY_VIOLATION,
        );
        await expectPgError(
          db.execute(
            sql`DELETE FROM evidence_items WHERE project_id = ${scored.authorized.data.projectId}`,
          ),
          RESTRICT_VIOLATION,
          FOREIGN_KEY_VIOLATION,
        );
      });

      it('a second assessment for the same run, or one for a FAILED run, cannot exist', async () => {
        const { scored } = await prepared();
        await store.persist(scored.persist);
        expect((await persistError(scored.persist)).code).toBe('run_not_persistable');
        const w = await newWorld();
        const failed = await startRun(db, w);
        await extractAndBind(w, failed);
        const failedScore = await scoreRun(db, w, failed);
        await failed.store.finishRun({
          runId: failed.runId,
          leaseToken: failed.leaseToken,
          state: 'failed',
          failureCode: 'x',
        });
        expect((await persistError(failedScore.persist)).code).toBe('run_not_persistable');
        await noAssessmentFor(failed.runId);
      });
    });

    it('every judged dimension of the report has its judgment and every judgment names ledger calls of its run', async () => {
      const { run, scored } = await prepared();
      const result = await store.persist(scored.persist);
      if (result.kind !== 'persisted') throw new Error('not persisted');
      const judgments = await store.judgments(result.assessmentId);
      for (const judgment of judgments) {
        for (const seq of judgment.assessorCallSeqs) {
          const [call] = await rows<{ stage: string; state: string }>(
            db,
            sql`SELECT stage, state FROM assessment_run_calls WHERE run_id = ${run.runId} AND seq = ${seq}`,
          );
          expect(call).toMatchObject({ stage: 'dimension_assessment', state: 'settled' });
        }
      }
    });
  },
);
