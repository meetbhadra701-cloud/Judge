import { AssessmentReadStore, type JudgeDatabase } from '@judge-copilot/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';

/*
 * The API read model re-verifies the stored report on every read (P6A). An assessment whose stored report no longer verifies is
 * returned as NOT verified with no report and no number: a corrupted row must never be shown as an AI estimate.
 */

describe.each(testDatabaseTargets())('read model verification on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  it('a stored report that no longer verifies is not returned (no report, no number, verified=false)', async () => {
    const run = await execute(db);
    expect(run.outcome.kind).toBe('succeeded');
    const [assessment] = await run.assessments();
    const id = assessment?.id ?? '';
    const projectId = run.world.project.id;
    const reads = new AssessmentReadStore(db);

    const before = await reads.getDetail(projectId, id);
    expect(before).toMatchObject({ verified: true, verificationFailure: null });
    expect(before?.report).not.toBeNull();

    // simulate corruption of the immutable row: the guard trigger is disabled only for this statement
    await db.execute(
      sql`ALTER TABLE pre_interview_assessments DISABLE TRIGGER pre_interview_assessments_immutable_guard`,
    );
    try {
      await db.execute(
        sql`UPDATE pre_interview_assessments SET report = jsonb_set(report, '{overall,score10}', '10') WHERE id = ${id}`,
      );
    } finally {
      await db.execute(
        sql`ALTER TABLE pre_interview_assessments ENABLE TRIGGER pre_interview_assessments_immutable_guard`,
      );
    }

    const after = await reads.getDetail(projectId, id);
    expect(after).toMatchObject({ verified: false, report: null });
    expect(after?.verificationFailure).not.toBeNull();
    expect(JSON.stringify(after)).not.toContain('"score10":10');
    const listed = (await reads.list(projectId))[0];
    expect(listed).toMatchObject({ verified: false, overall: null });
  });
});
