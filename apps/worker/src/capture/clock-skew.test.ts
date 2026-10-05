import { jsonArtifact, type CaptureResult, type JsonObject } from '@judge-copilot/capture';
import { analysisRuns, sourceSnapshots } from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  memoryLogger,
  must,
  requestCapture,
  seedProject,
  stubAdapter,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import { createCaptureLoop } from './loop.js';
import { CaptureQueue } from './queue.js';

/*
 * The API stamps `source_snapshots.created_at`; the worker finalizes with its own clock. When the
 * worker's clock is behind, terminal timestamps used to land before `created_at`, violating
 * `source_snapshots_timestamps_ordered`: the finalization threw, the capture sat `running` until
 * the lease expired and was then recorded as `worker_lease_expired` instead of what really
 * happened (a policy rejection completes in milliseconds, which is exactly when skew bites).
 */
const SKEW_MS = 60_000;

function metadataOnlyPostgresRejects(): JsonObject {
  const metadata: JsonObject = {};
  for (let index = 0; index < 6_500; index += 1) metadata[`k${String(index).padStart(4, '0')}`] = 1;
  return metadata;
}

describe.each(testDatabaseTargets())('worker clock skew on %s', (_name, open) => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function capture(label: string, result: CaptureResult, leaseMs = 120_000) {
    const seeded = await seedProject(testDb.db, [['deployment', `https://${label}.example.org/`]]);
    const { snapshotId } = await requestCapture(
      testDb.db,
      must(seeded.sources[0]),
      seeded.event.id,
    );
    const { logger, lines } = memoryLogger();
    // The worker's clock runs a minute BEHIND the database/API clock.
    const queue = new CaptureQueue({
      db: testDb.db,
      leaseMs,
      now: () => new Date(Date.now() - SKEW_MS),
    });
    const loop = createCaptureLoop({
      queue,
      adapters: stubAdapter('deployment', () => Promise.resolve(result)),
      logger,
      concurrency: 1,
      pollIntervalMs: 10,
      retryDelayMs: 1,
    });
    await loop.drain();
    return { snapshotId, ...(await state(snapshotId)), lines };
  }

  async function state(snapshotId: string) {
    const [snapshot] = await testDb.db
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.id, snapshotId));
    const [run] = await testDb.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.sourceSnapshotId, snapshotId));
    return { snapshot: must(snapshot), run: must(run) };
  }

  function expectOrdered({ snapshot, run }: Awaited<ReturnType<typeof state>>) {
    expect(snapshot.completedAt?.getTime()).toBeGreaterThanOrEqual(snapshot.createdAt.getTime());
    if (snapshot.capturedAt) {
      expect(snapshot.capturedAt.getTime()).toBeGreaterThanOrEqual(snapshot.createdAt.getTime());
      expect(snapshot.capturedAt.getTime()).toBeLessThanOrEqual(
        snapshot.completedAt?.getTime() ?? 0,
      );
    }
    expect(run.finishedAt?.getTime()).toBeGreaterThanOrEqual(run.startedAt?.getTime() ?? 0);
    expect(run.finishedAt?.getTime()).toBeGreaterThanOrEqual(snapshot.createdAt.getTime());
  }

  it('finishes a policy rejection as rejected / succeeded, not as a lease expiry', async () => {
    const outcome = await capture('skew-ssrf', {
      status: 'rejected',
      failure: { category: 'ssrf_rejected', metadata: { adapter: 'deployment' } },
    });
    expect(outcome.snapshot).toMatchObject({
      status: 'rejected',
      failureCategory: 'ssrf_rejected',
      failureMetadata: { adapter: 'deployment' },
    });
    expect(outcome.run).toMatchObject({ state: 'succeeded', failureCategory: null });
    expect(JSON.stringify(outcome.snapshot.failureMetadata)).not.toContain('worker_lease_expired');
    expect(outcome.lines.join('')).not.toContain('finalization failed');
    expectOrdered(outcome);
  });

  it('finishes an adapter failure as failed with its own category', async () => {
    const outcome = await capture('skew-failed', {
      status: 'failed',
      failure: { category: 'not_found', metadata: { adapter: 'deployment', httpStatus: 404 } },
    });
    expect(outcome.snapshot).toMatchObject({ status: 'failed', failureCategory: 'not_found' });
    expect(outcome.run).toMatchObject({ state: 'failed', failureCategory: 'source_unavailable' });
    expectOrdered(outcome);
  });

  it('finishes a captured result', async () => {
    const outcome = await capture('skew-captured', {
      status: 'captured',
      revision: null,
      metadata: { httpStatus: 200 },
      artifacts: [jsonArtifact('response.json', 'http_response', { httpStatus: 200 })],
      partialReasons: [],
    });
    expect(outcome.snapshot.status).toBe('captured');
    expect(outcome.run.state).toBe('succeeded');
    expectOrdered(outcome);
  });

  it('records the emergency finalization failure under skew too', async () => {
    const outcome = await capture('skew-emergency', {
      status: 'captured',
      revision: null,
      metadata: { httpStatus: 200 },
      artifacts: [
        jsonArtifact('response.json', 'http_response', {}, metadataOnlyPostgresRejects()),
      ],
      partialReasons: [],
    });
    expect(outcome.snapshot).toMatchObject({
      status: 'failed',
      failureCategory: 'internal_error',
      failureMetadata: { reason: 'finalization_failed' },
    });
    expect(outcome.run).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
    expectOrdered(outcome);
  });

  it('lets the lease reaper fail an expired capture under skew', async () => {
    const seeded = await seedProject(testDb.db, [
      ['deployment', 'https://skew-reaper.example.org/'],
    ]);
    const { snapshotId } = await requestCapture(
      testDb.db,
      must(seeded.sources[0]),
      seeded.event.id,
    );
    let clock = Date.now() - SKEW_MS;
    const queue = new CaptureQueue({ db: testDb.db, leaseMs: 5_000, now: () => new Date(clock) });
    const claim = await queue.claim();
    expect(claim?.snapshotId).toBe(snapshotId);
    clock += 10_000; // still a minute behind the database clock, but the lease has expired
    expect(await queue.reapExpired()).toBe(1);
    const after = await state(snapshotId);
    expect(after.snapshot).toMatchObject({
      status: 'failed',
      failureCategory: 'internal_error',
      failureMetadata: { reason: 'worker_lease_expired' },
    });
    expect(after.run).toMatchObject({ state: 'failed' });
    expectOrdered(after);
  });

  it('leaves nothing pending or running', async () => {
    const runs = await testDb.db.select().from(analysisRuns);
    expect(
      runs.filter((run) => ['pending', 'running'].includes(run.state)).map((run) => run.id),
    ).toEqual([]);
  });
});
