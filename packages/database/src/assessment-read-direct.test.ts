import { reportOutputHash } from '@judge-copilot/scoring';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentReadStore } from './assessment-read.js';
import { AssessmentStore, type JudgmentInput } from './assessment-store.js';
import type { JudgeDatabase } from './index.js';
import {
  extractAndBind,
  oracleScore,
  scoreRun,
  startRun,
  type ScoredRun,
} from './testing/assessment-pipeline.js';
import { seedAssessmentWorld, type AssessmentWorld } from './testing/assessment-world.js';
import { testDatabaseTargets, type TestDatabase } from './testing/databases.js';

/*
 * P6A-R2: the read model over assessments persisted DIRECTLY through the store, where the test controls the raw judgments, the evidence
 * kinds and the limitations (the worker pipeline cannot produce an absence-kind citation or an arbitrary raw score by itself).
 *
 *   P3-1  a scored judgment that cites only evidence of a kind M4 cannot use (absence) is persisted, and M4 reports the dimension as
 *         `insufficient_evidence / no_usable_citation`. That is a LEGITIMATE assessment and must be readable; before the fix its
 *         scored row was compared with an insufficient report dimension and the whole assessment was withheld.
 *   P2-1  raw scores with more than four decimals persist and verify.
 *   P3-3  an unverified assessment with NON-EMPTY limitations withholds them.
 */

