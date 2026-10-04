import { PGlite } from '@electric-sql/pglite';
import { createAuditEvent } from '@judge-copilot/audit';
import {
  ANALYSIS_RUN_FAILURE_CATEGORY_VALUES,
  EVENT_CONTEXT_STATUS_VALUES,
} from '@judge-copilot/schemas';
import { eq, sql, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analysisRuns,
  auditEvents,
  createDatabaseAuditSink,
  eventContextVersions,
  events,
  migrationsFolder,
  schema,
  type JudgeDatabase,
} from './index.js';

interface TestDatabase {
  db: JudgeDatabase;
  close: () => Promise<void>;
}

/** In-process PostgreSQL (PGlite): always available, no server, no network. */
async function openPglite(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

/**
 * Real PostgreSQL, only when TEST_DATABASE_URL names a disposable `*_test` database.
 * The schema is dropped and rebuilt from migrations.
 */
async function openPostgres(url: string): Promise<TestDatabase> {
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a disposable database ending in "_test"');
  }
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  await client.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
  );
  const db = drizzlePostgres(client, { schema });
  await migratePostgres(db, { migrationsFolder });
  return { db, close: () => client.end() };
}

async function rows<T>(db: JudgeDatabase, query: SQL): Promise<T[]> {
  // postgres.js returns an array of rows; PGlite returns `{ rows }`.
  const result: unknown = await db.execute(query);
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

/** Asserts that a query fails with one of the given PostgreSQL SQLSTATEs (searching the cause chain). */
async function expectPgError(
  operation: PromiseLike<unknown>,
  ...sqlStates: [string, ...string[]]
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  const codes: unknown[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    codes.push((current as { code?: unknown }).code);
  }
  expect(error, 'expected the query to be rejected').toBeInstanceOf(Error);
  expect(
    codes.some((code) => sqlStates.includes(code as string)),
    `expected SQLSTATE ${sqlStates.join(' or ')}, got ${codes.map(String).join(', ')}`,
  ).toBe(true);
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

const targets: [string, () => Promise<TestDatabase>][] = [['PGlite', openPglite]];
const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
if (testDatabaseUrl) {
  targets.push(['PostgreSQL (TEST_DATABASE_URL)', () => openPostgres(testDatabaseUrl)]);
}

describe.each(targets)('M0 database migrations on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let slugCounter = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });

  afterAll(async () => {
    await testDb.close();
  });

  async function createEvent(): Promise<string> {
    slugCounter += 1;
    const [event] = await db
      .insert(events)
      .values({ name: 'Test Hackathon', slug: `test-hackathon-${slugCounter}` })
      .returning({ id: events.id });
    if (!event) throw new Error('event insert returned no row');
    return event.id;
  }

  it('creates exactly the M0 foundation tables', async () => {
    const tables = await rows<{ table_name: string }>(
      db,
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'analysis_runs',
      'audit_events',
      'event_context_versions',
      'events',
    ]);
  });

  describe('events', () => {
    it('generates UUID ids and timestamptz defaults', async () => {
      const [event] = await db
        .insert(events)
        .values({ name: 'Defaults', slug: 'defaults-check' })
        .returning();
      expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(event?.createdAt).toBeInstanceOf(Date);
      expect(event?.startsAt).toBeNull();
    });

    it('enforces unique, well-formed slugs, non-blank names and ordered dates', async () => {
      await db.insert(events).values({ name: 'A', slug: 'unique-slug' });
      await expectPgError(
        db.insert(events).values({ name: 'B', slug: 'unique-slug' }),
        UNIQUE_VIOLATION,
      );
      await expectPgError(
        db.insert(events).values({ name: 'C', slug: 'Bad Slug' }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(events).values({ name: '  ', slug: 'blank-name' }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(events).values({
          name: 'D',
          slug: 'backwards-dates',
          startsAt: new Date('2027-01-02T00:00:00Z'),
          endsAt: new Date('2027-01-01T00:00:00Z'),
        }),
        CHECK_VIOLATION,
      );
    });
  });

  describe('event_context_versions', () => {
    it('accepts every EventContextStatus value with the matching locked_at rule', async () => {
      const eventId = await createEvent();
      for (const [index, status] of EVENT_CONTEXT_STATUS_VALUES.entries()) {
        const frozen = status === 'locked' || status === 'superseded';
        await db.insert(eventContextVersions).values({
          eventId,
          version: index + 1,
          status,
          lockedAt: frozen ? new Date() : null,
        });
      }
    });

    it('rejects unknown statuses and locked_at inconsistent with status', async () => {
      const eventId = await createEvent();
      await expectPgError(
        db.execute(
          sql`INSERT INTO event_context_versions (event_id, version, status) VALUES (${eventId}, 1, 'approved')`,
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(eventContextVersions).values({ eventId, version: 1, status: 'locked' }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(eventContextVersions).values({
          eventId,
          version: 1,
          status: 'draft',
          lockedAt: new Date(),
        }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(eventContextVersions).values({ eventId, version: 0, status: 'draft' }),
        CHECK_VIOLATION,
      );
    });

    it('keeps (event_id, version) unique and allows only one locked version per event', async () => {
      const eventId = await createEvent();
      await db.insert(eventContextVersions).values({ eventId, version: 1, status: 'draft' });
      await expectPgError(
        db.insert(eventContextVersions).values({ eventId, version: 1, status: 'in_review' }),
        UNIQUE_VIOLATION,
      );

      await db
        .insert(eventContextVersions)
        .values({ eventId, version: 2, status: 'locked', lockedAt: new Date() });
      await expectPgError(
        db
          .insert(eventContextVersions)
          .values({ eventId, version: 3, status: 'locked', lockedAt: new Date() }),
        UNIQUE_VIOLATION,
      );
    });

    it('only lets a version supersede another version of the same event', async () => {
      const eventA = await createEvent();
      const eventB = await createEvent();
      const [v1] = await db
        .insert(eventContextVersions)
        .values({ eventId: eventA, version: 1, status: 'superseded', lockedAt: new Date() })
        .returning({ id: eventContextVersions.id });
      if (!v1) throw new Error('version insert returned no row');

      await db.insert(eventContextVersions).values({
        eventId: eventA,
        version: 2,
        status: 'locked',
        lockedAt: new Date(),
        supersedesId: v1.id,
        changeReason: 'Organizers clarified the prior-work rule.',
      });
      await expectPgError(
        db
          .insert(eventContextVersions)
          .values({ eventId: eventB, version: 1, status: 'draft', supersedesId: v1.id }),
        FOREIGN_KEY_VIOLATION,
      );
      await expectPgError(
        db
          .update(eventContextVersions)
          .set({ supersedesId: v1.id })
          .where(eq(eventContextVersions.id, v1.id)),
        CHECK_VIOLATION,
      );
    });

    it('prevents deleting an event that has context versions', async () => {
      const eventId = await createEvent();
      await db.insert(eventContextVersions).values({ eventId, version: 1, status: 'draft' });
      // ON DELETE RESTRICT reports foreign_key_violation before PostgreSQL 17, restrict_violation since.
      await expectPgError(
        db.delete(events).where(eq(events.id, eventId)),
        FOREIGN_KEY_VIOLATION,
        RESTRICT_VIOLATION,
      );
    });
  });

  describe('analysis_runs', () => {
    it('accepts running runs (with or without an event) and every failure category', async () => {
      const eventId = await createEvent();
      await db.insert(analysisRuns).values({ runType: 'foundation_check', state: 'running' });
      await db
        .insert(analysisRuns)
        .values({ eventId, runType: 'foundation_check', state: 'running' });
      for (const failureCategory of ANALYSIS_RUN_FAILURE_CATEGORY_VALUES) {
        await db.insert(analysisRuns).values({
          runType: 'foundation_check',
          state: 'failed',
          finishedAt: new Date(Date.now() + 1000),
          failureCategory,
        });
      }
    });

    it('ties finished_at and failure_category to the run state', async () => {
      const later = new Date(Date.now() + 1000);
      await expectPgError(
        db.insert(analysisRuns).values({ runType: 'x', state: 'running', finishedAt: later }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(analysisRuns).values({ runType: 'x', state: 'succeeded' }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(analysisRuns).values({ runType: 'x', state: 'failed', finishedAt: later }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(analysisRuns).values({
          runType: 'x',
          state: 'succeeded',
          finishedAt: later,
          failureCategory: 'timeout',
        }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(analysisRuns).values({ runType: 'Not Snake', state: 'running' }),
        CHECK_VIOLATION,
      );
    });
  });

  describe('audit_events', () => {
    it('persists events through the AuditSink port and is append-only', async () => {
      const eventId = await createEvent();
      const auditEvent = createAuditEvent({
        actorId: null,
        entityType: 'event',
        entityId: eventId,
        action: 'event.created',
        metadata: { source: 'migration-test' },
      });
      await createDatabaseAuditSink(db).append(auditEvent);

      const [stored] = await db.select().from(auditEvents).where(eq(auditEvents.id, auditEvent.id));
      expect(stored).toMatchObject({
        entityType: 'event',
        entityId: eventId,
        action: 'event.created',
        metadata: { source: 'migration-test' },
      });

      await expectPgError(
        db
          .update(auditEvents)
          .set({ action: 'event.renamed' })
          .where(eq(auditEvents.id, auditEvent.id)),
        RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.delete(auditEvents).where(eq(auditEvents.id, auditEvent.id)),
        RESTRICT_VIOLATION,
      );
      await expectPgError(db.execute(sql`TRUNCATE audit_events`), RESTRICT_VIOLATION);
    });

    it('requires object metadata and well-formed identifiers', async () => {
      const entityId = await createEvent();
      await expectPgError(
        db.execute(
          sql`INSERT INTO audit_events (entity_type, entity_id, action, metadata) VALUES ('event', ${entityId}, 'event.created', '[]'::jsonb)`,
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(auditEvents).values({ entityType: 'Event', entityId, action: 'event.created' }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.insert(auditEvents).values({ entityType: 'event', entityId, action: 'event created' }),
        CHECK_VIOLATION,
      );
    });
  });
});
