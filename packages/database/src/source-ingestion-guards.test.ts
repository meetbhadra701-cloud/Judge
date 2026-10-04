import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  analysisRuns,
  auditEvents,
  eventContextVersions,
  events,
  projectSources,
  projects,
  projectTrackSelections,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  tracks,
} from './index.js';
import {
  expectPgError,
  rows,
  sql,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';

const RESTRICT = [SQLSTATE.RESTRICT_VIOLATION, SQLSTATE.FOREIGN_KEY_VIOLATION] as const;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SHA_A = 'a'.repeat(40);

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing value');
  return value;
}

describe.each(testDatabaseTargets())('M2 source-ingestion guards on %s', (_name, open) => {
  let testDb: TestDatabase;
  let counter = 0;

  beforeAll(async () => {
    testDb = await open();
  });
  afterAll(async () => {
    await testDb.close();
  });

  /** An event with a locked context version holding one track (`ai`). */
  async function lockedEvent() {
    const { db } = testDb;
    counter += 1;
    const [event] = await db
      .insert(events)
      .values({ name: 'Guarded', slug: `guarded-${String(counter)}` })
      .returning();
    if (!event) throw new Error('event');
    const [version] = await db
      .insert(eventContextVersions)
      .values({ eventId: event.id, version: 1, status: 'draft' })
      .returning();
    if (!version) throw new Error('version');
    const [track] = await db
      .insert(tracks)
      .values({
        contextVersionId: version.id,
        key: 'ai',
        name: 'AI',
        displayOrder: 0,
        origin: 'human',
      })
      .returning();
    if (!track) throw new Error('track');
    await db.execute(
      sql`UPDATE event_context_versions SET status = 'locked', locked_at = now() WHERE id = ${version.id}`,
    );
    const [project] = await db
      .insert(projects)
      .values({ eventId: event.id, name: `Project ${String(counter)}` })
      .returning();
    if (!project) throw new Error('project');
    return { event, version, track, project };
  }

  async function source(
    projectId: string,
    url = 'https://github.com/team/repo',
    sourceType = 'github' as const,
  ) {
    const [row] = await testDb.db
      .insert(projectSources)
      .values({ projectId, sourceType, url, position: Math.floor(Math.random() * 1_000_000) })
      .returning();
    if (!row) throw new Error('source');
    return row;
  }

  async function pendingSnapshot(
    src: {
      id: string;
      projectId: string;
      sourceType: 'github' | 'devpost' | 'deployment' | 'video';
      url: string;
    },
    captureNumber = 1,
  ) {
    const [row] = await testDb.db
      .insert(sourceSnapshots)
      .values({
        projectId: src.projectId,
        projectSourceId: src.id,
        captureNumber,
        sourceType: src.sourceType,
        sourceUrl: src.url,
        status: 'pending',
      })
      .returning();
    if (!row) throw new Error('snapshot');
    return row;
  }

  function artifactValues(snapshotId: string, key = 'README.md', text = '# hi\n') {
    return {
      snapshotId,
      artifactKey: key,
      artifactKind: 'file' as const,
      mediaType: 'text/markdown',
      textContent: text,
      byteLength: Buffer.byteLength(text),
      contentHash: sha256(text),
    };
  }

  async function capture(snapshotId: string) {
    await testDb.db.execute(
      sql`UPDATE source_snapshots SET status = 'captured', revision = ${SHA_A}, metadata = '{}'::jsonb,
          content_hash = ${sha256('x')}, captured_at = now(), completed_at = now() WHERE id = ${snapshotId}`,
    );
  }

  it('keeps a project in its event for life and never deletes it', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const other = await lockedEvent();
    await expectPgError(
      db.execute(sql`UPDATE projects SET event_id = ${other.event.id} WHERE id = ${project.id}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(sql`DELETE FROM projects WHERE id = ${project.id}`),
      ...RESTRICT,
    );
    await db.execute(sql`UPDATE projects SET team_name = 'Renamed team' WHERE id = ${project.id}`);
  });

  it('validates track declarations against the locked context of the same event, then freezes them', async () => {
    const { db } = testDb;
    const { event, version, track, project } = await lockedEvent();
    await db.insert(projectTrackSelections).values({
      projectId: project.id,
      eventId: event.id,
      contextVersionId: version.id,
      trackId: track.id,
      trackKey: 'ai',
    });
    // Wrong key for the track.
    const second = await lockedEvent();
    await expectPgError(
      db.insert(projectTrackSelections).values({
        projectId: second.project.id,
        eventId: second.event.id,
        contextVersionId: second.version.id,
        trackId: second.track.id,
        trackKey: 'web3',
      }),
      SQLSTATE.CHECK_VIOLATION,
    );
    // Another event's context or track.
    await expectPgError(
      db.insert(projectTrackSelections).values({
        projectId: second.project.id,
        eventId: second.event.id,
        contextVersionId: version.id,
        trackId: track.id,
        trackKey: 'ai',
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    // A draft (unlocked) context version.
    const [draft] = await db
      .insert(eventContextVersions)
      .values({ eventId: event.id, version: 2, status: 'draft', supersedesId: version.id })
      .returning();
    const [draftTrack] = await db
      .insert(tracks)
      .values({
        contextVersionId: draft?.id ?? '',
        key: 'ai',
        name: 'AI',
        displayOrder: 0,
        origin: 'human',
      })
      .returning();
    await expectPgError(
      db.insert(projectTrackSelections).values({
        projectId: project.id,
        eventId: event.id,
        contextVersionId: draft?.id ?? '',
        trackId: draftTrack?.id ?? '',
        trackKey: 'ai',
      }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE project_track_selections SET track_key = 'x' WHERE project_id = ${project.id}`,
      ),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(sql`DELETE FROM project_track_selections WHERE project_id = ${project.id}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
  });

  it('rejects duplicate declarations and keeps sources immutable', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id);
    await expectPgError(source(project.id), SQLSTATE.UNIQUE_VIOLATION);
    await expectPgError(
      db.execute(
        sql`UPDATE project_sources SET url = 'https://github.com/team/other' WHERE id = ${src.id}`,
      ),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(sql`UPDATE project_sources SET source_type = 'video' WHERE id = ${src.id}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(sql`DELETE FROM project_sources WHERE id = ${src.id}`),
      ...RESTRICT,
    );
    await expectPgError(
      db
        .insert(projectSources)
        .values({ projectId: project.id, sourceType: 'github', url: 'ftp://x', position: 99 }),
      SQLSTATE.CHECK_VIOLATION,
    );
  });

  it('refuses snapshots whose project, type or URL disagree with the declaration', async () => {
    const { project } = await lockedEvent();
    const other = await lockedEvent();
    const src = await source(project.id);
    await expectPgError(
      pendingSnapshot({ ...src, projectId: other.project.id }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    await expectPgError(
      pendingSnapshot({ ...src, sourceType: 'video' }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    await expectPgError(
      pendingSnapshot({ ...src, url: 'https://github.com/x/y' }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });

  it('assigns monotonic, gapless capture numbers and only creates pending snapshots', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id);
    await pendingSnapshot(src, 1);
    await expectPgError(
      pendingSnapshot(src, 1),
      SQLSTATE.CHECK_VIOLATION,
      SQLSTATE.UNIQUE_VIOLATION,
    );
    await expectPgError(pendingSnapshot(src, 3), SQLSTATE.CHECK_VIOLATION);
    await pendingSnapshot(src, 2);
    await expectPgError(
      db.insert(sourceSnapshots).values({
        projectId: src.projectId,
        projectSourceId: src.id,
        captureNumber: 3,
        sourceType: 'github',
        sourceUrl: src.url,
        status: 'failed',
        failureCategory: 'timeout',
        failureMetadata: {},
        completedAt: new Date(),
      }),
      SQLSTATE.CHECK_VIOLATION,
    );
  });

  it('makes terminal snapshots immutable and undeletable in PostgreSQL itself', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id);
    const snap = await pendingSnapshot(src);
    await db.insert(sourceSnapshotArtifacts).values(artifactValues(snap.id));
    await capture(snap.id);
    for (const statement of [
      sql`UPDATE source_snapshots SET status = 'pending', completed_at = NULL WHERE id = ${snap.id}`,
      sql`UPDATE source_snapshots SET revision = ${'b'.repeat(40)} WHERE id = ${snap.id}`,
      sql`UPDATE source_snapshots SET content_hash = ${sha256('y')} WHERE id = ${snap.id}`,
      sql`UPDATE source_snapshots SET metadata = '{"x":1}'::jsonb WHERE id = ${snap.id}`,
      sql`UPDATE source_snapshots SET status = 'failed', failure_category = 'timeout', failure_metadata = '{}'::jsonb WHERE id = ${snap.id}`,
    ]) {
      await expectPgError(db.execute(statement), SQLSTATE.RESTRICT_VIOLATION);
    }
    await expectPgError(
      db.execute(sql`DELETE FROM source_snapshots WHERE id = ${snap.id}`),
      ...RESTRICT,
    );
    await expectPgError(
      db.execute(sql`TRUNCATE source_snapshots CASCADE`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    // Artifacts under a terminal parent: no insert, update or delete.
    await expectPgError(
      db.insert(sourceSnapshotArtifacts).values(artifactValues(snap.id, 'late.md')),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE source_snapshot_artifacts SET text_content = 'x' WHERE snapshot_id = ${snap.id}`,
      ),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(sql`DELETE FROM source_snapshot_artifacts WHERE snapshot_id = ${snap.id}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    const [stored] = await rows<{ status: string; revision: string }>(
      db,
      sql`SELECT status, revision FROM source_snapshots WHERE id = ${snap.id}`,
    );
    expect(stored).toEqual({ status: 'captured', revision: SHA_A });
  });

  it('lets a pending snapshot change only once, only to a terminal status, keeping its identity', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id);
    const snap = await pendingSnapshot(src);
    await expectPgError(
      db.execute(sql`UPDATE source_snapshots SET capture_number = 5 WHERE id = ${snap.id}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE source_snapshots SET status = 'rejected', failure_category = 'ssrf_rejected', failure_metadata = '{}'::jsonb, completed_at = now(), source_url = 'https://github.com/a/b' WHERE id = ${snap.id}`,
      ),
      SQLSTATE.RESTRICT_VIOLATION,
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    await db.execute(
      sql`UPDATE source_snapshots SET status = 'rejected', failure_category = 'ssrf_rejected', failure_metadata = '{"host":"evil.example","reason":"address_not_public"}'::jsonb, completed_at = now() WHERE id = ${snap.id}`,
    );
  });

  it('requires a sanitized failure category for failed/rejected and a content hash for captured/partial', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id, 'https://app.example/', 'deployment' as 'github');
    const terminal = async (assignments: ReturnType<typeof sql>) => {
      const snap = await pendingSnapshot(
        src,
        must(
          (
            await rows<{ n: number }>(
              db,
              sql`SELECT COUNT(*)::int AS n FROM source_snapshots WHERE project_source_id = ${src.id}`,
            )
          )[0],
        ).n + 1,
      );
      return db.execute(
        sql`UPDATE source_snapshots SET ${assignments}, completed_at = now() WHERE id = ${snap.id}`,
      );
    };
    const bad = [
      sql`status = 'failed'`,
      sql`status = 'failed', failure_category = 'timeout'`,
      sql`status = 'rejected', failure_category = 'timeout', failure_metadata = '{}'::jsonb`,
      sql`status = 'failed', failure_category = 'ssrf_rejected', failure_metadata = '{}'::jsonb`,
      sql`status = 'failed', failure_category = 'timeout', failure_metadata = '{"body":"<html>secret</html>"}'::jsonb`,
      sql`status = 'failed', failure_category = 'timeout', failure_metadata = '{"authorization":"Bearer x"}'::jsonb`,
      sql`status = 'failed', failure_category = 'made_up', failure_metadata = '{}'::jsonb`,
      sql`status = 'captured', captured_at = now(), metadata = '{}'::jsonb`,
      sql`status = 'captured', captured_at = now(), content_hash = 'nothex', metadata = '{}'::jsonb`,
      sql`status = 'partial', captured_at = now(), content_hash = ${sha256('p')}, metadata = '{}'::jsonb`,
      sql`status = 'partial', captured_at = now(), content_hash = ${sha256('p')}, metadata = '{}'::jsonb, partial_reasons = '{invented}'`,
      sql`status = 'captured', captured_at = now(), content_hash = ${sha256('p')}, metadata = '{}'::jsonb, revision = ${SHA_A}`,
    ];
    for (const assignments of bad) {
      await expectPgError(terminal(assignments), SQLSTATE.CHECK_VIOLATION);
    }
    await terminal(
      sql`status = 'failed', failure_category = 'timeout', failure_metadata = '{"host":"app.example","elapsedMs":20000}'::jsonb`,
    );
    await terminal(
      sql`status = 'partial', captured_at = now(), content_hash = ${sha256('p')}, metadata = '{}'::jsonb, partial_reasons = '{body_truncated}'`,
    );
  });

  it('requires an exact commit SHA on GitHub content snapshots', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const src = await source(project.id);
    const snap = await pendingSnapshot(src);
    await expectPgError(
      db.execute(
        sql`UPDATE source_snapshots SET status = 'captured', metadata = '{}'::jsonb, content_hash = ${sha256('x')}, captured_at = now(), completed_at = now() WHERE id = ${snap.id}`,
      ),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE source_snapshots SET status = 'captured', revision = 'main', metadata = '{}'::jsonb, content_hash = ${sha256('x')}, captured_at = now(), completed_at = now() WHERE id = ${snap.id}`,
      ),
      SQLSTATE.CHECK_VIOLATION,
    );
  });

  it('recomputes artifact hashes and byte lengths from the stored text', async () => {
    const { db } = testDb;
    const { project } = await lockedEvent();
    const snap = await pendingSnapshot(await source(project.id));
    await expectPgError(
      db
        .insert(sourceSnapshotArtifacts)
        .values({ ...artifactValues(snap.id), contentHash: sha256('other') }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(sourceSnapshotArtifacts).values({ ...artifactValues(snap.id), byteLength: 1 }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await db
      .insert(sourceSnapshotArtifacts)
      .values(artifactValues(snap.id, 'unicode.txt', 'naïve ☃\n'));
    await expectPgError(
      db.insert(sourceSnapshotArtifacts).values(artifactValues(snap.id, 'unicode.txt')),
      SQLSTATE.UNIQUE_VIOLATION,
    );
  });

  it('links one capture run per snapshot of the same project and never reopens a terminal run', async () => {
    const { db } = testDb;
    const { event, project } = await lockedEvent();
    const other = await lockedEvent();
    const snap = await pendingSnapshot(await source(project.id));
    await expectPgError(
      db.insert(analysisRuns).values({
        runType: 'project_source_capture',
        state: 'pending',
        startedAt: null,
        eventId: event.id,
      }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(analysisRuns).values({
        runType: 'project_source_capture',
        state: 'pending',
        startedAt: null,
        eventId: other.event.id,
        projectId: other.project.id,
        sourceSnapshotId: snap.id,
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    await expectPgError(
      db.insert(analysisRuns).values({
        runType: 'project_source_capture',
        state: 'pending',
        eventId: event.id,
        projectId: project.id,
        sourceSnapshotId: snap.id,
      }),
      SQLSTATE.CHECK_VIOLATION,
    );
    const [run] = await db
      .insert(analysisRuns)
      .values({
        runType: 'project_source_capture',
        state: 'pending',
        startedAt: null,
        eventId: event.id,
        projectId: project.id,
        sourceSnapshotId: snap.id,
      })
      .returning();
    await expectPgError(
      db.insert(analysisRuns).values({
        runType: 'project_source_capture',
        state: 'pending',
        startedAt: null,
        eventId: event.id,
        projectId: project.id,
        sourceSnapshotId: snap.id,
      }),
      SQLSTATE.UNIQUE_VIOLATION,
    );
    await db.execute(
      sql`UPDATE analysis_runs SET state = 'succeeded', started_at = now(), finished_at = now() WHERE id = ${run?.id ?? ''}`,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE analysis_runs SET state = 'running', finished_at = NULL WHERE id = ${run?.id ?? ''}`,
      ),
      SQLSTATE.RESTRICT_VIOLATION,
    );
  });

  it('keeps actors immutable and audit actors referential', async () => {
    const { db } = testDb;
    const [actor] = await db
      .insert(actors)
      .values({ issuer: 'https://idp.test/', subject: 'u1' })
      .returning();
    await expectPgError(
      db.execute(sql`UPDATE actors SET subject = 'u2' WHERE id = ${actor?.id ?? ''}`),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await expectPgError(
      db.insert(actors).values({ issuer: 'https://idp.test/', subject: 'u1' }),
      SQLSTATE.UNIQUE_VIOLATION,
    );
    await expectPgError(
      db.insert(auditEvents).values({
        actorId: '00000000-0000-4000-8000-000000000000',
        entityType: 'project',
        entityId: actor?.id ?? '',
        action: 'project_created',
      }),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
    await db.insert(auditEvents).values({
      actorId: actor?.id ?? null,
      entityType: 'project',
      entityId: actor?.id ?? '',
      action: 'project_created',
    });
  });
});
