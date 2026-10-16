import { buildCoverageRecord, buildPassages, SELECTION_POLICY } from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunError } from './assessment-run-store.js';
import type { JudgeDatabase } from './index.js';
import { startRun } from './testing/assessment-pipeline.js';
import { seedAssessmentWorld, type AssessmentWorldOptions } from './testing/assessment-world.js';
import { rows, sql, testDatabaseTargets, type TestDatabase } from './testing/databases.js';

// P6C F-3: a context with nothing to refer to is refused at request time, so these fixtures state one explicit rule
const EXPLICIT_RULE: AssessmentWorldOptions = {
  rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
};

/*
 * P6B-beta3-R1: the store writes the coverage record only for the run that holds the lease, only for the snapshots the run pinned, only
 * in canonical form, and never replaces a record. Each refusal is checked here at the store; the database's own guards are in the worker tests.
 */

describe.each(testDatabaseTargets())('coverage record store on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });
  afterAll(async () => {
    await testDb.close();
  });

  const text = Array.from({ length: 40 }, (_, i) => `const v${String(i)} = ${String(i)};`).join(
    '\n',
  );
  async function prepared() {
    const world = await seedAssessmentWorld(db, EXPLICIT_RULE);
    const run = await startRun(db, world);
    const pins = await rows<{ snapshot_id: string; snapshot_content_hash: string }>(
      db,
      sql`SELECT snapshot_id, snapshot_content_hash FROM assessment_run_input_snapshots WHERE run_id = ${run.runId}`,
    );
    const budgets = { statement: 6_000, source: 6_000, metadata: 1_000 };
    const windowing = buildPassages(
      [
        {
          snapshotId: pins[0]?.snapshot_id ?? '',
          artifactId: '11111111-1111-4111-8111-111111111111',
          sourceType: 'github',
          snapshotStatus: 'captured',
          key: 'files/src/index.ts',
          kind: 'file',
          mediaType: 'text/plain',
          text,
        },
      ],
      budgets,
      SELECTION_POLICY,
    );
    const build = (snapshotIds: string[], extra: { notices?: string[] } = {}) =>
      buildCoverageRecord({
        windowing,
        budgets,
        snapshots: snapshotIds.map((snapshotId) => ({
          snapshotId,
          sourceType: 'github' as const,
          status: 'captured' as const,
          contentHash: 'c'.repeat(64),
          provenance: 'fetched' as const,
          partialReasons: [],
        })),
        notices: extra.notices ?? [],
      });
    return { world, run, pinned: pins.map((p) => p.snapshot_id), build };
  }
  const countFor = async (runId: string) =>
    (
      await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM assessment_run_coverage WHERE run_id = ${runId}`,
      )
    )[0]?.n;
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      return error instanceof AssessmentRunError ? error.code : `other:${String(error)}`;
    }
    return 'accepted';
  };

  it('stores the record of the pinned snapshots, and an identical retry is a no-op', async () => {
    const { run, pinned, build } = await prepared();
    const built = build(pinned);
    await run.store.recordCoverage(run.runId, run.leaseToken, built);
    await run.store.recordCoverage(run.runId, run.leaseToken, built);
    expect(await countFor(run.runId)).toBe(1);
  });

  it('refuses a record that names other snapshots than the run pinned, or only some of them', async () => {
    const { run, pinned, build } = await prepared();
    expect(
      await codeOf(
        run.store.recordCoverage(
          run.runId,
          run.leaseToken,
          build(['00000000-0000-4000-8000-0000000000aa']),
        ),
      ),
    ).toBe('coverage_rejected');
    expect(
      await codeOf(
        run.store.recordCoverage(
          run.runId,
          run.leaseToken,
          build([...pinned, '00000000-0000-4000-8000-0000000000bb']),
        ),
      ),
    ).toBe('coverage_rejected');
    expect(await countFor(run.runId)).toBe(0);
  });

  it('refuses text that is not canonical, a hash that does not match, and text that is not a coverage record', async () => {
    const { run, pinned, build } = await prepared();
    const built = build(pinned);
    const pretty = JSON.stringify(JSON.parse(built.canonical), null, 2);
    expect(
      await codeOf(
        run.store.recordCoverage(run.runId, run.leaseToken, {
          canonical: pretty,
          sha256: sha256Hex(pretty),
        }),
      ),
    ).toBe('coverage_rejected');
    expect(
      await codeOf(
        run.store.recordCoverage(run.runId, run.leaseToken, {
          canonical: built.canonical,
          sha256: 'a'.repeat(64),
        }),
      ),
    ).toBe('coverage_rejected');
    const junk = canonicalJson({ schema: 'coverage-record/v1' });
    expect(
      await codeOf(
        run.store.recordCoverage(run.runId, run.leaseToken, {
          canonical: junk,
          sha256: sha256Hex(junk),
        }),
      ),
    ).toBe('coverage_rejected');
    expect(await countFor(run.runId)).toBe(0);
  });

  it('never replaces a stored record with a different one, and refuses a caller that does not hold the lease', async () => {
    const { run, pinned, build } = await prepared();
    await run.store.recordCoverage(run.runId, run.leaseToken, build(pinned));
    expect(
      await codeOf(
        run.store.recordCoverage(
          run.runId,
          run.leaseToken,
          build(pinned, { notices: ['sampled_source'] }),
        ),
      ),
    ).toBe('coverage_rejected');
    const other = await prepared();
    expect(
      await codeOf(
        other.run.store.recordCoverage(other.run.runId, 'not-the-lease', other.build(other.pinned)),
      ),
    ).toBe('lease_mismatch');
    expect(await countFor(other.run.runId)).toBe(0);
  });
});
