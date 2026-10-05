import {
  CAPTURE_REJECTION_CATEGORIES,
  CONTENT_SOURCE_SNAPSHOT_STATUSES,
  UNSUCCESSFUL_SOURCE_SNAPSHOT_STATUSES,
} from '@judge-copilot/domain';
import {
  CAPTURE_FAILURE_CATEGORY_VALUES,
  CAPTURE_FAILURE_METADATA_KEYS,
  CAPTURE_PARTIAL_REASON_VALUES,
  GIT_COMMIT_SHA_PATTERN,
  PROJECT_SOURCE_TYPE_VALUES,
  SHA256_HEX_PATTERN,
  SNAPSHOT_ARTIFACT_KIND_VALUES,
  SOURCE_INGESTION_LIMITS,
  SOURCE_SNAPSHOT_STATUS_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { projectSources } from './project-sources.js';
import { projects } from './projects.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

const L = SOURCE_INGESTION_LIMITS;
const CONTENT = sqlLiteralList(CONTENT_SOURCE_SNAPSHOT_STATUSES);
const UNSUCCESSFUL = sqlLiteralList(UNSUCCESSFUL_SOURCE_SNAPSHOT_STATUSES);
const REJECTIONS = sqlLiteralList(CAPTURE_REJECTION_CATEGORIES);

/**
 * One immutable capture of a declared project source (M2).
 *
 * A row is inserted `pending` (the durable capture request) and transitions exactly once to a
 * terminal status; after that nothing about it can change and it can never be deleted (trigger).
 * A re-capture is always a new row with the next `capture_number`. Project, source, source type
 * and URL must agree with the declaration (composite foreign key). Content statuses carry an
 * aggregate content hash; unsuccessful ones carry a sanitized failure category whose metadata may
 * only use allow-listed keys. GitHub content snapshots always pin an exact commit SHA.
 */
export const sourceSnapshots = pgTable(
  'source_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    projectSourceId: uuid('project_source_id').notNull(),
    captureNumber: integer('capture_number').notNull(),
    sourceType: text('source_type', { enum: PROJECT_SOURCE_TYPE_VALUES }).notNull(),
    sourceUrl: text('source_url').notNull(),
    status: text('status', { enum: SOURCE_SNAPSHOT_STATUS_VALUES }).notNull(),
    /** Exact Git commit SHA (GitHub only). */
    revision: text('revision'),
    /** Normalized snapshot metadata (data only), part of the content hash. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    contentHash: text('content_hash'),
    partialReasons: text('partial_reasons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    failureCategory: text('failure_category', { enum: CAPTURE_FAILURE_CATEGORY_VALUES }),
    failureMetadata: jsonb('failure_metadata').$type<Record<string, unknown>>(),
    requestedByActorId: uuid('requested_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    /** When the capture was requested. */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** When the adapter finished retrieving content (content statuses only). */
    capturedAt: timestamptz('captured_at'),
    /** When the snapshot became terminal. */
    completedAt: timestamptz('completed_at'),
  },
  (table) => [
    unique('source_snapshots_source_capture_number_key').on(
      table.projectSourceId,
      table.captureNumber,
    ),
    // Target for analysis runs: a run's snapshot must belong to the run's project.
    unique('source_snapshots_id_project_id_key').on(table.id, table.projectId),
    foreignKey({
      name: 'source_snapshots_declared_source_fk',
      columns: [table.projectSourceId, table.projectId, table.sourceType, table.sourceUrl],
      foreignColumns: [
        projectSources.id,
        projectSources.projectId,
        projectSources.sourceType,
        projectSources.url,
      ],
    }).onDelete('restrict'),
    index('source_snapshots_project_id_created_at_idx').on(table.projectId, table.createdAt),
    index('source_snapshots_project_source_id_idx').on(table.projectSourceId),
    check(
      'source_snapshots_status_valid',
      sql`status IN (${sqlLiteralList(SOURCE_SNAPSHOT_STATUS_VALUES)})`,
    ),
    check(
      'source_snapshots_source_type_valid',
      sql`source_type IN (${sqlLiteralList(PROJECT_SOURCE_TYPE_VALUES)})`,
    ),
    check('source_snapshots_capture_number_positive', sql`capture_number >= 1`),
    check(
      'source_snapshots_failure_category_valid',
      sql`failure_category IS NULL OR failure_category IN (${sqlLiteralList(CAPTURE_FAILURE_CATEGORY_VALUES)})`,
    ),
    check(
      'source_snapshots_completed_at_matches_status',
      sql`(status = 'pending') = (completed_at IS NULL)`,
    ),
    check(
      'source_snapshots_content_matches_status',
      sql`(status IN (${CONTENT})) = (captured_at IS NOT NULL AND content_hash IS NOT NULL AND metadata IS NOT NULL)`,
    ),
    check(
      'source_snapshots_content_fields_only_with_content',
      sql`status IN (${CONTENT}) OR (captured_at IS NULL AND content_hash IS NULL AND metadata IS NULL AND revision IS NULL)`,
    ),
    check(
      'source_snapshots_failure_matches_status',
      sql`(status IN (${UNSUCCESSFUL})) = (failure_category IS NOT NULL AND failure_metadata IS NOT NULL)`,
    ),
    check(
      'source_snapshots_failure_fields_only_on_failure',
      sql`status IN (${UNSUCCESSFUL}) OR (failure_category IS NULL AND failure_metadata IS NULL)`,
    ),
    check(
      'source_snapshots_rejection_category',
      sql`status <> 'rejected' OR failure_category IN (${REJECTIONS})`,
    ),
    check(
      'source_snapshots_failed_category',
      sql`status <> 'failed' OR failure_category NOT IN (${REJECTIONS})`,
    ),
    check(
      'source_snapshots_partial_reasons_match_status',
      sql`(status = 'partial') = (cardinality(partial_reasons) > 0)`,
    ),
    check(
      'source_snapshots_partial_reasons_valid',
      sql`partial_reasons <@ ARRAY[${sqlLiteralList(CAPTURE_PARTIAL_REASON_VALUES)}]::text[]`,
    ),
    check(
      'source_snapshots_revision_format',
      sql`revision IS NULL OR revision ~ ${sqlPattern(GIT_COMMIT_SHA_PATTERN)}`,
    ),
    check(
      'source_snapshots_github_revision',
      sql`(source_type = 'github' AND status IN (${CONTENT})) = (revision IS NOT NULL)`,
    ),
    check(
      'source_snapshots_content_hash_format',
      sql`content_hash IS NULL OR content_hash ~ ${sqlPattern(SHA256_HEX_PATTERN)}`,
    ),
    check(
      'source_snapshots_failure_metadata_safe',
      sql`failure_metadata IS NULL OR (jsonb_typeof(failure_metadata) = 'object' AND (failure_metadata - ARRAY[${sqlLiteralListOfKeys()}]::text[]) = '{}'::jsonb AND octet_length(failure_metadata::text) <= 4096)`,
    ),
    check(
      'source_snapshots_metadata_bounded',
      sql.raw(
        `metadata IS NULL OR (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= ${String(L.metadataMaxBytes)})`,
      ),
    ),
    check('source_snapshots_url_format', sql`source_url ~ '^https?://'`),
    check(
      'source_snapshots_timestamps_ordered',
      sql`(completed_at IS NULL OR completed_at >= created_at) AND (captured_at IS NULL OR (captured_at >= created_at AND captured_at <= completed_at))`,
    ),
  ],
);

