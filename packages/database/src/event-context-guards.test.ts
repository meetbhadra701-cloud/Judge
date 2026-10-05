/*
 * M1 database guards, exercised directly (bypassing application code): event sources are
 * immutable rows, frozen versions only move locked -> superseded, provenance references in JSONB
 * content stay inside their version, and nothing references projects.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventContextVersions, eventSources, events, type JudgeDatabase } from './index.js';
import {
  expectPgError,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';

const HASH = 'a'.repeat(64);

describe.each(testDatabaseTargets())('M1 Event Context guards on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let counter = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.close();
  });

  async function draftWithSource() {
    counter += 1;
    const [event] = await db
      .insert(events)
      .values({ name: 'Guards', slug: `guards-${String(counter)}` })
      .returning();
    const [version] = await db
      .insert(eventContextVersions)
      .values({ eventId: event?.id ?? '', version: 1, status: 'draft' })
      .returning();
    const [source] = await db
      .insert(eventSources)
      .values({
        contextVersionId: version?.id ?? '',
        sourceType: 'pasted_text',
        authority: 'official_event_rules',
        title: 'Rules',
        normalizedText: 'Rules.',
        contentHash: HASH,
        position: 0,
      })
      .returning();
    if (!event || !version || !source) throw new Error('seed failed');
    return { event, version, source };
  }

  it('treats event sources as immutable rows even while the version is a draft', async () => {
    const { source } = await draftWithSource();
    await expectPgError(
      db
        .update(eventSources)
        .set({ normalizedText: 'Rewritten history.' })
        .where(eq(eventSources.id, source.id)),
      SQLSTATE.RESTRICT_VIOLATION,
    );
  });

  it('enforces source hash format, url_text urls and unique positions', async () => {
    const { version } = await draftWithSource();
    const base = {
      contextVersionId: version.id,
      sourceType: 'pasted_text' as const,
      authority: 'judge_context' as const,
      title: 'Note',
      normalizedText: 'Note.',
      contentHash: HASH,
    };
    await expectPgError(
      db.insert(eventSources).values({ ...base, contentHash: 'abc', position: 1 }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(eventSources).values({ ...base, sourceType: 'url_text', position: 1 }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(eventSources).values({ ...base, url: 'javascript:alert(1)', position: 1 }),
      SQLSTATE.CHECK_VIOLATION,
    );
    await expectPgError(
      db.insert(eventSources).values({ ...base, position: 0 }),
      SQLSTATE.UNIQUE_VIOLATION,
    );
  });

  it('only lets a locked version become superseded, and only by changing its status', async () => {
    const { version } = await draftWithSource();
    await expectPgError(
      db
        .update(eventContextVersions)
        .set({ status: 'superseded', lockedAt: new Date() })
        .where(eq(eventContextVersions.id, version.id)),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await db
      .update(eventContextVersions)
      .set({ status: 'locked', lockedAt: new Date(), lockedContentHash: HASH })
      .where(eq(eventContextVersions.id, version.id));
    await expectPgError(
      db
        .update(eventContextVersions)
        .set({ status: 'superseded', summary: 'sneaky' })
        .where(eq(eventContextVersions.id, version.id)),
      SQLSTATE.RESTRICT_VIOLATION,
    );
    await db
      .update(eventContextVersions)
      .set({ status: 'superseded' })
      .where(eq(eventContextVersions.id, version.id));
    await expectPgError(
      db
        .update(eventContextVersions)
        .set({ status: 'locked' })
        .where(eq(eventContextVersions.id, version.id)),
      SQLSTATE.RESTRICT_VIOLATION,
    );
  });

  it('rejects JSONB content citing a source from another version', async () => {
    const a = await draftWithSource();
    const b = await draftWithSource();
    const content = (sourceId: string) =>
      sql`${JSON.stringify({ rules: [{ statement: 'x', sourceIds: [sourceId] }], conflicts: [{ positions: [{ sourceId }] }] })}::jsonb`;
    await db.execute(
      sql`UPDATE event_context_versions SET content = ${content(a.source.id)} WHERE id = ${a.version.id}`,
    );
    await expectPgError(
      db.execute(
        sql`UPDATE event_context_versions SET content = ${content(b.source.id)} WHERE id = ${a.version.id}`,
      ),
      SQLSTATE.FOREIGN_KEY_VIOLATION,
    );
  });

  it('keeps Event Context tables independent of projects, and no score columns exist anywhere', async () => {
    // M2 added project tables; Event Context tables still have no project or score columns.
    const columns = await rows<{ table_name: string; column_name: string }>(
      db,
      sql`SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((column_name LIKE '%project%' AND table_name IN ('events', 'event_context_versions', 'event_sources', 'tracks', 'rubrics', 'rubric_criteria', 'rubric_anchors'))
              OR (column_name LIKE '%score%' AND table_name <> 'rubric_anchors'))`,
    );
    expect(columns).toEqual([]);
  });
});
