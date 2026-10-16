import { analyzeUncertainty } from '@judge-copilot/uncertainty';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentStore } from './assessment-store.js';
import { QuestionInputReader } from './question-input-reader.js';
import type { JudgeDatabase } from './index.js';
import { extractAndBind, oracleScore, scoreRun, startRun } from './testing/assessment-pipeline.js';
import { seedAssessmentWorld } from './testing/assessment-world.js';
import { testDatabaseTargets, type TestDatabase } from './testing/databases.js';

/*
 * M6: the input of the uncertainty analysis is read from a VERIFIED assessment and its pinned records, scoped to the project in the request.
 */

describe.each(testDatabaseTargets())('question input reader on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let reader: QuestionInputReader;
  let store: AssessmentStore;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    reader = new QuestionInputReader(db);
    store = new AssessmentStore(db);
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function assessed() {
    const world = await seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      requirements: [
        { statement: 'Submit a demo video.', certainty: 'explicit', trackKey: null },
        { statement: 'Use the Health data API.', certainty: 'explicit', trackKey: 'health' },
        { statement: 'Use the robot arm kit.', certainty: 'explicit', trackKey: 'robotics' },
      ],
    });
    const run = await startRun(db, world);
    await extractAndBind(world, run, {});
    const scored = await scoreRun(db, world, run);
    const report = oracleScore(scored.authorized, scored.persist.judgments);
    const result = await store.persist({ ...scored.persist, report });
    if (result.kind !== 'persisted') throw new Error(`not persisted: ${result.kind}`);
    return { world, assessmentId: result.assessmentId, report };
  }

  it('reads a verified assessment into an input the analysis accepts, tied to the verified report', async () => {
    const { world, assessmentId, report } = await assessed();
    const read = await reader.read(world.project.id, assessmentId);
    expect(read.kind).toBe('ready');
    if (read.kind !== 'ready') return;
    expect(read.identity).toMatchObject({
      assessmentId,
      projectId: world.project.id,
      reportOutputHash: report.outputHash,
    });
    expect(read.input.dimensions.map((d) => d.id)).toEqual(report.dimensions.map((d) => d.id));
    // the analysis accepts it (every reference resolves) and every opportunity trail id is a stored id of the input
    const analysis = analyzeUncertainty(read.input);
    expect(analysis.engineVersion).toBe('uncertainty-engine/v1');
    const known = new Set<string>([
      ...read.input.dimensions.map((d) => d.id),
      ...read.input.evidence.map((e) => e.id),
      ...read.input.claims.map((c) => c.id),
      ...read.input.unknowns.map((u) => u.id),
      ...read.input.contradictions.map((c) => c.id),
      ...read.input.requirements.map((r) => r.id),
      ...read.input.tracks.declared.map((t) => t.key),
      'implementation_coverage',
      'missing_source:github',
      'missing_source:devpost',
    ]);
    for (const opportunity of analysis.opportunities) {
      for (const entry of opportunity.trail) {
        if (entry.type === 'coverage' && !known.has(entry.id)) continue;
        expect(known.has(entry.id), `${entry.type}:${entry.id}`).toBe(true);
      }
    }
  });

  it('carries only the tracks the project declared, and its requirements', async () => {
    const { world, assessmentId } = await assessed();
    const read = await reader.read(world.project.id, assessmentId);
    if (read.kind !== 'ready') throw new Error('expected a ready input');
    expect(read.input.tracks.declared.map((t) => t.key)).toEqual(['health']);
    expect(
      read.input.requirements.every((r) => r.trackKey === null || r.trackKey === 'health'),
    ).toBe(true);
  });

  it('answers not_found for another project and for an unknown assessment (no existence leak)', async () => {
    const { assessmentId } = await assessed();
    const other = await seedAssessmentWorld(db, {});
    expect(await reader.read(other.project.id, assessmentId)).toEqual({ kind: 'not_found' });
    expect(await reader.read(other.project.id, '00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'not_found',
    });
  });

  it('returns no content for an assessment that does not verify (fail closed)', async () => {
    const { world, assessmentId } = await assessed();
    await db.execute(sql`ALTER TABLE pre_interview_assessments DISABLE TRIGGER USER`);
    try {
      await db.execute(
        sql`UPDATE pre_interview_assessments SET report_text_sha256 = ${'0'.repeat(64)} WHERE id = ${assessmentId}`,
      );
    } finally {
      await db.execute(sql`ALTER TABLE pre_interview_assessments ENABLE TRIGGER USER`);
    }
    const read = await reader.read(world.project.id, assessmentId);
    expect(read.kind).toBe('unverified');
    expect(JSON.stringify(read)).not.toContain('dimensions');
  });

  it('ties the input to the verified report’s own output hash', async () => {
    const { world, assessmentId, report } = await assessed();
    const read = await reader.read(world.project.id, assessmentId);
    if (read.kind !== 'ready') throw new Error('expected a ready input');
    expect(read.input.assessment.reportOutputHash).toBe(report.outputHash);
  });
});