function sqlLiteralListOfKeys() {
  // Failure metadata keys are camelCase, so they are validated here rather than by sqlLiteralList.
  for (const key of CAPTURE_FAILURE_METADATA_KEYS) {
    if (!/^[a-zA-Z]+$/.test(key)) throw new Error(`Refusing to inline unsafe key: ${key}`);
  }
  return sql.raw(CAPTURE_FAILURE_METADATA_KEYS.map((key) => `'${key}'`).join(', '));
}

/**
 * One bounded UTF-8 text artifact of a snapshot (a file, a JSON document, page text). Each is
 * hashed independently; the database recomputes the SHA-256 and byte length from the stored
 * text, so a row can never claim a hash its content does not have. Artifacts can only be added
 * while their snapshot is pending and can never be changed or deleted (trigger).
 */
export const sourceSnapshotArtifacts = pgTable(
  'source_snapshot_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => sourceSnapshots.id, { onDelete: 'restrict' }),
    artifactKey: text('artifact_key').notNull(),
    artifactKind: text('artifact_kind', { enum: SNAPSHOT_ARTIFACT_KIND_VALUES }).notNull(),
    mediaType: text('media_type').notNull(),
    textContent: text('text_content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    byteLength: integer('byte_length').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('source_snapshot_artifacts_snapshot_key_key').on(table.snapshotId, table.artifactKey),
    // Target for evidence provenance (M3): an evidence item's artifact must belong to its snapshot.
    unique('source_snapshot_artifacts_id_snapshot_id_key').on(table.id, table.snapshotId),
    check(
      'source_snapshot_artifacts_kind_valid',
      sql`artifact_kind IN (${sqlLiteralList(SNAPSHOT_ARTIFACT_KIND_VALUES)})`,
    ),
    check(
      'source_snapshot_artifacts_key_length',
      sql.raw(`length(artifact_key) BETWEEN 1 AND ${String(L.artifactKeyMaxChars)}`),
    ),
    check(
      'source_snapshot_artifacts_media_type_format',
      sql`media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'`,
    ),
    check(
      'source_snapshot_artifacts_byte_length',
      sql.raw(
        `byte_length = octet_length(convert_to(text_content, 'UTF8')) AND byte_length <= ${String(L.artifactTextMaxBytes)}`,
      ),
    ),
    check(
      'source_snapshot_artifacts_content_hash',
      sql`content_hash = encode(sha256(convert_to(text_content, 'UTF8')), 'hex')`,
    ),
    check(
      'source_snapshot_artifacts_metadata_bounded',
      sql.raw(
        `jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= ${String(L.metadataMaxBytes)}`,
      ),
    ),
  ],
);
