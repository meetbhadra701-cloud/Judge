import {
  analysisRuns,
  assessmentDimensionJudgments,
  assessmentJudgmentCitations,
  graphExtractions,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ScriptedProvider, type LlmProvider } from '@judge-copilot/llm';
import type { AssessmentStage } from '@judge-copilot/schemas';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  harness,
  relockContext,
  requestRun,
  seedWorld,
  testConfig,
  type World,
} from '../testing/assessment-world.js';
import { FakeModel, unitOf } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment } from '../testing/run.js';
import { runAssessment } from './pipeline.js';

/** Re-locks the event's context (superseding the pinned version) right before the Nth call of a stage. */
const relockBefore =
  (db: JudgeDatabase, world: World, stage: AssessmentStage, nth = 1) =>
  (inner: LlmProvider): LlmProvider => {
    let seen = 0;
    return {
      id: inner.id,
      mode: inner.mode,
      async generate(request, signal) {
        if (request.stage === stage) {
          seen += 1;
          if (seen === nth) await relockContext(db, world);
        }
        return inner.generate(request, signal);
      },
    };
  };

describe.each(testDatabaseTargets())(
  'the pinned context and the pipeline configuration on %s',
  (_name, open) => {
    let database: TestDatabase;
    let db: JudgeDatabase;
    beforeAll(async () => {
      database = await open();
      db = database.db;
    });
    afterAll(async () => {
      await database.close();
    });

    describe('context supersession (decision D3: cancel, never complete under a newer context)', () => {
      it('cancels before any spend when the pinned version was superseded after the request', async () => {
        const world = await seedWorld(db);
        const model = new FakeModel();
        const provider = new ScriptedProvider([model.step], { repeatLast: true });
        const h = harness(db);
        const runId = await requestRun(h, world, provider);
        await relockContext(db, world);
        const outcome = await runAssessment(h.deps(provider), runId);
        expect(outcome).toMatchObject({ kind: 'cancelled', code: 'context_superseded' });
        expect(model.calls).toHaveLength(0);
        const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
        expect(run).toMatchObject({ state: 'cancelled', failureCategory: null });
      });

      it('cancels when the context is superseded during extraction: the extraction survives, no assessment does', async () => {
        const world = await seedWorld(db);
        const run = await execute(db, {
          world,
          wrap: relockBefore(db, world, 'relation_matching'),
        });
        expect(run.outcome).toMatchObject({ kind: 'cancelled', code: 'context_superseded' });
        expect((await run.run())?.state).toBe('cancelled');
        await expectNoAssessment(run, db);
        // the paid-for extraction is complete and reusable
        const extractions = await db
          .select()
          .from(graphExtractions)
          .where(eq(graphExtractions.projectId, world.project.id));
        expect(extractions.length).toBeGreaterThanOrEqual(1);
        expect(run.model.callsOf('dimension_assessment')).toHaveLength(0);
      });

      it('cancels at persistence when the context is superseded during assessment: scored work is discarded', async () => {
        const world = await seedWorld(db);
        const run = await execute(db, {
          world,
          wrap: relockBefore(db, world, 'dimension_assessment', 2),
        });
        expect(run.outcome).toMatchObject({
          kind: 'cancelled',
          code: 'context_superseded',
          stage: 'persist',
        });
        await expectNoAssessment(run, db);
        expect(await run.outcomeRow()).toMatchObject({
          outcome: 'cancelled',
          failureCode: 'context_superseded',
        });
        expect((await run.run())?.state).toBe('cancelled');
      });
    });

    describe('fail closed before any spend', () => {
      it('disables the fallback rubric: no official overall rubric means no run (anchors are unapproved)', async () => {
        const run = await execute(db, { worldOptions: { noRubric: true } });
        expect(run.outcome).toMatchObject({
          kind: 'failed',
          category: 'domain_validation_failed',
          code: 'fallback_anchors_not_approved',
        });
        expect(run.model.calls).toHaveLength(0);
        expect(await run.calls()).toHaveLength(0);
        await expectNoAssessment(run, db);
      });

      it('P6C F-3: a locked context with no reference evidence is refused when the run is REQUESTED, so no run, no worker time and no spend exist', async () => {
        // the request-time check (AssessmentRunStore) answers before any run is created; the worker-side failure
        // `no_context_reference_evidence` stays as defence in depth for a context that changed after the request
        await expect(execute(db, { worldOptions: { rules: [] } })).rejects.toThrow(
          /no_context_reference_evidence/,
        );
      });

      it('refuses a run whose frozen configuration is stale, for another provider mode, or unreadable', async () => {
        const world = await seedWorld(db);
        const provider = new ScriptedProvider([new FakeModel().step], { repeatLast: true });
        const good = testConfig(provider);
        const cases: [string, Record<string, unknown>][] = [
          [
            'pipeline_config_stale',
            {
              ...good,
              prompts: good.prompts.map((p, i) =>
                i === 0 ? { ...p, templateHash: 'a'.repeat(64) } : p,
              ),
            },
          ],
          ['provider_mode_mismatch', { ...good, provider: { id: 'scripted', mode: 'replay' } }],
          ['provider_id_mismatch', { ...good, provider: { id: 'someone-else', mode: 'scripted' } }],
          ['pipeline_config_invalid', { ...good, models: { extraction: 'x', assessment: 'y' } }],
          ['pipeline_config_invalid', { ...good, fallbackAnchorsVersion: 'fallback-anchors/v1' }],
        ];
        for (const [code, config] of cases) {
          const h = harness(db);
          const runId = await requestRun(h, world, provider, {
            config: config as unknown as ReturnType<typeof testConfig>,
            idempotencyKey: `cfg-${code}-${String(Math.random()).slice(2)}-abcdefgh`,
          });
          const outcome = await runAssessment(h.deps(provider), runId);
          expect(outcome, code).toMatchObject({ kind: 'failed', category: 'internal_error', code });
        }
        expect((provider as unknown as { requests: unknown[] }).requests).toHaveLength(0);
      });
    });

    describe('Event Context reference evidence is never project evidence (decision C4)', () => {
      const tracked = {
        trackKeys: ['health'],
        declare: ['health'],
      };

      it('shows the declared track as a reference and accepts it only as indirect, generic context', async () => {
        const model = new FakeModel().on('dimension_assessment', (context) => {
          const { dimensionId } = unitOf(context);
          const reference = context.records.find((r) => r.meta['authorship'] === 'event_reference');
          const statement = context.records.find((r) => r.meta['authorship'] === 'team_statement');
          return {
            dimensionId,
            outcome: { kind: 'scored', score: 6 },
            citations: [
              {
                evidence: statement?.handle,
                directness: 'direct',
                specificity: 'exact',
                note: 'The team says so.',
              },
              {
                evidence: reference?.handle,
                directness: 'indirect',
                specificity: 'generic',
                note: 'The track.',
              },
            ],
            rationale: 'Supported by a team statement; the track is context.',
            limitations: [],
          };
        });
        const run = await execute(db, { worldOptions: tracked, model });
        expect(run.outcome.kind).toBe('succeeded');
        if (run.outcome.kind !== 'succeeded') return;
        const citations = await db
          .select()
          .from(assessmentJudgmentCitations)
          .where(eq(assessmentJudgmentCitations.assessmentId, run.outcome.assessmentId));
        const references = citations.filter((c) => c.referenceApplicability !== null);
        expect(references.length).toBeGreaterThan(0);
        expect(
          references.every((c) => c.directness === 'indirect' && c.specificity === 'generic'),
        ).toBe(true);
        expect(
          references.every((c) => c.referenceTrackKey === 'health' || c.referenceTrackKey === null),
        ).toBe(true);
      });

      it('rejects a reference cited as direct, exact project evidence (invalid output, never a score)', async () => {
        const model = new FakeModel().on('dimension_assessment', (context) => {
          const { dimensionId } = unitOf(context);
          const reference = context.records.find((r) => r.meta['authorship'] === 'event_reference');
          return {
            dimensionId,
            outcome: { kind: 'scored', score: 9 },
            citations: [
              {
                evidence: reference?.handle,
                directness: 'direct',
                specificity: 'exact',
                note: 'The event requires it.',
              },
            ],
            rationale: 'The event rule proves it.',
            limitations: [],
          };
        });
        const run = await execute(db, { worldOptions: tracked, model });
        // both units technical: the run fails rather than persisting an assessment that rests on an event rule
        expect(run.outcome).toMatchObject({ kind: 'failed', category: 'domain_validation_failed' });
        await expectNoAssessment(run, db);
      });

      it('an event rule alone cannot support a score: the unit becomes insufficient (event_reference_only)', async () => {
        const model = new FakeModel().on('dimension_assessment', (context) => {
          const { dimensionId } = unitOf(context);
          const reference = context.records.find((r) => r.meta['authorship'] === 'event_reference');
          return {
            dimensionId,
            outcome: { kind: 'scored', score: 9 },
            citations: [
              {
                evidence: reference?.handle,
                directness: 'indirect',
                specificity: 'generic',
                note: 'Context.',
              },
            ],
            rationale: 'Only the rule is cited.',
            limitations: [],
          };
        });
        const run = await execute(db, { worldOptions: tracked, model });
        expect(run.outcome.kind).toBe('succeeded');
        if (run.outcome.kind !== 'succeeded') return;
        const rows = await db
          .select()
          .from(assessmentDimensionJudgments)
          .where(eq(assessmentDimensionJudgments.assessmentId, run.outcome.assessmentId));
        expect(rows.map((row) => row.disposition)).toEqual([
          'event_reference_only',
          'event_reference_only',
        ]);
        expect(rows.every((row) => row.score === null)).toBe(true);
        // a downgrade stores no citations: the scorer was handed none
        const citations = await db
          .select()
          .from(assessmentJudgmentCitations)
          .where(eq(assessmentJudgmentCitations.assessmentId, run.outcome.assessmentId));
        expect(citations).toHaveLength(0);
        // no critic call was spent on a unit that could not raise a score
        expect(run.model.callsOf('critic')).toHaveLength(0);
      });
    });
  },
);