describe.each(testDatabaseTargets())(
  'read model over directly persisted assessments on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let store: AssessmentStore;
    let reads: AssessmentReadStore;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      store = new AssessmentStore(db);
      reads = new AssessmentReadStore(db);
    });
    afterAll(async () => {
      await testDb.close();
    });

    const newWorld = () =>
      seedAssessmentWorld(db, {
        trackKeys: ['health', 'robotics'],
        declare: ['health'],
        rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      });

    async function prepared(options: { withAbsence?: boolean } = {}) {
      const world: AssessmentWorld = await newWorld();
      const run = await startRun(db, world);
      await extractAndBind(world, run, options.withAbsence ? { withAbsence: true } : {});
      const scored = await scoreRun(db, world, run);
      return { world, run, scored };
    }

    const scoredIndex = (s: ScoredRun) =>
      s.persist.judgments.findIndex((j) => j.outcomeKind === 'scored');
    const replaceAt = (judgments: JudgmentInput[], index: number, patch: Partial<JudgmentInput>) =>
      judgments.map((j, i) => (i === index ? { ...j, ...patch } : j));

    /** Persists `judgments` with the report M4 produces for them, and returns the stored assessment id. */
    async function persistWith(
      scored: ScoredRun,
      judgments: JudgmentInput[],
      limitations?: readonly string[],
    ) {
      const report = oracleScore(scored.authorized, judgments);
      const result = await store.persist({
        ...scored.persist,
        report,
        judgments,
        ...(limitations === undefined ? {} : { limitations: limitations }),
      });
      if (result.kind !== 'persisted') throw new Error(`not persisted: ${result.kind}`);
      return { id: result.assessmentId, report };
    }

    describe('P3-1: a judged value M4 did not use (only absence evidence cited)', () => {
      async function absenceCase() {
        const { world, scored } = await prepared({ withAbsence: true });
        const absence = scored.authorized.data.records.evidence.find((e) => e.kind === 'absence');
        expect(absence).toBeDefined();
        const i = scoredIndex(scored);
        const judgments = replaceAt([...scored.persist.judgments], i, {
          score: 7.33333,
          citations: [
            {
              evidenceId: absence?.id ?? '',
              directness: 'direct',
              specificity: 'exact',
              note: 'only an absence',
            },
          ],
        });
        const { id, report } = await persistWith(scored, judgments);
        const dimensionId = scored.persist.judgments[i]?.dimensionId ?? '';
        return { world, scored, id, report, dimensionId, absenceId: absence?.id ?? '' };
      }

      it('is readable: verified, no number for that dimension, the reason from the report, attributed to code', async () => {
        const { world, id, report, dimensionId, absenceId } = await absenceCase();
        expect(report.dimensions.find((d) => d.id === dimensionId)).toMatchObject({
          state: 'insufficient_evidence',
          reason: 'no_usable_citation',
        });
        const detail = await reads.getDetail(world.project.id, id);
        expect(detail).toMatchObject({ verified: true, verificationFailure: null });
        const judgment = detail?.judgments.find((j) => j.dimensionId === dimensionId);
        expect(judgment).toMatchObject({
          outcomeKind: 'insufficient_evidence',
          score: null,
          insufficiencyReason: 'no_usable_citation',
          dispositionAttribution: 'insufficient_by_code',
        });
        // the citation is still shown as cited (it is the assessor's citation), and the raw judged value is never returned
        expect(judgment?.citations.map((c) => c.evidenceId)).toEqual([absenceId]);
        // the raw judged value is not a judgment score anywhere; the VERIFIED REPORT's own diagnostic states that it was not used
        expect(JSON.stringify(detail?.judgments)).not.toContain('7.33333');
        expect(detail?.report?.diagnostics.map((d) => d.code)).toContain('JUDGED_VALUE_NOT_USED');
        const listed = (await reads.list(world.project.id)).find((item) => item.id === id);
        expect(listed).toMatchObject({ verified: true });
      });

      it('does not accept fabricated or foreign citations: a row citing different evidence than the report lists is withheld', async () => {
        const { world, scored, id, dimensionId, absenceId } = await absenceCase();
        const other = scored.authorized.data.records.evidence.find(
          (e) => e.id !== absenceId && e.kind !== 'absence',
        );
        expect(other).toBeDefined();
        await withTriggerOff(
          db,
          'assessment_judgment_citations',
          'assessment_judgment_citations_immutable_guard',
          [
            sql`UPDATE assessment_judgment_citations SET evidence_id = ${other?.id ?? ''} WHERE assessment_id = ${id} AND dimension_id = ${dimensionId}`,
          ],
        );
        const detail = await reads.getDetail(world.project.id, id);
        expect(detail).toMatchObject({
          verified: false,
          verificationFailure: 'judgment_mismatch_citations',
          judgments: [],
        });
      });

      it('an evidence id of ANOTHER project cannot be injected into a citation (the database refuses it, or the read model withholds the assessment)', async () => {
        const { world, id, dimensionId } = await absenceCase();
        const foreign = await prepared({ withAbsence: true });
        const foreignId = foreign.scored.authorized.data.records.evidence[0]?.id ?? '';
        let refused = false;
        try {
          await withTriggerOff(
            db,
            'assessment_judgment_citations',
            'assessment_judgment_citations_immutable_guard',
            [
              sql`UPDATE assessment_judgment_citations SET evidence_id = ${foreignId} WHERE assessment_id = ${id} AND dimension_id = ${dimensionId}`,
            ],
          );
        } catch {
          refused = true; // a foreign key or a trigger refused it
        }
        const detail = await reads.getDetail(world.project.id, id);
        if (!refused) {
          expect(detail?.verified).toBe(false);
          expect(JSON.stringify(detail)).not.toContain(foreignId);
        } else {
          expect(detail?.verified).toBe(true);
        }
      });
    });

    describe('P2-1: raw scores with more than four decimals', () => {
      it.each([7.33333, 6.666666666666667, 3.3333333333333335, 9.99995, 0.00005, 7.12345])(
        'a stored raw score of %s verifies and is shown at the report precision',
        async (raw) => {
          const { world, scored } = await prepared();
          const i = scoredIndex(scored);
          const { id, report } = await persistWith(
            scored,
            replaceAt([...scored.persist.judgments], i, { score: raw }),
          );
          const dimensionId = scored.persist.judgments[i]?.dimensionId ?? '';
          const reported = report.dimensions.find((d) => d.id === dimensionId);
          const detail = await reads.getDetail(world.project.id, id);
          expect(detail).toMatchObject({ verified: true });
          expect(reported?.state).toBe('assessed');
          const shown = detail?.judgments.find((j) => j.dimensionId === dimensionId)?.score;
          expect(shown).toBe(reported?.state === 'assessed' ? reported.scoreOnScale : undefined);
          expect(shown).not.toBe(
            raw === 3.3333333333333335 || raw === 6.666666666666667 || raw === 7.33333
              ? raw
              : undefined,
          );
        },
      );
    });

    describe('P3-3: an unverified assessment with non-empty limitations', () => {
      it('withholds the limitations (and the reported ones are real before the corruption)', async () => {
        const { world, scored } = await prepared();
        const limitations = [
          { code: 'source_sampled', count: 1, subjects: ['devpost'] },
          { code: 'official_track_rubrics_not_assessed', count: 1, subjects: ['Health'] },
        ];
        const { id } = await persistWith(
          scored,
          [...scored.persist.judgments],
          limitations as never,
        );
        const before = await reads.getDetail(world.project.id, id);
        expect(before?.verified).toBe(true);
        expect(before?.limitations.map((l) => l.code)).toEqual([
          'source_sampled',
          'official_track_rubrics_not_assessed',
        ]);

        await withTriggerOff(
          db,
          'pre_interview_assessments',
          'pre_interview_assessments_immutable_guard',
          [
            sql`UPDATE pre_interview_assessments SET report_text_sha256 = repeat('0', 64) WHERE id = ${id}`,
          ],
        );
        const after = await reads.getDetail(world.project.id, id);
        expect(after).toMatchObject({
          verified: false,
          verificationFailure: 'text_hash',
          limitations: [],
          judgments: [],
          report: null,
        });
        expect(JSON.stringify(after)).not.toContain('source_sampled');
        expect(JSON.stringify(after)).not.toContain('Health');
      });
    });

    it('an assessment with a different report hash but the same rows is still withheld (no reuse of another assessment’s hash)', async () => {
      const { world, scored } = await prepared();
      const { id, report } = await persistWith(scored, [...scored.persist.judgments]);
      expect(reportOutputHash).toBeTypeOf('function');
      expect(report.outputHash).toMatch(/^[0-9a-f]{64}$/);
      await withTriggerOff(
        db,
        'pre_interview_assessments',
        'pre_interview_assessments_immutable_guard',
        [sql`UPDATE pre_interview_assessments SET output_hash = repeat('1', 64) WHERE id = ${id}`],
      );
      expect(await reads.getDetail(world.project.id, id)).toMatchObject({
        verified: false,
        verificationFailure: 'stored_output_hash',
      });
    });
  },
);

/** Test-only: disables one immutability trigger for the statements, on a disposable database, and always re-enables it. */
async function withTriggerOff(
  db: JudgeDatabase,
  table: string,
  trigger: string,
  statements: ReturnType<typeof sql>[],
): Promise<void> {
  await db.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`));
  try {
    for (const statement of statements) await db.execute(statement);
  } finally {
    await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`));
  }
}
