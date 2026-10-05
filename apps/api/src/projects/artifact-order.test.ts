import { textArtifact } from '@judge-copilot/capture';
import {
  events,
  projectSources,
  projects,
  sourceSnapshotArtifacts,
  sourceSnapshots,
} from '@judge-copilot/database';
import { SnapshotDetail } from '@judge-copilot/schemas';
import { createLogger } from '@judge-copilot/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME, type ApiApp } from '../app.js';
import {
  bearer,
  fakeVerifier,
  requireValue,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import { ProjectService } from './service.js';

/*
 * Regression for the artifact listing order of the snapshot detail endpoint.
 *
 * `GET /projects/:id/snapshots/:id` orders artifacts with `ORDER BY artifact_key COLLATE "C"`
 * (byte order). Without it the order follows the database's default collation, which is
 * locale-dependent: on a cluster initialized with en_US.utf8 (as in CI) `files/a.txt` sorts BEFORE
 * `files/README.md`. The test drives the real endpoint (so the real query), against a literal
 * expected order, on every configured target. The PostgreSQL 16 CI job sets TEST_DATABASE_URL, so
 * it runs there against a non-C collation; PGlite always runs it too (it only proves the order, not
 * the locale sensitivity).
 */
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });

/** Byte (C-locale) order. Spelled out, not computed, so the test cannot share logic with the code. */
const BYTE_ORDER = ['files/B.txt', 'files/README.md', 'files/a.txt', 'files/src/app.py'];
/** What a typical en_US collation produces for the same keys. */
const LOCALE_ORDER = ['files/a.txt', 'files/B.txt', 'files/README.md', 'files/src/app.py'];
/** Deliberately neither of the above, so insertion order cannot explain a pass. */
const INSERT_ORDER = ['files/a.txt', 'files/src/app.py', 'files/README.md', 'files/B.txt'];

describe.each(testDatabaseTargets())('snapshot artifact ordering on %s', (targetName, open) => {
  let testDb: TestDatabase;
  let app: ApiApp;
  let projectId = '';
  let snapshotId = '';

  beforeAll(async () => {
    testDb = await open();
    const { db } = testDb;
    const [event] = await db
      .insert(events)
      .values({ name: 'Ordering Event', slug: 'ordering-event' })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ eventId: requireValue(event).id, name: 'Ordering Project' })
      .returning();
    projectId = requireValue(project).id;
    const [source] = await db
      .insert(projectSources)
      .values({
        projectId,
        sourceType: 'github',
        url: 'https://github.com/synthetic/ordering',
        position: 0,
      })
      .returning();
    const declared = requireValue(source);
    const [snapshot] = await db
      .insert(sourceSnapshots)
      .values({
        projectId,
        projectSourceId: declared.id,
        captureNumber: 1,
        sourceType: declared.sourceType,
        sourceUrl: declared.url,
        status: 'pending',
      })
      .returning();
    snapshotId = requireValue(snapshot).id;
    for (const key of INSERT_ORDER) {
      const artifact = textArtifact(key, 'file', 'text/plain', `content of ${key}`);
      await db.insert(sourceSnapshotArtifacts).values({
        snapshotId,
        artifactKey: key,
        artifactKind: artifact.kind,
        mediaType: artifact.mediaType,
        textContent: artifact.textContent,
        metadata: {},
        byteLength: artifact.byteLength,
        contentHash: artifact.contentHash,
      });
    }
    const later = new Date(Date.now() + 5_000);
    await db
      .update(sourceSnapshots)
      .set({
        status: 'captured',
        revision: '0123456789abcdef0123456789abcdef01234567',
        metadata: { fixture: 'ordering' },
        contentHash: 'a'.repeat(64),
        capturedAt: later,
        completedAt: later,
      })
      .where(eq(sourceSnapshots.id, snapshotId));
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      projects: new ProjectService({ db }),
    });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('lists artifacts in byte order whatever the database locale', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/snapshots/${snapshotId}`,
      headers: bearer(TEST_TOKENS.judge),
    });
    expect(response.statusCode).toBe(200);
    const detail = SnapshotDetail.parse(response.json<unknown>());
    expect(detail.artifacts.map((artifact) => artifact.key)).toEqual(BYTE_ORDER);
  });

  it('canary: the database default collation orders these keys differently (the regression has teeth)', async () => {
    const rows = await testDb.db.execute<{ datcollate: string; datlocprovider: string }>(
      sql`select datcollate, datlocprovider from pg_database where datname = current_database()`,
    );
    const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as {
      datcollate: string;
      datlocprovider: string;
    }[];
    const row = list[0];
    const isC =
      row !== undefined && row.datlocprovider === 'c' && ['C', 'POSIX'].includes(row.datcollate);
    const isPostgres = targetName.startsWith('PostgreSQL');
    // CI must not silently lose the canary: its PostgreSQL service uses a non-C locale.
    if (isPostgres && process.env['CI'] === 'true') expect(isC).toBe(false);
    if (isC || !isPostgres) return;
    const defaultOrder = await testDb.db
      .select({ key: sourceSnapshotArtifacts.artifactKey })
      .from(sourceSnapshotArtifacts)
      .where(eq(sourceSnapshotArtifacts.snapshotId, snapshotId))
      .orderBy(asc(sourceSnapshotArtifacts.artifactKey));
    // Without COLLATE "C" the listing would be this, not BYTE_ORDER.
    expect(defaultOrder.map((entry) => entry.key)).toEqual(LOCALE_ORDER);
    expect(defaultOrder.map((entry) => entry.key)).not.toEqual(BYTE_ORDER);
  });
});
