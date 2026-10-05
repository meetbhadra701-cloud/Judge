import { jsonArtifact, type CaptureResult } from '@judge-copilot/capture';
import { analysisRuns, sourceSnapshots, type JudgeDatabase } from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureSetup,
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

const OK: CaptureResult = {
  status: 'captured',
  revision: null,
  metadata: { httpStatus: 200 },
  artifacts: [jsonArtifact('response.json', 'http_response', { httpStatus: 200 })],
  partialReasons: [],
};

describe.each(testDatabaseTargets())('capture queue and worker loop on %s', (_name, open) => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function queued(count: number) {
    const seeded = await seedProject(
      testDb.db,
      Array.from(
        { length: count },
        (_, index) => ['deployment', `https://app${String(index)}.example.org/`] as const,
      ),
    );
    const requests = [];
    for (const source of seeded.sources)
      requests.push(await requestCapture(testDb.db, source, seeded.event.id));
    return { seeded, requests };
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
    return { snapshot, run };
  }

  async function drainPending(db: JudgeDatabase) {
    // Clear leftovers of earlier tests so claims below see only this test's work.
    const queue = new CaptureQueue({ db, leaseMs: 60_000 });
    for (let claim = await queue.claim(); claim; claim = await queue.claim()) {
      await queue.finalize(claim, { result: OK, attempts: 1, capturedAt: new Date() });
    }
  }

  it('lets exactly one worker claim each pending run', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(3);
    const workerA = new CaptureQueue({ db: testDb.db, leaseMs: 60_000 });
    const workerB = new CaptureQueue({ db: testDb.db, leaseMs: 60_000 });
    const claims = await Promise.all([
      workerA.claim(),
      workerB.claim(),
      workerA.claim(),
      workerB.claim(),
    ]);
    const runIds = claims.filter((claim) => claim !== null).map((claim) => claim.runId);
    expect(runIds.sort()).toEqual(requests.map((request) => request.runId).sort());
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    for (const request of requests) {
      const { run, snapshot } = await state(request.snapshotId);
      expect(run).toMatchObject({ state: 'running' });
      expect(run?.leaseToken).not.toBeNull();
      // A running analysis run does not make the snapshot terminal.
      expect(snapshot?.status).toBe('pending');
    }
    for (const claim of claims)
      if (claim) await workerA.finalize(claim, { result: OK, attempts: 1, capturedAt: new Date() });
  });

  it('never lets two workers finalize the same snapshot', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(1);
    const queue = new CaptureQueue({ db: testDb.db, leaseMs: 60_000 });
    const claim = await queue.claim();
    if (!claim) throw new Error('no claim');
    const impostor = { ...claim, leaseToken: '00000000-0000-4000-8000-000000000001' };
    expect(
      await queue.finalize(impostor, { result: OK, attempts: 1, capturedAt: new Date() }),
    ).toBe('lease_lost');
    const [first, second] = await Promise.all([
      queue.finalize(claim, { result: OK, attempts: 1, capturedAt: new Date() }),
      queue.finalize(claim, {
        result: { status: 'failed', failure: { category: 'timeout', metadata: {} } },
        attempts: 1,
        capturedAt: new Date(),
      }),
    ]);
    expect([first, second].sort()).toEqual(['finalized', 'lease_lost']);
    const { snapshot, run } = await state(must(requests[0]).snapshotId);
    expect(['captured', 'failed']).toContain(snapshot?.status);
    expect(run?.state === 'succeeded' ? 'captured' : 'failed').toBe(snapshot?.status);
  });

  it("fails a capture whose worker vanished and discards that worker's late result", async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(1);
    let clock = Date.now();
    const queue = new CaptureQueue({ db: testDb.db, leaseMs: 10_000, now: () => new Date(clock) });
    const claim = await queue.claim();
    if (!claim) throw new Error('no claim');
    clock += 60_000;
    expect(await queue.reapExpired()).toBe(1);
    expect(
      await queue.finalize(claim, { result: OK, attempts: 1, capturedAt: new Date(clock) }),
    ).toBe('lease_lost');
    const { snapshot, run } = await state(must(requests[0]).snapshotId);
    expect(snapshot).toMatchObject({
      status: 'failed',
      failureCategory: 'internal_error',
      failureMetadata: { reason: 'worker_lease_expired' },
    });
    expect(run).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
  });

  it('runs the adapter with no database transaction open', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(1);
    let openTransactions = 0;
    const tracked = new Proxy(testDb.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: Parameters<JudgeDatabase['transaction']>) => {
            openTransactions += 1;
            try {
              return await target.transaction(...args);
            } finally {
              openTransactions -= 1;
            }
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const observed: number[] = [];
    const runStates: string[] = [];
    const adapters = stubAdapter('deployment', async () => {
      observed.push(openTransactions);
      // The claim is committed and visible before the adapter runs.
      const [run] = await testDb.db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, must(requests[0]).runId));
      runStates.push(run?.state ?? 'missing');
      return OK;
    });
    const { logger } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: tracked, leaseMs: 60_000 }),
      adapters,
      logger,
      concurrency: 1,
      pollIntervalMs: 10,
    });
    expect(await loop.drain()).toBe(1);
    expect(observed).toEqual([0]);
    expect(runStates).toEqual(['running']);
    expect((await state(must(requests[0]).snapshotId)).snapshot?.status).toBe('captured');
  });

  it('keeps processing after a capture fails, and never lets raw adapter errors through', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(3);
    let calls = 0;
    const adapters = stubAdapter('deployment', () => {
      calls += 1;
      if (calls === 1) {
        const error = Object.assign(new Error('boom with Authorization: Bearer leaked-token'), {
          response: { body: '<html>secret</html>' },
        });
        return Promise.reject(error);
      }
      return Promise.resolve(OK);
    });
    const { logger, lines } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: testDb.db, leaseMs: 60_000 }),
      adapters,
      logger,
      concurrency: 1,
      pollIntervalMs: 10,
    });
    expect(await loop.drain()).toBe(3);
    const states = await Promise.all(requests.map((request) => state(request.snapshotId)));
    expect(states.map((s) => s.snapshot?.status)).toEqual(['failed', 'captured', 'captured']);
    expect(states[0]?.snapshot).toMatchObject({
      failureCategory: 'internal_error',
      failureMetadata: { adapter: 'deployment', reason: 'adapter_exception' },
    });
    const everything = JSON.stringify(states) + lines.join('');
    expect(everything).not.toContain('leaked-token');
    expect(everything).not.toContain('<html>secret</html>');
  });

  it('retries a transient failure at most once and never retries a policy rejection', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(2);
    const attemptsByUrl = new Map<string, number>();
    const adapters = stubAdapter('deployment', ({ url }) => {
      const attempt = (attemptsByUrl.get(url) ?? 0) + 1;
      attemptsByUrl.set(url, attempt);
      if (url.includes('app0')) {
        return Promise.resolve<CaptureResult>({
          status: 'rejected',
          failure: { category: 'ssrf_rejected', metadata: {} },
        });
      }
      return Promise.resolve<CaptureResult>({
        status: 'failed',
        failure: { category: 'connection_failure', metadata: {} },
      });
    });
    const { logger } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: testDb.db, leaseMs: 60_000 }),
      adapters,
      logger,
      concurrency: 2,
      pollIntervalMs: 10,
      retryDelayMs: 1,
    });
    await loop.drain();
    expect([...attemptsByUrl.entries()].sort()).toEqual([
      ['https://app0.example.org/', 1],
      ['https://app1.example.org/', 2],
    ]);
    const [rejected, failed] = await Promise.all(
      requests.map((request) => state(request.snapshotId)),
    );
    expect(rejected?.run).toMatchObject({ state: 'succeeded', attemptCount: 1 });
    expect(failed?.run).toMatchObject({
      state: 'failed',
      failureCategory: 'source_unavailable',
      attemptCount: 2,
    });
  });

  it('bounds concurrency and shuts down gracefully, cancelling captures that outlive the grace period', async () => {
    await drainPending(testDb.db);
    const { requests } = await queued(3);
    let concurrent = 0;
    let peak = 0;
    const adapters = stubAdapter('deployment', ({ signal }) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      return new Promise<CaptureResult>((resolve) => {
        signal.addEventListener('abort', () => {
          concurrent -= 1;
          resolve({ status: 'failed', failure: { category: 'timeout', metadata: {} } });
        });
      });
    });
    const { logger } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: testDb.db, leaseMs: 60_000 }),
      adapters,
      logger,
      concurrency: 2,
      pollIntervalMs: 10,
      shutdownGraceMs: 50,
    });
    loop.start();
    for (let waited = 0; loop.inFlight < 2 && waited < 2_000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(loop.inFlight).toBe(2);
    await loop.stop();
    expect(loop.inFlight).toBe(0);
    expect(peak).toBe(2);
    const states = await Promise.all(requests.map((request) => state(request.snapshotId)));
    const cancelled = states.filter((s) => s.run?.state === 'cancelled');
    expect(cancelled).toHaveLength(2);
    for (const s of cancelled) {
      expect(s.snapshot).toMatchObject({
        status: 'failed',
        failureCategory: 'internal_error',
        failureMetadata: { reason: 'worker_shutdown' },
      });
    }
    // The third capture was never claimed and is still queued for the next worker.
    expect(states.filter((s) => s.run?.state === 'pending')).toHaveLength(1);
  });

  it('reports one job handler when capture is enabled', async () => {
    const { createWorker } = await import('../worker.js');
    const setup = await captureSetup(testDb.db);
    const { logger, lines } = memoryLogger();
    const worker = createWorker({ logger, captureLoop: setup.loop });
    worker.start();
    await worker.stop();
    const messages = lines.map((line) => JSON.parse(line) as { msg: string; jobHandlers?: number });
    expect(messages[0]).toMatchObject({ msg: 'worker started', jobHandlers: 1 });
    expect(messages.at(-1)?.msg).toBe('worker stopped');
  });
});
