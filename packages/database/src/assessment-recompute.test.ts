import { storedFormOf, verifyStoredAssessment } from '@judge-copilot/assessment';
import { reportOutputHash } from '@judge-copilot/scoring';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssessmentPersistError,
  AssessmentStore,
  type JudgmentInput,
  type PersistAssessmentInput,
} from './assessment-store.js';
import { analysisRuns, type JudgeDatabase } from './index.js';
import {
  extractAndBind,
  oracleScore,
  scoreRun,
  startRun,
  type ScoredRun,
} from './testing/assessment-pipeline.js';
import { seedAssessmentWorld, type AssessmentWorld } from './testing/assessment-world.js';
import {
  expectPgMessage,
  probe,
  rows,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';

/*
 * R4 F1/F2: a valid M4 report proves only that the report is internally consistent. Persistence must RECOMPUTE it from the
 * authorized inputs and the judgments being stored, and refuse any report that is not exactly that recomputation.
 */

describe.each(testDatabaseTargets())(
  'R4 F1/F2 authoritative recomputation at persistence on %s',
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

    const newWorld = (extra: { rubricWeights?: [number, number]; rules?: string } = {}) =>
      seedAssessmentWorld(db, {
        trackKeys: ['health', 'robotics'],
        declare: ['health'],
        rules: [
          {
            statement: extra.rules ?? 'Every project must be original work.',
            certainty: 'explicit',
          },
        ],
        ...(extra.rubricWeights ? { rubricWeights: extra.rubricWeights } : {}),
      });
    async function prepared(
      w?: AssessmentWorld,
      keys: { source?: string; context?: string; withAbsence?: boolean } = {},
      options: { scoredUnits?: number; citeReference?: boolean } = {},
    ) {
      const world = w ?? (await newWorld());
      const run = await startRun(db, world);
      const bound = await extractAndBind(world, run, keys);
      const scored = await scoreRun(db, world, run, options);
      return { w: world, run, bound, scored };
    }
    const count = async (table: string, where: string) =>
      Number(
        (
          await rows<{ n: number }>(
            db,
            sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
          )
        )[0]?.n,
      );
    const rejection = async (input: PersistAssessmentInput) => {
      try {
        await store.persist(input);
      } catch (error) {
        if (error instanceof AssessmentPersistError) return error;
        throw error;
      }
      throw new Error('expected the persist to be rejected, but it succeeded');
    };
    /** After a rejected persist nothing exists for the run: no assessment, no outcome, the run is still running. */
    const expectNothingWritten = async (runId: string) => {
      expect(await count('pre_interview_assessments', `run_id = '${runId}'`)).toBe(0);
      expect(await count('assessment_run_outcomes', `run_id = '${runId}'`)).toBe(0);
      expect(
        await count(
          'assessment_dimension_judgments',
          `assessment_id IN (SELECT id FROM pre_interview_assessments WHERE run_id = '${runId}')`,
        ),
      ).toBe(0);
      const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      expect(run?.state).toBe('running');
    };
    const scoredIndex = (s: ScoredRun) =>
      s.persist.judgments.findIndex((j) => j.outcomeKind === 'scored');
    const edit = (
      s: ScoredRun,
      change: (judgments: JudgmentInput[]) => JudgmentInput[],
    ): PersistAssessmentInput => ({
      ...s.persist,
      judgments: change([...s.persist.judgments]),
    });
    const replaceAt = (
      judgments: JudgmentInput[],
      index: number,
      patch: Partial<JudgmentInput>,
    ): JudgmentInput[] => judgments.map((j, i) => (i === index ? { ...j, ...patch } : j));

    it('the correct report with its judgments is stored and verifies', async () => {
      const { scored, run } = await prepared();
      const result = await store.persist(scored.persist);
      expect(result.kind).toBe('persisted');
      if (result.kind !== 'persisted') return;
      const read = await store.getVerified(result.assessmentId);
      expect(read?.verified).toBe(true);
      expect(await count('assessment_run_outcomes', `run_id = '${run.runId}'`)).toBe(1);
    });

    describe('contradictory judgments next to a valid report are refused', () => {
      it('a changed judgment score', async () => {
        const { scored, run } = await prepared();
        const i = scoredIndex(scored);
        expect(i).toBeGreaterThanOrEqual(0);
        const error = await rejection(edit(scored, (j) => replaceAt(j, i, { score: 3 })));
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
        // the honest input still works afterwards: the rejection left the run untouched
        expect((await store.persist(scored.persist)).kind).toBe('persisted');
      });

      it('a changed scored/insufficient outcome (scored -> insufficient)', async () => {
        const { scored, run } = await prepared();
        const i = scoredIndex(scored);
        const error = await rejection(
          edit(scored, (j) =>
            replaceAt(j, i, {
              outcomeKind: 'insufficient_evidence',
              score: null,
              disposition: 'assessor_reported_insufficient',
            }),
          ),
        );
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
      });

      it('a changed scored/insufficient outcome (insufficient -> scored)', async () => {
        const { scored, run } = await prepared();
        const cited = scored.persist.judgments[scoredIndex(scored)]?.citations ?? [];
        const k = scored.persist.judgments.findIndex(
          (j, index) => j.outcomeKind !== 'scored' && index !== scoredIndex(scored),
        );
        expect(k).toBeGreaterThanOrEqual(0);
        const error = await rejection(
          edit(scored, (j) =>
            replaceAt(j, k, {
              outcomeKind: 'scored',
              score: 9,
              disposition: 'scored',
              citations: cited,
            }),
          ),
        );
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
      });

      it('a changed evidence citation', async () => {
        const { scored, run } = await prepared();
        const i = scoredIndex(scored);
        const current = scored.persist.judgments[i];
        const alternative = scored.authorized.data.records.evidence.find(
          (e) =>
            e.origin !== 'event_context' &&
            !(current?.citations ?? []).some((c) => c.evidenceId === e.id),
        );
        expect(alternative).toBeDefined();
        const error = await rejection(
          edit(scored, (j) =>
            replaceAt(j, i, {
              citations: (current?.citations ?? []).map((c, index) =>
                index === 0 ? { ...c, evidenceId: alternative?.id ?? '' } : c,
              ),
            }),
          ),
        );
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
      });

      it.each([
        ['directness', { directness: 'adjacent' }],
        ['specificity', { specificity: 'partial' }],
      ])('a changed %s classification', async (_label, patch) => {
        const { scored, run } = await prepared();
        const i = scoredIndex(scored);
        const current = scored.persist.judgments[i];
        const error = await rejection(
          edit(scored, (j) =>
            replaceAt(j, i, {
              citations: (current?.citations ?? []).map((c, index) =>
                index === 0 ? { ...c, ...patch } : c,
              ),
            }),
          ),
        );
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
      });
    });

    describe('a valid M4 report that belongs to something else is refused', () => {
      it('a report of another PROJECT (valid hash, own judgments)', async () => {
        const a = await prepared();
        const b = await prepared();
        expect(verifyStoredAssessment(storedFormOf(b.scored.report)).ok).toBe(true);
        const error = await rejection({ ...a.scored.persist, report: b.scored.report });
        expect(error.code).toBe('report_mismatch');
        const swapped = await rejection({
          ...a.scored.persist,
          report: b.scored.report,
          judgments: b.scored.persist.judgments,
        });
        expect(['report_mismatch', 'scorer_input_invalid']).toContain(swapped.code);
        await expectNothingWritten(a.run.runId);
      });

      it('a report of another locked CONTEXT', async () => {
        const a = await prepared();
        const other = await prepared(
          await newWorld({ rules: 'Teams must have at most four members.' }),
        );
        const error = await rejection({ ...a.scored.persist, report: other.scored.report });
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(a.run.runId);
      });

      it('a report of another RUBRIC', async () => {
        const a = await prepared();
        const other = await prepared(await newWorld({ rubricWeights: [0.8, 0.2] }));
        expect(other.scored.report.rubric.fingerprint).not.toBe(a.scored.report.rubric.fingerprint);
        const error = await rejection({ ...a.scored.persist, report: other.scored.report });
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(a.run.runId);
      });

      it('a report scored from another EXTRACTION of the same project', async () => {
        const w = await newWorld();
        const first = await prepared(w, { source: sha256('x1-src'), context: sha256('x1-ctx') });
        await first.run.store.finishRun({
          runId: first.run.runId,
          leaseToken: first.run.leaseToken,
          state: 'failed',
          failureCategory: 'internal_error',
          failureCode: 'test_setup',
        });
        const second = await prepared(w, { source: sha256('x2-src'), context: sha256('x2-ctx') });
        expect(second.bound.source.extraction.id).not.toBe(first.bound.source.extraction.id);
        // the run-2 judgments cited run-2 evidence; the first run's report was computed over different record ids
        const error = await rejection({ ...second.scored.persist, report: first.scored.report });
        expect(error.code).toBe('report_mismatch');
        const crossed = await rejection({
          ...second.scored.persist,
          report: first.scored.report,
          judgments: first.scored.persist.judgments,
        });
        expect(['report_mismatch', 'scorer_input_invalid']).toContain(crossed.code);
        await expectNothingWritten(second.run.runId);
      });

      it('a report with a VALID internal SHA-256 but wrong content (outputHash recomputed by the attacker)', async () => {
        const { scored, run } = await prepared();
        const { outputHash: _hash, ...body } = scored.report;
        const forged = {
          ...body,
          overall:
            body.overall.state === 'scored' || body.overall.state === 'scored_partial'
              ? { ...body.overall, score10: 9.9, scoreOnScale: 9.9 }
              : body.overall,
          diagnostics: [],
        };
        const forgedReport = { ...forged, outputHash: reportOutputHash(forged) };
        expect(verifyStoredAssessment(storedFormOf(forgedReport)).ok).toBe(true);
        const error = await rejection({ ...scored.persist, report: forgedReport });
        expect(error.code).toBe('report_mismatch');
        await expectNothingWritten(run.runId);
      });
    });

    it('M4 behaviour is preserved: a scored judgment whose citations are not usable evidence is stored as the engine reports it (no_usable_citation)', async () => {
      const w = await newWorld();
      const run = await startRun(db, w);
      await extractAndBind(w, run, { withAbsence: true });
      const scored = await scoreRun(db, w, run);
      const absence = scored.authorized.data.records.evidence.find((e) => e.kind === 'absence');
      expect(absence).toBeDefined();
      const i = scoredIndex(scored);
      const judgments = replaceAt([...scored.persist.judgments], i, {
        citations: [
          { evidenceId: absence?.id ?? '', directness: 'direct', specificity: 'exact', note: null },
        ],
      });
      const report = oracleScore(scored.authorized, judgments);
      const dimension = report.dimensions.find(
        (d) => d.id === scored.persist.judgments[i]?.dimensionId,
      );
      expect(dimension).toMatchObject({
        state: 'insufficient_evidence',
        reason: 'no_usable_citation',
      });
      const result = await store.persist({ ...scored.persist, report, judgments });
      expect(result.kind).toBe('persisted');
    });

    it('inconsistent judgment records are refused with their own code before the engine runs (a downgraded unit cannot keep citations)', async () => {
      const { scored, run } = await prepared();
      const i = scoredIndex(scored);
      const error = await rejection(
        edit(scored, (j) =>
          replaceAt(j, i, {
            outcomeKind: 'insufficient_evidence',
            score: null,
            disposition: 'event_reference_only',
          }),
        ),
      );
      expect(error.code).toBe('judgments_invalid');
      expect(error.message).toContain('citations_not_allowed');
      await expectNothingWritten(run.runId);
    });

    it('fallback anchors stay disabled: persistence refuses any fallback-anchor version', async () => {
      const { scored, run } = await prepared();
      const error = await rejection({
        ...scored.persist,
        fallbackAnchorsVersion: 'fallback-anchors/v1',
      });
      expect(error.code).toBe('judgments_invalid');
      await expectNothingWritten(run.runId);
    });

    describe('direct SQL: the database checks the REPRESENTATION (not the M4 calculation, which only the recomputation proves)', () => {
      /** Writes an assessment, its judgments and its citations by hand, then runs the COMMIT-time completeness check at once. */
      async function writeByHand(
        scored: ScoredRun,
        runId: string,
        tweak: (judgments: JudgmentInput[]) => JudgmentInput[] = (j) => j,
      ) {
        const stored = storedFormOf(scored.report);
        return probe(db, async (tx) => {
          await tx.execute(sql`INSERT INTO pre_interview_assessments
            (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
             extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
             input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
             pipeline_config_hash, provider_mode)
            SELECT p.id, p.event_id, ${runId}, 1, i.assessment_key, i.context_version_id, i.locked_content_hash,
                   (SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${runId}),
                   (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${runId} AND kind = 'source'),
                   (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${runId} AND kind = 'context_evidence'),
                   i.target_kind, ${scored.report.engineVersion}, ${scored.report.parametersHash}, ${scored.report.rubric.fingerprint},
                   ${scored.report.rubric.source}, ${scored.report.inputFingerprint}, ${scored.report.graphFingerprint},
                   ${scored.report.outputHash}, ${stored.reportCanonical}, ${stored.reportTextSha256},
                   ${stored.reportCanonical}::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
            FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${runId}`);
          for (const [position, j] of tweak([...scored.persist.judgments]).entries()) {
            await tx.execute(sql`INSERT INTO assessment_dimension_judgments
              (assessment_id, project_id, dimension_id, position, outcome_kind, score, disposition, assessor_attempts, critic_attempts,
               assessor_call_seqs, critic_call_seqs, critic_review_required, critic_reviewed)
              SELECT a.id, a.project_id, ${j.dimensionId}, ${position}, ${j.outcomeKind}, ${j.score}, ${j.disposition},
                     ${j.assessorAttempts}, ${j.criticAttempts}, ${sql.raw(`ARRAY[${j.assessorCallSeqs.join(',')}]::integer[]`)},
                     ${sql.raw(`ARRAY[${j.criticCallSeqs.join(',')}]::integer[]`)}, ${j.criticReviewRequired}, ${j.criticReviewed}
                FROM pre_interview_assessments a WHERE a.run_id = ${runId}`);
            for (const [index, c] of j.citations.entries()) {
              await tx.execute(sql`INSERT INTO assessment_judgment_citations
                (assessment_id, project_id, dimension_id, position, evidence_id, directness, specificity)
                SELECT a.id, a.project_id, ${j.dimensionId}, ${index}, ${c.evidenceId}, ${c.directness}, ${c.specificity}
                  FROM pre_interview_assessments a WHERE a.run_id = ${runId}`);
            }
          }
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'succeeded', finished_at = now() WHERE id = ${runId}`,
          );
          await tx.execute(sql`SET CONSTRAINTS pre_interview_assessments_completeness IMMEDIATE`);
        });
      }

      it('control: honest judgments written by hand pass the completeness check', async () => {
        const { scored, run } = await prepared();
        expect(await writeByHand(scored, run.runId)).toBe('accepted');
      });

      it('a different stored score, outcome or citation list than the report describes is refused', async () => {
        const { scored, run } = await prepared();
        const i = scoredIndex(scored);
        const first = scored.persist.judgments[i];
        await expectPgMessage(
          writeByHand(scored, run.runId, (j) => replaceAt(j, i, { score: 2.5 })),
          'differs from the score on the report',
        );
        await expectPgMessage(
          writeByHand(scored, run.runId, (j) => replaceAt(j, i, { citations: [] })),
          'citations stored for',
        );
        // same citations, but the judgment now claims insufficiency while the report assessed the dimension
        await expectPgMessage(
          writeByHand(scored, run.runId, (j) =>
            replaceAt(j, i, {
              outcomeKind: 'insufficient_evidence',
              score: null,
              disposition: 'assessor_reported_insufficient',
              citations: first?.citations ?? [],
            }),
          ),
          'is not insufficient_evidence on the report',
        );
      });

      it('a scored judgment against a report dimension that is insufficient for another reason is refused', async () => {
        const { scored, run } = await prepared();
        const k = scored.persist.judgments.findIndex((j) => j.outcomeKind !== 'scored');
        expect(k).toBeGreaterThanOrEqual(0);
        await expectPgMessage(
          writeByHand(scored, run.runId, (j) =>
            replaceAt(j, k, { outcomeKind: 'scored', score: 5, disposition: 'scored' }),
          ),
          'neither assessed nor no_usable_citation',
        );
      });

      it('a report naming another event context than the run pinned is refused', async () => {
        const a = await prepared();
        const other = await prepared(
          await newWorld({ rules: 'Teams must have at most four members.' }),
        );
        // other's report names other's context version: written for a's run it must fail the identity columns / context checks
        const stored = storedFormOf(other.scored.report);
        await expectPgMessage(
          probe(db, async (tx) => {
            await tx.execute(sql`INSERT INTO pre_interview_assessments
              (project_id, event_id, run_id, version_number, assessment_key, context_version_id, locked_content_hash, pinned_snapshot_ids,
               extraction_id, context_extraction_id, target_kind, engine_version, parameters_hash, rubric_fingerprint, rubric_source,
               input_fingerprint, graph_fingerprint, output_hash, report_canonical, report_text_sha256, report, limitations,
               pipeline_config_hash, provider_mode)
              SELECT p.id, p.event_id, ${a.run.runId}, 1, i.assessment_key, i.context_version_id, i.locked_content_hash,
                     (SELECT array_agg(snapshot_id ORDER BY snapshot_id) FROM assessment_run_input_snapshots WHERE run_id = ${a.run.runId}),
                     (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${a.run.runId} AND kind = 'source'),
                     (SELECT extraction_id FROM assessment_run_extractions WHERE run_id = ${a.run.runId} AND kind = 'context_evidence'),
                     i.target_kind, ${other.scored.report.engineVersion}, ${other.scored.report.parametersHash}, ${other.scored.report.rubric.fingerprint},
                     ${other.scored.report.rubric.source}, ${other.scored.report.inputFingerprint}, ${other.scored.report.graphFingerprint},
                     ${other.scored.report.outputHash}, ${stored.reportCanonical}, ${stored.reportTextSha256},
                     ${stored.reportCanonical}::jsonb, '[]'::jsonb, i.pipeline_config_hash, 'scripted'
              FROM assessment_run_inputs i JOIN projects p ON p.id = i.project_id WHERE i.run_id = ${a.run.runId}`);
          }),
          'names another event context',
        );
      });
    });
  },
);
