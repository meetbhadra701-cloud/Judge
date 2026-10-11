import {
  claims,
  contradictions,
  evidenceItems,
  evidenceRelations,
  graphExtractionItems,
  unknowns,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_QUOTES, EVIDENCE_QUOTE } from '../testing/assessment-world.js';
import { FakeModel, ok } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment } from '../testing/run.js';

/*
 * The extraction stages S2-S6 at the level of the whole run (design §4.5, §9.3 rows 1-5): which failures drop an item, which downgrade
 * it and which end the run.
 */

const limitationsOf = async (run: Awaited<ReturnType<typeof execute>>) => {
  const [assessment] = await run.assessments();
  return (assessment?.limitations ?? []) as { code: string; count: number; subjects: string[] }[];
};

describe.each(testDatabaseTargets())('extraction stages S2-S6 on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  describe('fidelity of paraphrases (S3b)', () => {
    const PARAPHRASE = 'The app persists every intake entry to a SQLite database.';
    const paraphrasing = (verdict: string) =>
      new FakeModel()
        .on('claim_extraction', (context) => ({
          claims: context.records
            .filter(
              (record) =>
                !('class' in record.meta) && record.body?.includes(CLAIM_QUOTES[0]) === true,
            )
            .map((record) => ({
              ref: 'p',
              text: PARAPHRASE,
              passage: record.handle,
              quote: CLAIM_QUOTES[0],
            })),
        }))
        .on('fidelity_review', (context) => ({
          verdicts: context.records.map((record) => ({ item: record.handle, verdict })),
        }));

    it('admits a paraphrase only with a faithful verdict, and the statement item still holds the verbatim words', async () => {
      const run = await execute(db, { model: paraphrasing('faithful') });
      expect(run.outcome.kind).toBe('succeeded');
      const rows = await db.select().from(claims).where(eq(claims.projectId, run.world.project.id));
      expect(rows.map((row) => row.text)).toEqual([PARAPHRASE]);
      const statements = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, run.world.project.id));
      expect(statements.find((row) => row.kind === 'claim')?.text).toBe(CLAIM_QUOTES[0]);
      const items = await db
        .select()
        .from(graphExtractionItems)
        .where(eq(graphExtractionItems.projectId, run.world.project.id));
      expect(items.some((item) => item.grounding === 'paraphrase_reviewed_faithful')).toBe(true);
    });

    it.each(['overstated', 'unfaithful', 'cannot_tell'])(
      'a %s paraphrase is replaced by the verbatim words and the downgrade is disclosed',
      async (verdict) => {
        const run = await execute(db, { model: paraphrasing(verdict) });
        expect(run.outcome.kind).toBe('succeeded');
        const rows = await db
          .select()
          .from(claims)
          .where(eq(claims.projectId, run.world.project.id));
        expect(rows.map((row) => row.text)).toEqual([CLAIM_QUOTES[0]]);
        const downgraded = (await limitationsOf(run)).find(
          (l) => l.code === 'paraphrase_replaced_by_verbatim',
        );
        expect(downgraded?.count).toBe(1);
      },
    );

    it('an unusable reviewer answer DOWNGRADES the batch instead of admitting anything unreviewed (and never fails the run)', async () => {
      const model = paraphrasing('faithful').on('fidelity_review', () => 'not a verdict list');
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      // the single re-ask was spent, then the batch took the downgrade path
      expect(run.model.callsOf('fidelity_review')).toHaveLength(2);
      const rows = await db.select().from(claims).where(eq(claims.projectId, run.world.project.id));
      expect(rows.map((row) => row.text)).toEqual([CLAIM_QUOTES[0]]); // verbatim, never the unreviewed paraphrase
      const fact = (
        await db
          .select()
          .from(evidenceItems)
          .where(eq(evidenceItems.projectId, run.world.project.id))
      ).find((row) => row.origin === 'github' && row.kind === 'fact');
      expect(fact?.text).toBe(EVIDENCE_QUOTE); // the interpreted fact is downgraded to its quote as well
      const codes = (await limitationsOf(run)).map((l) => l.code);
      expect(codes).toContain('paraphrase_replaced_by_verbatim');
      expect(codes).toContain('evidence_text_replaced_by_verbatim');
    });

    it('a reviewer that answers faithful to everything cannot raise any label (Option B)', async () => {
      const run = await execute(db, { model: paraphrasing('faithful') });
      const rows = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, run.world.project.id));
      expect(new Set(rows.map((row) => row.verificationLevel))).toEqual(
        new Set(['team_claim', 'unverified']),
      );
    });
  });

  describe('relations (S4, S4b)', () => {
    it('keeps a model-proposed relation only if an independent verifier agrees; a disagreement is dropped and recorded, never a contradiction', async () => {
      const model = new FakeModel().on('relation_verification', (context) => ({
        verdicts: context.records.map((record) => ({ pair: record.handle, verdict: 'unrelated' })),
      }));
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      const relations = await db
        .select()
        .from(evidenceRelations)
        .where(eq(evidenceRelations.projectId, run.world.project.id));
      // only the code-authored statement relations remain; no independent observation, no contradiction
      expect(relations).toHaveLength(3);
      expect(
        (
          await db
            .select()
            .from(graphExtractionItems)
            .where(eq(graphExtractionItems.projectId, run.world.project.id))
        )
          .filter((item) => item.recordType === 'relation')
          .every((item) => item.relationBasis === 'source_statement'),
      ).toBe(true);
      expect(
        await db
          .select()
          .from(contradictions)
          .where(eq(contradictions.projectId, run.world.project.id)),
      ).toHaveLength(0);
      const dropped = (await limitationsOf(run)).find(
        (l) => l.code === 'relation_dropped_by_verifier',
      );
      expect(dropped?.count).toBe(2);
    });

    it('verifies EVERY candidate relation: a verifier answer that omits a pair drops it', async () => {
      const model = new FakeModel().on('relation_verification', () => ({ verdicts: [] }));
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      expect(run.model.callsOf('relation_verification')).toHaveLength(2); // the single re-ask, then the pairs are dropped
      const relations = await db
        .select()
        .from(evidenceRelations)
        .where(eq(evidenceRelations.projectId, run.world.project.id));
      expect(relations).toHaveLength(3);
    });
  });

  describe('commentary (S5, S6)', () => {
    it('drops an accusation, counts it, and keeps neutral commentary', async () => {
      const model = new FakeModel().on('contradiction_detection', (context) => {
        const claim = context.records.filter((r) => r.handle.startsWith('C-'));
        return {
          contradictions: [
            {
              sideA: { type: 'claim', handle: claim[0]?.handle },
              sideB: { type: 'claim', handle: claim[1]?.handle },
              description: 'The team is lying about the offline claim.',
            },
            {
              sideA: { type: 'claim', handle: claim[0]?.handle },
              sideB: { type: 'claim', handle: claim[2]?.handle },
              description: 'Two statements describe the reminder interval differently.',
            },
          ],
        };
      });
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      const rows = await db
        .select()
        .from(contradictions)
        .where(eq(contradictions.projectId, run.world.project.id));
      expect(rows.map((row) => row.description)).toEqual([
        'Two statements describe the reminder interval differently.',
      ]);
      const rejected = (await limitationsOf(run)).find((l) => l.code === 'contradiction_rejected');
      expect(rejected?.subjects).toContain('accusatory_language');
    });

    it('records model unknowns beside the code-authored gaps; a model cannot author a `missing` unknown', async () => {
      const ok1 = new FakeModel().on('unknown_identification', (context) => ({
        unknowns: [
          {
            unknownType: 'unverifiable',
            text: 'The offline claim cannot be checked from the sources.',
            claims: [context.records.find((r) => r.handle.startsWith('C-'))?.handle],
            evidence: [],
          },
        ],
      }));
      const run = await execute(db, { model: ok1 });
      expect(run.outcome.kind).toBe('succeeded');
      const rows = await db
        .select()
        .from(unknowns)
        .where(eq(unknowns.projectId, run.world.project.id));
      expect(rows.filter((row) => row.unknownType === 'unverifiable')).toHaveLength(1);
      expect(rows.filter((row) => row.unknownType === 'missing')).toHaveLength(2);

      const forged = new FakeModel().on('unknown_identification', () => ({
        unknowns: [
          {
            unknownType: 'missing',
            text: 'Nothing was provided for deployment.',
            claims: [],
            evidence: [],
          },
        ],
      }));
      const bad = await execute(db, { model: forged });
      // the schema has no `missing` type for a model: invalid even after the re-ask, so the extraction (and the run) fails
      expect(bad.outcome).toMatchObject({ kind: 'failed', category: 'schema_validation_failed' });
    });
  });

  describe('an extraction answer that stays structurally invalid fails the run (design §9.3 row 5)', () => {
    it.each([
      [
        'claim_extraction',
        'schema_validation_failed',
        'extraction_output_invalid_claim_extraction',
      ],
      [
        'evidence_interpretation',
        'schema_validation_failed',
        'extraction_output_invalid_evidence_interpretation',
      ],
      [
        'relation_matching',
        'schema_validation_failed',
        'extraction_output_invalid_relation_matching',
      ],
      [
        'relation_verification',
        'schema_validation_failed',
        'extraction_output_invalid_relation_verification',
      ],
      [
        'contradiction_detection',
        'schema_validation_failed',
        'extraction_output_invalid_contradiction_detection',
      ],
      [
        'unknown_identification',
        'schema_validation_failed',
        'extraction_output_invalid_unknown_identification',
      ],
    ] as const)('%s', async (stage, category, code) => {
      const model = new FakeModel().failing(stage, () => ok(['not', 'an', 'object']));
      const run = await execute(db, { model });
      expect(run.outcome).toMatchObject({ kind: 'failed', category, code });
      expect(run.model.callsOf(stage)).toHaveLength(2); // the answer, and the single re-ask
      await expectNoAssessment(run, db);
      // an incomplete extraction was NOT written
      expect(
        await db.select().from(claims).where(eq(claims.projectId, run.world.project.id)),
      ).toHaveLength(0);
    });
  });
});
