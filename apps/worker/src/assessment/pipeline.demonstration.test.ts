import { AssessmentReadStore, evidenceItems, type JudgeDatabase } from '@judge-copilot/database';
import { ScriptedProvider } from '@judge-copilot/llm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';
import { demonstrationStep } from './demonstration-model.js';

/*
 * P6C: the scripted demonstration provider runs the REAL pipeline on material the recorded replay fixture has never seen, and everything it
 * produces is labelled for what it is. These tests pin both halves: the workflow completes on arbitrary captured text, and nothing in the stored
 * assessment or its read model can be mistaken for a model's judgment of the project.
 */

const lines = (tag: string, count: number): string =>
  Array.from(
    { length: count },
    (_, i) => `The ${tag} component number ${String(i)} handles one part of the pipeline.`,
  ).join('\n');

describe.each(testDatabaseTargets())('scripted demonstration provider on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  const provider = () => new ScriptedProvider([demonstrationStep], { repeatLast: true });

  it('assesses captured material no recording exists for, with real citations into the real passages', async () => {
    const run = await execute(db, {
      provider: provider(),
      worldOptions: {
        extraFiles: [
          { path: 'docs/orbit.md', text: `# Orbit\n${lines('orbit', 6)}` },
          { path: 'packages/orbit/src/main.ts', text: lines('core', 12) },
        ],
      },
    });
    expect(run.outcome.kind).toBe('succeeded');
    const [assessment] = await run.assessments();
    const reads = new AssessmentReadStore(db);
    const detail = await reads.getDetail(run.world.project.id, assessment?.id ?? '');
    expect(detail?.verified).toBe(true);
    expect(detail?.providerMode).toBe('scripted');
    expect(detail?.replayDemonstration).toBe(true);
    expect(detail?.notices.replay).toContain('SCRIPTED DEMONSTRATION');
    expect(detail?.notices.replay).toContain('not a model assessment');

    // every scored dimension is the same placeholder: 70 % of the scale, with a rationale that says it was not produced by reading the project
    const scored = detail?.judgments.filter((j) => j.outcomeKind === 'scored') ?? [];
    expect(scored.length).toBeGreaterThan(0);
    expect(new Set(scored.map((j) => j.score))).toEqual(new Set([7]));
    for (const judgment of scored) {
      expect(judgment.rationale).toContain('SCRIPTED DEMONSTRATION');
      expect(judgment.rationale).toContain('not produced by reading the project');
      expect(judgment.citations.length).toBeGreaterThan(0);
      for (const citation of judgment.citations)
        expect(citation.evidence?.text.length).toBeGreaterThan(0);
    }
    expect(detail?.report?.overall.state).toBe('scored');

    // the evidence behind the citations is quoted from the captured material of THIS project, verbatim
    const items = (await db.select().from(evidenceItems)).filter(
      (row) => row.projectId === run.world.project.id,
    );
    expect(items.some((row) => (row.text ?? '').includes('orbit component number'))).toBe(true);
    expect(
      items.every(
        (row) =>
          row.verificationLevel !== 'machine_verified' &&
          row.verificationLevel !== 'judge_verified',
      ),
    ).toBe(true);
  });

  it('is listed as a scripted demonstration, never as a replay or a live assessment', async () => {
    const run = await execute(db, { provider: provider() });
    const reads = new AssessmentReadStore(db);
    const listed = await reads.list(run.world.project.id);
    expect(listed[0]).toMatchObject({ providerMode: 'scripted', replayDemonstration: true });
    expect(
      (
        await db
          .select({ id: evidenceItems.id })
          .from(evidenceItems)
          .where(eq(evidenceItems.projectId, run.world.project.id))
      ).length,
    ).toBeGreaterThan(0);
  });
});
