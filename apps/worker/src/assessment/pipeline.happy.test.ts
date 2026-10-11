import {
  analysisRuns,
  assessmentRunCalls,
  assessmentRunExtractions,
  assessmentRunOutcomes,
  evidenceItems,
  evidenceRelations,
  graphExtractionItems,
  preInterviewAssessments,
  unknowns,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ScriptedProvider } from '@judge-copilot/llm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, requestRun, seedWorld } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { countTransactions, ProbeProvider } from '../testing/probes.js';
import { runAssessment } from './pipeline.js';

describe.each(testDatabaseTargets())(
  'the assessment pipeline, complete official-rubric run on %s',
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

    async function completeRun() {
      const world = await seedWorld(db);
      const model = new FakeModel();
      const scripted = new ScriptedProvider([model.step], { repeatLast: true });
      const counting = countTransactions(db);
      const probe = new ProbeProvider(scripted, counting.open);
      const h = harness(counting.db);
      const runId = await requestRun(h, world, probe);
      const outcome = await runAssessment(h.deps(probe), runId);
      return { world, model, probe, counting, h, runId, outcome };
    }

    it('runs S0-S14 and persists one immutable assessment that re-verifies', async () => {
      const { runId, outcome, h } = await completeRun();
      expect(outcome).toMatchObject({ kind: 'succeeded', versionNumber: 1 });
      if (outcome.kind !== 'succeeded') return;
      const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      expect(run).toMatchObject({ state: 'succeeded', failureCategory: null });
      const [assessment] = await db
        .select()
        .from(preInterviewAssessments)
        .where(eq(preInterviewAssessments.runId, runId));
      expect(assessment?.id).toBe(outcome.assessmentId);
      expect(assessment?.providerMode).toBe('scripted');
      expect(assessment?.targetKind).toBe('overall');
      const verified = await h.store.getVerified(outcome.assessmentId);
      expect(verified).toMatchObject({ verified: true, failed: null });
      const [out] = await db
        .select()
        .from(assessmentRunOutcomes)
        .where(eq(assessmentRunOutcomes.runId, runId));
      expect(out).toMatchObject({ outcome: 'succeeded', failureCode: null });
    });

    it('performs exactly the planned calls, every one reserved, settled and bound to its closed set', async () => {
      const { runId, model } = await completeRun();
      const calls = await db
        .select()
        .from(assessmentRunCalls)
        .where(eq(assessmentRunCalls.runId, runId));
      const byStage = (stage: string) => calls.filter((call) => call.stage === stage).length;
      expect({
        claims: byStage('claim_extraction'),
        evidence: byStage('evidence_interpretation'),
        fidelity: byStage('fidelity_review'),
        matching: byStage('relation_matching'),
        verification: byStage('relation_verification'),
        contradictions: byStage('contradiction_detection'),
        unknowns: byStage('unknown_identification'),
        assessor: byStage('dimension_assessment'),
        critic: byStage('critic'),
      }).toEqual({
        claims: 1,
        evidence: 1,
        fidelity: 1,
        matching: 1,
        verification: 1,
        contradictions: 1,
        unknowns: 1,
        assessor: 2,
        critic: 2,
      });
      expect(calls).toHaveLength(model.calls.length);
      for (const call of calls) {
        expect(call).toMatchObject({
          state: 'settled',
          outcomeCode: 'ok',
          providerMode: 'scripted',
        });
        expect(call.closedSetHash).toMatch(/^[0-9a-f]{64}$/);
        expect(call.requestDigest).toMatch(/^[0-9a-f]{64}$/);
        // the ledger keeps identities, handles and the model's bounded ANSWER: no prompt, boundary, marker or system text is stored
        const stored = JSON.stringify(call);
        expect(stored).not.toContain('UNTRUSTED PROJECT DATA');
        expect(stored).not.toContain('<<<ITEM');
        expect(stored).not.toContain('MARKERS FOR THIS REQUEST');
      }
      // a dimension call names its dimension; an extraction call names none
      const assessor = calls.filter((call) => call.stage === 'dimension_assessment');
      expect(assessor.map((call) => call.dimensionId).sort()).toEqual([
        'official.problem_fit',
        'official.usability',
      ]);
    });

    it('holds no transaction open and never overlaps two calls while a provider is called', async () => {
      const { probe, counting } = await completeRun();
      expect(probe.records.length).toBeGreaterThanOrEqual(11);
      expect(probe.records.every((record) => record.openTransactions === 0)).toBe(true);
      expect(probe.maxConcurrent).toBe(1);
      expect(probe.records.every((record) => record.concurrent === 1)).toBe(true);
      // the stores did use transactions (reserve, settle, writes): the probe is not vacuous
      expect(counting.total()).toBeGreaterThan(20);
      expect(counting.open()).toBe(0);
    });

    it('records what the pipeline built: statements, relation bases, gap unknowns, and no label above team_claim / unverified', async () => {
      const { runId, world } = await completeRun();
      const rows = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, world.project.id));
      const levels = new Set(rows.map((row) => row.verificationLevel));
      expect([...levels].sort()).toEqual(['team_claim', 'unverified']);
      expect(rows.some((row) => row.verificationLevel === 'repo_corroborated')).toBe(false);
      // team statements are claim evidence; the interpreted code fact is unverified; the event rule is a reference
      expect(
        rows
          .filter((row) => row.kind === 'claim')
          .every((row) => row.verificationLevel === 'team_claim'),
      ).toBe(true);
      const fact = rows.find((row) => row.origin === 'github' && row.kind === 'fact');
      expect(fact?.verificationLevel).toBe('unverified');
      expect(rows.find((row) => row.origin === 'event_context')?.verificationLevel).toBe(
        'unverified',
      );
      const items = await db
        .select()
        .from(graphExtractionItems)
        .where(eq(graphExtractionItems.projectId, world.project.id));
      const bases = items
        .filter((item) => item.recordType === 'relation')
        .map((item) => item.relationBasis);
      expect(bases.filter((basis) => basis === 'source_statement').length).toBeGreaterThanOrEqual(
        3,
      );
      expect(bases).toContain('independent_observation');
      const relationRows = await db
        .select()
        .from(evidenceRelations)
        .where(eq(evidenceRelations.projectId, world.project.id));
      expect(relationRows.every((relation) => relation.relationType === 'supports')).toBe(true);
      const gaps = (
        await db.select().from(unknowns).where(eq(unknowns.projectId, world.project.id))
      ).filter((unknown) => unknown.unknownType === 'missing');
      // deployment and video were never provided: a gap the judge sees, never a deduction
      expect(gaps.map((gap) => gap.text).sort()).toEqual([
        'The deployment was not provided for this project. Nothing is inferred about the project from this gap.',
        'The video was not provided for this project. Nothing is inferred about the project from this gap.',
      ]);
      const bound = await db
        .select()
        .from(assessmentRunExtractions)
        .where(eq(assessmentRunExtractions.runId, runId));
      expect(bound.map((row) => row.kind).sort()).toEqual(['context_evidence', 'source']);
    });

    it('stores judgments whose citations are members of the run, each critic-reviewed', async () => {
      const { h, runId, outcome, world } = await completeRun();
      expect(outcome.kind).toBe('succeeded');
      if (outcome.kind !== 'succeeded') return;
      const judgments = await h.store.judgments(outcome.assessmentId);
      expect(judgments.map((j) => j.dimensionId)).toEqual([
        'official.problem_fit',
        'official.usability',
      ]);
      for (const judgment of judgments) {
        expect(judgment).toMatchObject({
          outcomeKind: 'scored',
          disposition: 'scored',
          score: 7,
          assessorAttempts: 1,
          criticAttempts: 1,
          criticReviewed: true,
        });
        expect(judgment.citations.length).toBeGreaterThan(0);
        expect(judgment.assessorCallSeqs).toHaveLength(1);
      }
      const members = await db
        .select()
        .from(graphExtractionItems)
        .where(eq(graphExtractionItems.projectId, world.project.id));
      const memberIds = new Set(members.map((member) => member.recordId));
      for (const citation of judgments.flatMap((j) => j.citations)) {
        expect(memberIds.has(citation.evidenceId)).toBe(true);
      }
      expect(runId).toBeTruthy();
    });
  },
);
