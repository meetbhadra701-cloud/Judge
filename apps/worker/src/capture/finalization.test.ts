import {
  jsonArtifact,
  textArtifact,
  type CaptureResult,
  type JsonObject,
} from '@judge-copilot/capture';
import { analysisRuns, sourceSnapshotArtifacts, sourceSnapshots } from '@judge-copilot/database';
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
import { CaptureQueue, type CaptureClaim } from './queue.js';
import { runCapture } from './runner.js';
import { safeErrorCode } from './safe-error.js';

const MARKER = 'TOP_SECRET_MARKER';

/** Passes application validation (JSON.stringify <= 64 KiB) but not the database CHECK (jsonb::text). */
function metadataOnlyPostgresRejects(): JsonObject {
  const metadata: JsonObject = {};
  for (let index = 0; index < 6_500; index += 1) metadata[`k${String(index).padStart(4, '0')}`] = 1;
  return metadata;
}

function secretResult(): CaptureResult {
  return {
    status: 'captured',
    revision: null,
    metadata: { httpStatus: 200 },
    artifacts: [
      textArtifact('page.txt', 'page_text', 'text/plain', `README ${MARKER} body`, {}),
      jsonArtifact('page.json', 'page_metadata', { note: MARKER }, metadataOnlyPostgresRejects()),
    ],
    partialReasons: [],
  };
}

describe.each(testDatabaseTargets())('capture finalization safety on %s', (_name, open) => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function queue1(url: string) {
    const seeded = await seedProject(testDb.db, [['deployment', url]]);
    const request = await requestCapture(testDb.db, must(seeded.sources[0]), seeded.event.id);
    return { seeded, ...request };
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

  function loopFor(adapter: CaptureResult | (() => CaptureResult)) {
    const { logger, lines } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: testDb.db, leaseMs: 60_000 }),
      adapters: stubAdapter('deployment', () =>
        Promise.resolve(typeof adapter === 'function' ? adapter() : adapter),
      ),
      logger,
      concurrency: 1,
      pollIntervalMs: 10,
    });
    return { loop, lines };
  }

  it('stores a hostile NUL/surrogate title as replaced text and still captures', async () => {
    const { snapshotId } = await queue1('https://nul-title.example.org/');
    const result: CaptureResult = {
      status: 'captured',
      revision: null,
      metadata: { httpStatus: 200, title: `a\u0000b ${MARKER} \uD800` },
      artifacts: [textArtifact('page.txt', 'page_text', 'text/plain', `x\u0000y ${MARKER}`)],
      partialReasons: [],
    };
    const { loop, lines } = loopFor(result);
    await loop.drain();
    const { snapshot, run } = await state(snapshotId);
    expect(snapshot?.status).toBe('captured');
    expect(run).toMatchObject({ state: 'succeeded', failureCategory: null });
    expect(snapshot?.metadata).toMatchObject({
      title: `a�b ${MARKER} �`,
      // One NUL in the title, one in the artifact text; one unpaired surrogate.
      contentSanitization: { nulReplaced: 2, invalidSurrogatesReplaced: 1 },
    });
    const [artifact] = await testDb.db
      .select()
      .from(sourceSnapshotArtifacts)
      .where(eq(sourceSnapshotArtifacts.snapshotId, snapshotId));
    expect(artifact?.textContent).toBe(`x�y ${MARKER}`);
    // Captured text is never logged.
    expect(lines.join('')).not.toContain(MARKER);
  });

  it('turns a database finalization failure into a terminal sanitized failure and logs no content', async () => {
    const { snapshotId, runId } = await queue1('https://db-reject.example.org/');

    // Sensitivity: the raw driver error for exactly this kind of failure DOES contain the text.
    let raw: unknown;
    try {
      await testDb.db.insert(sourceSnapshotArtifacts).values({
        snapshotId,
        artifactKey: 'probe.txt',
        artifactKind: 'page_text',
        mediaType: 'text/plain',
        textContent: `probe ${MARKER}`,
        metadata: metadataOnlyPostgresRejects(),
        byteLength: Buffer.byteLength(`probe ${MARKER}`),
        contentHash: '0'.repeat(64),
      });
    } catch (error) {
      raw = error;
    }
    expect(String((raw as Error | undefined)?.message)).toContain(MARKER);
    expect(safeErrorCode(raw)).toMatch(/^[0-9A-Z]{5}$/);
    // The failed statement left nothing behind; the capture is still pending.
    expect((await state(snapshotId)).snapshot?.status).toBe('pending');

    const { loop, lines } = loopFor(secretResult());
    await loop.drain();
    const { snapshot, run } = await state(snapshotId);
    // Terminal at once (no waiting for the lease), sanitized, and no artifacts were stored.
    expect(snapshot).toMatchObject({
      status: 'failed',
      failureCategory: 'internal_error',
      failureMetadata: { adapter: 'deployment', reason: 'finalization_failed' },
    });
    expect(run).toMatchObject({ id: runId, state: 'failed', failureCategory: 'internal_error' });
    const stored = await testDb.db
      .select()
      .from(sourceSnapshotArtifacts)
      .where(eq(sourceSnapshotArtifacts.snapshotId, snapshotId));
    expect(stored).toHaveLength(0);

    const output = lines.join('');
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain('Failed query');
    expect(output).not.toContain('params');
    const failedLine = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (entry) => entry['msg'] === 'capture finalization failed; recording a sanitized failure',
      );
    expect(failedLine).toMatchObject({ snapshotId, runId, errorCode: safeErrorCode(raw) });
    expect(Object.keys(failedLine ?? {}).sort()).toEqual(
      ['errorCode', 'level', 'msg', 'runId', 'service', 'snapshotId', 'sourceType', 'time'].sort(),
    );
  });

  it('leaves no capture pending or running after any of the above', async () => {
    const open = await testDb.db.select().from(analysisRuns);
    const stuck = open.filter(
      (run) =>
        run.runType === 'project_source_capture' && ['pending', 'running'].includes(run.state),
    );
    expect(stuck).toEqual([]);
  });
});

