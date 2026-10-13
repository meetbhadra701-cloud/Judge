/*
 * Test-and-demonstration tooling (excluded from the build): everything a person needs to run the OFFLINE replay demonstration from a clean
 * checkout, and nothing else.
 *
 *   recordReplayFixture()  runs the hand-written scripted model once over the built-in synthetic HydroTrack project and writes down each answer
 *                          under the digest the REPLAY provider will compute, as a `replay-fixtures/v1` file. These answers were written by hand
 *                          in this repository; no model produced them.
 *   seedDemo(db)           puts a clearly labelled synthetic hackathon (locked Event Context) and the synthetic project into a database.
 *
 * A replay answer is looked up by the digest of the exact request, so the fixture answers ONLY this synthetic material. Material a person submits
 * through the submit page has no recorded answer; the demonstration says so (docs/DEMO_RUNBOOK.md §1.5).
 */
import { type JudgeDatabase } from '@judge-copilot/database';
import { computeRequestDigest, ScriptedProvider, type ReplayFixtureFile } from '@judge-copilot/llm';
import { sql } from 'drizzle-orm';
import { seedWorld } from './assessment-world.js';
import { FakeModel } from './fake-model.js';
import { testDatabaseTargets } from './harness.js';
import { execute } from './run.js';

export const DEMO_EVENT_NAME = 'SYNTHETIC DEMO hackathon (offline replay)';
export const DEMO_PROJECT_NAME = 'SYNTHETIC DEMO project (HydroTrack)';

/** Records the replay fixture for the synthetic project, using a throwaway in-memory database. */
export async function recordReplayFixture(): Promise<ReplayFixtureFile> {
  const [, open] = testDatabaseTargets()[0] as [
    string,
    () => Promise<{ db: JudgeDatabase; close: () => Promise<void> }>,
  ];
  const scratch = await open();
  try {
    const entries: ReplayFixtureFile['entries'] = [];
    const recorder = new FakeModel();
    const run = await execute(scratch.db, {
      provider: new ScriptedProvider(
        [
          (request) => {
            const result = recorder.step(request);
            if (result.ok) {
              entries.push({
                requestDigest: computeRequestDigest({ ...request, provider: 'replay' }),
                stage: request.stage,
                note: 'synthetic: hand-authored by the repository, not produced by any model',
                output: result.json,
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                },
              });
            }
            return result;
          },
        ],
        { repeatLast: true },
      ),
    });
    if (run.outcome.kind !== 'succeeded') {
      throw new Error(`recording the synthetic demonstration failed: ${run.outcome.kind}`);
    }
    return { version: 'replay-fixtures/v1', synthetic: true, entries };
  } finally {
    await scratch.close();
  }
}

export interface DemoSeed {
  readonly eventId: string;
  readonly projectId: string;
}

/** Seeds the labelled synthetic hackathon and project. The database must already be migrated. */
export async function seedDemo(db: JudgeDatabase): Promise<DemoSeed> {
  const world = await seedWorld(db);
  // labels that cannot be mistaken for real data (names are the only mutable columns of these rows)
  await db.execute(sql`UPDATE events SET name = ${DEMO_EVENT_NAME} WHERE id = ${world.event.id}`);
  await db.execute(
    sql`UPDATE projects SET name = ${DEMO_PROJECT_NAME} WHERE id = ${world.project.id}`,
  );
  return { eventId: world.event.id, projectId: world.project.id };
}
