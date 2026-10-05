import { analysisRuns, sourceSnapshotArtifacts, sourceSnapshots } from '@judge-copilot/database';
import { createFixtureNetwork, createSafeHttpClient } from '@judge-copilot/safe-http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters.js';
import {
  memoryLogger,
  must,
  requestCapture,
  seedProject,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import { createCaptureLoop } from './loop.js';
import { CaptureQueue } from './queue.js';

/*
 * Worker-level complexity regression. A single hostile deployment page used to run whole-tree
 * selectors that are quadratic in the number of matches: a valid 1 MiB page took 26-81 s of
 * synchronous CPU, freezing every timer, every other capture and the lease reaper in the worker
 * process. Here such pages go through the real queue, adapter, validation and finalization, and
 * the event loop is sampled while they run. The ceiling is generous so it cannot flake, yet fails
 * by an order of magnitude on the old behaviour.
 */
const MIB = 1024 * 1024;
const STALL_CEILING_MS = 10_000;
const PUBLIC = '93.184.216.34';
const flood = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
const html = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: `<html><head><title>Hostile</title></head><body>${body}</body></html>`,
});

describe.each(testDatabaseTargets())('hostile HTML capture on %s', (_name, open) => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  it('captures adversarial pages without blocking the event loop for tens of seconds', async () => {
    const pages = {
      'https://anchors.example.org/': html(flood('<a href="/x">y</a>', MIB - 200)),
      'https://headings.example.org/': html(flood('<h1>a</h1><h2>b</h2>', MIB - 200)),
      'https://nested.example.org/': html(`${'<div>'.repeat(150_000)}text`),
    };
    const network = createFixtureNetwork({
      hosts: Object.fromEntries(Object.keys(pages).map((url) => [new URL(url).hostname, [PUBLIC]])),
      routes: pages,
    });
    const http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
    const { logger } = memoryLogger();
    const loop = createCaptureLoop({
      queue: new CaptureQueue({ db: testDb.db, leaseMs: 120_000 }),
      adapters: createAdapterRegistry({ http, deploymentTimeoutMs: 30_000 }),
      logger,
      concurrency: 1,
      pollIntervalMs: 20,
    });
    const seeded = await seedProject(
      testDb.db,
      Object.keys(pages).map((url) => ['deployment', url] as const),
    );
    const requests = [];
    for (const source of seeded.sources) {
      requests.push(await requestCapture(testDb.db, source, seeded.event.id));
    }

    let maxStall = 0;
    let last = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      maxStall = Math.max(maxStall, now - last);
      last = now;
    }, 10);
    const started = performance.now();
    expect(await loop.drain()).toBe(requests.length);
    clearInterval(sampler);
    const total = performance.now() - started;

    expect(maxStall).toBeLessThan(STALL_CEILING_MS);
    expect(total).toBeLessThan(STALL_CEILING_MS * 3);
    for (const request of requests) {
      const [snapshot] = await testDb.db
        .select()
        .from(sourceSnapshots)
        .where(eq(sourceSnapshots.id, request.snapshotId));
      const [run] = await testDb.db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.sourceSnapshotId, request.snapshotId));
      expect(['captured', 'partial']).toContain(snapshot?.status);
      expect(run?.state).toBe('succeeded');
      const artifacts = await testDb.db
        .select()
        .from(sourceSnapshotArtifacts)
        .where(eq(sourceSnapshotArtifacts.snapshotId, request.snapshotId));
      const pageJson = JSON.parse(
        must(artifacts.find((artifact) => artifact.artifactKey === 'page.json')).textContent,
      ) as { links: unknown[]; headings: unknown[] };
      expect(pageJson.links.length).toBeLessThanOrEqual(200);
      expect(pageJson.headings.length).toBeLessThanOrEqual(50);
    }
  });
});