describe('capture finalization logging never carries driver errors', () => {
  const claim: CaptureClaim = {
    runId: '00000000-0000-4000-8000-0000000000a1',
    leaseToken: '00000000-0000-4000-8000-0000000000a2',
    snapshotId: '00000000-0000-4000-8000-0000000000a3',
    projectId: '00000000-0000-4000-8000-0000000000a4',
    sourceId: '00000000-0000-4000-8000-0000000000a5',
    sourceType: 'deployment',
    sourceUrl: 'https://app.example.org/',
    captureNumber: 1,
  };
  const leaky = () =>
    Object.assign(
      new Error(`Failed query: insert into "source_snapshot_artifacts" ... params: ${MARKER}`),
      { cause: Object.assign(new Error(`detail ${MARKER}`), { code: '23514' }) },
    );

  it('survives a failing finalize AND a failing emergency finalize, logging only safe fields', async () => {
    let calls = 0;
    const queue = {
      finalize: () => {
        calls += 1;
        return Promise.reject(leaky());
      },
    } as unknown as CaptureQueue;
    const { logger, lines } = memoryLogger();
    await runCapture(
      {
        queue,
        adapters: stubAdapter('deployment', () => Promise.resolve(secretResult())),
        logger,
      },
      claim,
      new AbortController().signal,
    );
    // One normal attempt, exactly one emergency attempt: no recursion.
    expect(calls).toBe(2);
    const output = lines.join('');
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain('Failed query');
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.filter((entry) => entry['errorCode'] === '23514')).toHaveLength(2);
    expect(entries.some((entry) => entry['msg'] === 'capture finished')).toBe(true);
  });

  it('logs only a SQLSTATE when claiming or polling fails', async () => {
    const queue = {
      claim: () => Promise.reject(leaky()),
      reapExpired: () => Promise.resolve(0),
    } as unknown as CaptureQueue;
    const { logger, lines } = memoryLogger();
    const loop = createCaptureLoop({
      queue,
      adapters: stubAdapter('deployment', () => Promise.resolve(secretResult())),
      logger,
      concurrency: 1,
      pollIntervalMs: 10,
    });
    loop.start();
    for (
      let waited = 0;
      !lines.join('').includes('capture poll error') && waited < 2_000;
      waited += 10
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await loop.stop();
    const output = lines.join('');
    expect(output).toContain('capture poll error');
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain('Failed query');
  });

  it('maps only genuine SQLSTATE codes', () => {
    expect(safeErrorCode(leaky())).toBe('23514');
    expect(safeErrorCode(new Error(`boom ${MARKER}`))).toBe('unknown');
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('unknown');
    expect(safeErrorCode('string')).toBe('unknown');
    expect(safeErrorCode(null)).toBe('unknown');
  });
});
