/* Test-only harness for capture-worker tests. Excluded from the package build. */
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import type { ProjectSourceAdapter } from '@judge-copilot/capture';
import {
  analysisRuns,
  events,
  migrationsFolder,
  projectSources,
  projects,
  schema,
  sourceSnapshots,
  type JudgeDatabase,
} from '@judge-copilot/database';
import type { GithubCaptureLimits } from '@judge-copilot/github';
import {
  createFixtureNetwork,
  createSafeHttpClient,
  type FixtureNetwork,
} from '@judge-copilot/safe-http';
import type { ProjectSourceType } from '@judge-copilot/schemas';
import { createLogger } from '@judge-copilot/shared';
import { eq, max } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createAdapterRegistry } from '../adapters.js';
import { createCaptureLoop } from '../capture/loop.js';
import { CaptureQueue } from '../capture/queue.js';
import type { AdapterRegistry } from '../capture/runner.js';
import { loadFixtureWorld } from '../fixtures.js';
import { SERVICE_NAME } from '../worker.js';

export const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../../../../tests/fixtures/source-capture',
);

export interface TestDatabase {
  db: JudgeDatabase;
  close: () => Promise<void>;
}

async function openPglite(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

async function openPostgres(url: string): Promise<TestDatabase> {
  if (!new URL(url).pathname.slice(1).endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a disposable database ending in "_test"');
  }
  const client = postgres(url, { max: 4, onnotice: () => undefined });
  await client.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
  );
  const db = drizzlePostgres(client, { schema });
  await migratePostgres(db, { migrationsFolder });
  return { db, close: () => client.end() };
}

/** PGlite always; real PostgreSQL too when TEST_DATABASE_URL is set. */
export function testDatabaseTargets(): [string, () => Promise<TestDatabase>][] {
  const targets: [string, () => Promise<TestDatabase>][] = [['PGlite', openPglite]];
  const url = process.env['TEST_DATABASE_URL'];
  if (url) targets.push(['PostgreSQL (TEST_DATABASE_URL)', () => openPostgres(url)]);
  return targets;
}

let counter = 0;

/** An event with one project declaring the given sources (direct inserts; no API involved). */
export async function seedProject(
  db: JudgeDatabase,
  sources: readonly (readonly [ProjectSourceType, string])[],
) {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({
      name: 'Demo Hackathon',
      slug: `worker-demo-${String(counter)}-${String(Date.now())}`,
    })
    .returning();
  if (!event) throw new Error('event');
  const [project] = await db
    .insert(projects)
    .values({ eventId: event.id, name: `Synthetic Atlas ${String(counter)}` })
    .returning();
  if (!project) throw new Error('project');
  const declared = [];
  for (const [index, [sourceType, url]] of sources.entries()) {
    const [source] = await db
      .insert(projectSources)
      .values({ projectId: project.id, sourceType, url, position: index })
      .returning();
    if (!source) throw new Error('source');
    declared.push(source);
  }
  return { event, project, sources: declared };
}

/** Queues a capture exactly as the API does: a pending snapshot plus a pending run. */
export async function requestCapture(
  db: JudgeDatabase,
  source: { id: string; projectId: string; sourceType: ProjectSourceType; url: string },
  eventId: string,
) {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ number: max(sourceSnapshots.captureNumber) })
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.projectSourceId, source.id));
    const [snapshot] = await tx
      .insert(sourceSnapshots)
      .values({
        projectId: source.projectId,
        projectSourceId: source.id,
        captureNumber: (last?.number ?? 0) + 1,
        sourceType: source.sourceType,
        sourceUrl: source.url,
        status: 'pending',
      })
      .returning();
    if (!snapshot) throw new Error('snapshot');
    const [run] = await tx
      .insert(analysisRuns)
      .values({
        eventId,
        projectId: source.projectId,
        sourceSnapshotId: snapshot.id,
        runType: 'project_source_capture',
        state: 'pending',
        startedAt: null,
      })
      .returning();
    if (!run) throw new Error('run');
    return { snapshotId: snapshot.id, runId: run.id };
  });
}

export function memoryLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger({ service: SERVICE_NAME, level: 'debug', destination }), lines };
}

export interface CaptureSetupOptions {
  readonly adapters?: AdapterRegistry;
  readonly githubToken?: string;
  readonly githubLimits?: Partial<GithubCaptureLimits>;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly shutdownGraceMs?: number;
}

/** Real SafeHttpClient + real adapters in front of the synthetic fixture network. */
export async function captureSetup(db: JudgeDatabase, options: CaptureSetupOptions = {}) {
  const world = await loadFixtureWorld(FIXTURE_DIR);
  const network: FixtureNetwork = createFixtureNetwork(world);
  const http = createSafeHttpClient({ resolver: network.resolver, transport: network.transport });
  const { logger, lines } = memoryLogger();
  const queue = new CaptureQueue({
    db,
    leaseMs: options.leaseMs ?? 60_000,
    ...(options.now ? { now: options.now } : {}),
  });
  const adapters =
    options.adapters ??
    createAdapterRegistry({
      http,
      githubToken: options.githubToken ?? null,
      deploymentTimeoutMs: 200,
      ...(options.githubLimits ? { githubLimits: options.githubLimits } : {}),
    });
  const loop = createCaptureLoop({
    queue,
    adapters,
    logger,
    concurrency: options.concurrency ?? 3,
    pollIntervalMs: 20,
    retryDelayMs: 10,
    shutdownGraceMs: options.shutdownGraceMs ?? 2_000,
  });
  return { network, http, queue, loop, logger, lines, world };
}

/** A fixed adapter for orchestration tests. */
export function stubAdapter(
  sourceType: ProjectSourceType,
  capture: ProjectSourceAdapter['capture'],
): AdapterRegistry {
  return new Map([[sourceType, { sourceType, version: 'stub/v1', capture }]]);
}

export function must<T>(value: T | undefined | null, label = 'value'): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}`);
  return value;
}
