/* Test-only harness for Event Context integration tests. Excluded from the package build. */
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  createReplayExtractor,
  type EventContextExtractor,
  type ReplayRecordingInput,
} from '@judge-copilot/context';
import { auditEvents, migrationsFolder, schema, type JudgeDatabase } from '@judge-copilot/database';
import { asc, eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { EventContextService } from '../event-context/service.js';
import { loadReplayRecordings } from '../replay.js';

export const FIXTURE_DIR = resolve(import.meta.dirname, '../../../../tests/fixtures/event-context');

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
  const client = postgres(url, { max: 1, onnotice: () => undefined });
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

export async function loadFixtures(): Promise<Map<string, ReplayRecordingInput>> {
  const recordings = await loadReplayRecordings(FIXTURE_DIR);
  return new Map(recordings.map((recording) => [recording.name, recording]));
}

export function replayService(
  db: JudgeDatabase,
  recordings: Iterable<ReplayRecordingInput>,
): EventContextService {
  return new EventContextService({ db, extractor: createReplayExtractor([...recordings]) });
}

export function serviceWith(
  db: JudgeDatabase,
  extractor: EventContextExtractor | null,
): EventContextService {
  return new EventContextService({ db, extractor });
}

let slugCounter = 0;

/** Creates an event and a draft v1 holding exactly the recording's sources. */
export async function seedFromRecording(
  service: EventContextService,
  recording: ReplayRecordingInput,
) {
  slugCounter += 1;
  const event = await service.createEvent({
    name: recording.event.name,
    slug: `${recording.event.slug}-${String(slugCounter)}`,
  });
  const version = await service.createContextVersion(event.id, {});
  const sourceIdByRef = new Map<string, string>();
  for (const source of recording.sources) {
    const added = await service.addSource(event.id, version.id, {
      sourceType: source.sourceType,
      authority: source.authority,
      title: source.title,
      url: source.url ?? null,
      normalizedText: source.normalizedText,
    });
    sourceIdByRef.set(source.ref, added.id);
  }
  return { eventId: event.id, versionId: version.id, sourceIdByRef };
}

export async function auditTrail(db: JudgeDatabase, entityId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt));
}

export function requireValue<T>(value: T | undefined | null, label = 'value'): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}`);
  return value;
}
