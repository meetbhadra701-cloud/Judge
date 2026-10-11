import {
  evidenceItems,
  preInterviewAssessments,
  unknowns,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModel, parseRecords } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';

interface Dimension {
  state: string;
  confidence: number;
  evidenceStrength?: number;
}
const dimensionsOf = (report: unknown): Dimension[] =>
  (report as { dimensions: Dimension[] }).dimensions;

describe.each(testDatabaseTargets())('source coverage on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  describe('a Devpost-only submission (no repository, no deployment, no video)', () => {
    it('succeeds honestly: statements only, never above the team-claim ceiling, with the gaps stated', async () => {
      const run = await execute(db, { worldOptions: { sources: ['devpost'] } });
      expect(run.outcome.kind).toBe('succeeded');
      const stages = (await run.calls()).map((call) => call.stage);
      // no repository passage: no interpretation, no fidelity review (claims are verbatim), no relation to verify
      expect(stages).not.toContain('evidence_interpretation');
      expect(stages).not.toContain('fidelity_review');
      expect(stages).not.toContain('relation_verification');
      expect(stages.filter((stage) => stage === 'dimension_assessment')).toHaveLength(2);

      const evidence = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, run.world.project.id));
      const project = evidence.filter((row) => row.origin !== 'event_context');
      expect(project.length).toBeGreaterThan(0);
      expect(
        project.every((row) => row.kind === 'claim' && row.verificationLevel === 'team_claim'),
      ).toBe(true);
      expect(
        evidence.some(
          (row) =>
            row.origin === 'github' || (row.kind === 'fact' && row.origin !== 'event_context'),
        ),
      ).toBe(false);

      const [assessment] = await run.assessments();
      const dims = dimensionsOf(assessment?.report);
      expect(dims).toHaveLength(2);
      for (const dim of dims) {
        expect(dim.state).toBe('assessed');
        expect(dim.evidenceStrength ?? 1).toBeLessThanOrEqual(0.35);
        expect(dim.confidence).toBeLessThanOrEqual(0.35);
      }
      const overall = (assessment?.report as { overall: { confidence: number } }).overall;
      expect(overall.confidence).toBeLessThanOrEqual(0.35);

      // a missing source is a code-authored gap the judge sees, never negative evidence
      const gaps = (
        await db.select().from(unknowns).where(eq(unknowns.projectId, run.world.project.id))
      )
        .filter((unknown) => unknown.unknownType === 'missing')
        .map((unknown) => unknown.text);
      expect(gaps).toHaveLength(3);
      expect(gaps.some((text) => text.startsWith('The GitHub repository was not provided'))).toBe(
        true,
      );
    });

    it('tells the critic that the evidence is only team-authored (a flag it cannot waive)', async () => {
      const run = await execute(db, { worldOptions: { sources: ['devpost'] } });
      const critic = run.model.callsOf('critic');
      expect(critic).toHaveLength(2);
      for (const call of critic) {
        const flags = parseRecords(call.request).find((record) => record.handle === 'FLAGS');
        expect(flags?.meta['flags']).toContain('only_team_authored_evidence');
      }
    });

    it('cannot score a unit from team statements as if they corroborated code: nothing is promoted', async () => {
      const model = new FakeModel().on('dimension_assessment', (context) => {
        const rubric = context.records.find((record) => record.handle === 'RUBRIC');
        return {
          dimensionId: String(rubric?.meta['dimensionId']),
          outcome: { kind: 'scored', score: 10 },
          citations: context.records
            .filter((record) => record.meta['authorship'] === 'team_statement')
            .slice(0, 2)
            .map((record) => ({
              evidence: record.handle,
              directness: 'direct',
              specificity: 'exact',
              note: 'The team says the code does this.',
            })),
          rationale: 'The code corroborates the claim.',
          limitations: [],
        };
      });
      const run = await execute(db, { worldOptions: { sources: ['devpost'] }, model });
      expect(run.outcome.kind).toBe('succeeded');
      const [assessment] = await run.assessments();
      // even a perfect self-assessment rests on team_claim evidence: the strength ceiling holds
      for (const dim of dimensionsOf(assessment?.report)) {
        expect(dim.evidenceStrength ?? 1).toBeLessThanOrEqual(0.35);
      }
      const rows = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, run.world.project.id));
      expect(rows.some((row) => row.verificationLevel === 'repo_corroborated')).toBe(false);
    });
  });

  describe('a failed repository capture', () => {
    it('is a stated gap, not negative evidence, and the run still succeeds on what was captured', async () => {
      const run = await execute(db, {
        worldOptions: { sources: ['devpost'], failed: ['github'] },
      });
      expect(run.outcome.kind).toBe('succeeded');
      const gaps = (
        await db.select().from(unknowns).where(eq(unknowns.projectId, run.world.project.id))
      )
        .filter((unknown) => unknown.unknownType === 'missing')
        .map((unknown) => unknown.text);
      expect(gaps).toContain(
        'The GitHub repository could not be captured, so none of its content was available. Nothing is inferred about the project from this gap.',
      );
      const rows = await db
        .select()
        .from(evidenceItems)
        .where(eq(evidenceItems.projectId, run.world.project.id));
      expect(rows.some((row) => row.origin === 'github')).toBe(false);
    });
  });

  it('fails source_unavailable, spending nothing, when no pinned text can be shown to a model', async () => {
    // a repository whose files hold no visible character: windowing drops them, so there is nothing a model could be shown
    const run = await execute(db, {
      worldOptions: { sources: ['github'], readmeText: '   \n \n', codeText: '\n\n' },
    });
    expect(run.outcome).toMatchObject({ kind: 'failed', category: 'source_unavailable' });
    expect(await run.calls()).toHaveLength(0);
    const rows = await db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.projectId, run.world.project.id));
    expect(rows).toHaveLength(0);
  });
});
