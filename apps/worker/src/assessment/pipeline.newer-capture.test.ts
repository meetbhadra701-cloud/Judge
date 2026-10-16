import {
  preInterviewAssessments,
  sourceSnapshots,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';
import { seedWorld, type World } from '../testing/assessment-world.js';

/*
 * P6C F-8: a newer capture attempt that FAILED must not be hidden while an older capture is assessed. The older capture is still what is
 * scored (missing is not negative evidence), but the stored assessment says that the newest attempt of that source did not succeed.
 */

async function addAttempt(
  db: JudgeDatabase,
  world: World,
  sourceType: 'github' | 'devpost',
  status: 'failed' | 'rejected',
  captureNumber: number,
) {
  const base = world.snapshots[sourceType];
  if (!base) throw new Error('no such source in the world');
  const [row] = await db
    .insert(sourceSnapshots)
    .values({
      projectId: world.project.id,
      projectSourceId: base.source.id,
      captureNumber,
      sourceType,
      sourceUrl: base.snapshot.sourceUrl,
      status: 'pending',
    })
    .returning();
  if (!row) throw new Error('snapshot');
  const category = status === 'failed' ? 'timeout' : 'ssrf_rejected';
  await db.execute(sql`UPDATE source_snapshots SET status = ${status}, failure_category = ${category},
    failure_metadata = '{}'::jsonb, completed_at = now() WHERE id = ${row.id}`);
}

const limitationsOf = async (db: JudgeDatabase, runId: string) => {
  const rows = await db.select().from(preInterviewAssessments);
  const mine = rows.find((row) => row.runId === runId);
  return (mine?.limitations ?? []) as { code: string; count: number; subjects: string[] }[];
};

describe.each(testDatabaseTargets())('a failed newer capture on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  it('is disclosed as a limitation naming the source, while the older capture is still assessed', async () => {
    const world = await seedWorld(db, {});
    await addAttempt(db, world, 'github', 'failed', 2);
    const run = await execute(db, { world });
    expect(run.outcome.kind).toBe('succeeded');
    const limitation = (await limitationsOf(db, run.runId)).find(
      (l) => l.code === 'newer_capture_unusable',
    );
    expect(limitation).toMatchObject({ count: 1, subjects: ['github'] });
  });

  it('a rejected newer attempt is disclosed the same way', async () => {
    const world = await seedWorld(db, {});
    await addAttempt(db, world, 'devpost', 'rejected', 2);
    const run = await execute(db, { world });
    expect(run.outcome.kind).toBe('succeeded');
    const limitation = (await limitationsOf(db, run.runId)).find(
      (l) => l.code === 'newer_capture_unusable',
    );
    expect(limitation?.subjects).toEqual(['devpost']);
  });

  it('adds nothing when every source was captured last time, and never leaks another project’s failure', async () => {
    const other = await seedWorld(db, {});
    await addAttempt(db, other, 'github', 'failed', 2);
    const world = await seedWorld(db, {});
    const run = await execute(db, { world });
    expect(run.outcome.kind).toBe('succeeded');
    const codes = (await limitationsOf(db, run.runId)).map((l) => l.code);
    expect(codes).not.toContain('newer_capture_unusable');
  });

  it('does not change the score: the same material scores identically with or without the failed attempt', async () => {
    const plain = await seedWorld(db, {});
    const failed = await seedWorld(db, {});
    await addAttempt(db, failed, 'github', 'failed', 2);
    const a = await execute(db, { world: plain });
    const b = await execute(db, { world: failed });
    const overall = async (runId: string) => {
      const rows = await db.select().from(preInterviewAssessments);
      return (rows.find((row) => row.runId === runId)?.report as { overall: unknown }).overall;
    };
    expect(await overall(b.runId)).toEqual(await overall(a.runId));
  });
});
