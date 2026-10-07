import { allowedEvidenceCombinations, M3_EVIDENCE_ORIGINS } from '@judge-copilot/evidence';
import {
  EVIDENCE_GRAPH_LIMITS,
  EVIDENCE_KIND_VALUES,
  EVIDENCE_ORIGIN_VALUES,
  EVIDENCE_RELATION_TYPE_VALUES,
  UNKNOWN_TYPE_VALUES,
  VERIFICATION_LEVEL_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { eventContextVersions } from './event-context-versions.js';
import { projects } from './projects.js';
import { sourceSnapshotArtifacts, sourceSnapshots } from './source-snapshots.js';
import { sqlLiteralList, timestamptz } from './sql.js';

/*
 * The M3 evidence graph. Every table is append-only: rows are immutable historical evidence
 * (triggers in migration 0008 reject UPDATE, DELETE and TRUNCATE). Every cross-record reference
 * is a composite foreign key that carries the project, so a record can never point into another
 * project. `seq` is the persisted insertion (allocation) order: a database-generated identity value used as the
 * deterministic, locale-independent ordering key of graph queries. It is not content-derived, and
 * identity values are allocated when rows are inserted, not when a transaction commits.
 *
 * There is deliberately no score, strength, weight, coverage, confidence, rank or accusation
 * column anywhere in this file.
 */

const L = EVIDENCE_GRAPH_LIMITS;
const VERIFICATION = sqlLiteralList(VERIFICATION_LEVEL_VALUES);

/** The text rule shared by every graph text column: bounded, non-blank and NFC-normalized. */
const textRule = (column: string, max: number) =>
  sql.raw(
    `length(btrim(${column})) BETWEEN 1 AND ${String(max)} AND ${column} = normalize(${column}, NFC)`,
  );

/**
 * `(origin, kind, verification_level)` must be a combination the verification rules allow.
 * Generated from the same table the domain code uses, so the two cannot drift apart.
 */
function verificationMatrixCheck() {
  const clauses = allowedEvidenceCombinations(EVIDENCE_ORIGIN_VALUES, EVIDENCE_KIND_VALUES).map(
    ({ origin, kind, levels }) =>
      `(origin = '${origin}' AND kind = '${kind}' AND verification_level IN (${levels.map((level) => `'${level}'`).join(', ')}))`,
  );
  return sql.raw(clauses.join(' OR '));
}

const SOURCE_ORIGINS = sqlLiteralList(['devpost', 'github', 'deployment', 'video']);

// -- Claims ------------------------------------------------------------------------------------

/**
 * An atomic proposition relevant to one project. Immutable: a correction is a NEW claim whose
 * `supersedes_id` points at the old one (same project, enforced by a composite foreign key; at
 * most one successor, enforced by a unique constraint; no cycles by construction because a row
 * can only reference an existing row and rows never change). Existing as a claim does not make
 * it true.
 */
export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    text: text('text').notNull(),
    verificationLevel: text('verification_level', { enum: VERIFICATION_LEVEL_VALUES }).notNull(),
    supersedesId: uuid('supersedes_id'),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('claims_seq_key').on(table.seq),
    // Target for composite references that pin a row to the same project.
    unique('claims_id_project_id_key').on(table.id, table.projectId),
    // Single-successor history: a claim is superseded at most once.
    unique('claims_supersedes_id_key').on(table.supersedesId),
    foreignKey({
      name: 'claims_supersedes_same_project_fk',
      columns: [table.supersedesId, table.projectId],
      foreignColumns: [table.id, table.projectId],
    }).onDelete('restrict'),
    index('claims_project_id_seq_idx').on(table.projectId, table.seq),
    check('claims_not_self_superseding', sql`supersedes_id IS NULL OR supersedes_id <> id`),
    check('claims_verification_level_valid', sql`verification_level IN (${VERIFICATION})`),
    check('claims_text_valid', textRule('text', L.claimTextMaxChars)),
    check('claims_text_single_line', sql`text !~ E'[\\n\\r]'`),
  ],
);

// -- Evidence items ----------------------------------------------------------------------------

/**
 * An immutable observation or captured statement with structural provenance:
 *   source-derived origins -> an exact SourceSnapshot of the same project (composite FK), optionally
 *   one artifact OF THAT SNAPSHOT (composite FK), optionally a code-point span of the artifact's
 *   stored text with its verbatim excerpt (verified by trigger);
 *   event_context -> a frozen EventContextVersion of the project's event (composite FK).
 * `event_id` repeats the project's event so both composite foreign keys can be enforced.
 */
export const evidenceItems = pgTable(
  'evidence_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid('project_id').notNull(),
    eventId: uuid('event_id').notNull(),
    kind: text('kind', { enum: EVIDENCE_KIND_VALUES }).notNull(),
    origin: text('origin', { enum: EVIDENCE_ORIGIN_VALUES }).notNull(),
    verificationLevel: text('verification_level', { enum: VERIFICATION_LEVEL_VALUES }).notNull(),
    text: text('text').notNull(),
    snapshotId: uuid('snapshot_id'),
    artifactId: uuid('artifact_id'),
    /** Code-point offsets into the artifact's text, half-open `[span_start, span_end)`. */
    spanStart: integer('span_start'),
    spanEnd: integer('span_end'),
    /** The span's exact text (verbatim copy; verified against the artifact by trigger). */
    excerpt: text('excerpt'),
    contextVersionId: uuid('context_version_id'),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('evidence_items_seq_key').on(table.seq),
    unique('evidence_items_id_project_id_key').on(table.id, table.projectId),
    foreignKey({
      name: 'evidence_items_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evidence_items_snapshot_same_project_fk',
      columns: [table.snapshotId, table.projectId],
      foreignColumns: [sourceSnapshots.id, sourceSnapshots.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evidence_items_artifact_same_snapshot_fk',
      columns: [table.artifactId, table.snapshotId],
      foreignColumns: [sourceSnapshotArtifacts.id, sourceSnapshotArtifacts.snapshotId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evidence_items_context_version_same_event_fk',
      columns: [table.contextVersionId, table.eventId],
      foreignColumns: [eventContextVersions.id, eventContextVersions.eventId],
    }).onDelete('restrict'),
    index('evidence_items_project_id_seq_idx').on(table.projectId, table.seq),
    index('evidence_items_snapshot_id_idx').on(table.snapshotId),
    check('evidence_items_kind_valid', sql`kind IN (${sqlLiteralList(EVIDENCE_KIND_VALUES)})`),
    check(
      'evidence_items_origin_valid',
      sql`origin IN (${sqlLiteralList(EVIDENCE_ORIGIN_VALUES)})`,
    ),
    check('evidence_items_verification_level_valid', sql`verification_level IN (${VERIFICATION})`),
    // team_answer and judge_observation are vocabulary only until M7 supplies their records.
    check(
      'evidence_items_origin_supported_in_m3',
      sql`origin IN (${sqlLiteralList(M3_EVIDENCE_ORIGINS)})`,
    ),
    check('evidence_items_verification_matrix', verificationMatrixCheck()),
    check('evidence_items_text_valid', textRule('text', L.evidenceTextMaxChars)),
    check(
      'evidence_items_source_origin_has_snapshot',
      sql`(origin IN (${SOURCE_ORIGINS})) = (snapshot_id IS NOT NULL)`,
    ),
    check(
      'evidence_items_context_origin_has_version',
      sql`(origin = 'event_context') = (context_version_id IS NOT NULL)`,
    ),
    check(
      'evidence_items_artifact_needs_snapshot',
      sql`artifact_id IS NULL OR snapshot_id IS NOT NULL`,
    ),
    check(
      'evidence_items_span_shape',
      sql.raw(
        `(span_start IS NULL) = (span_end IS NULL) AND (span_start IS NULL) = (excerpt IS NULL) AND (span_start IS NULL OR (artifact_id IS NOT NULL AND span_start >= 0 AND span_end > span_start AND span_end - span_start <= ${String(L.excerptMaxChars)} AND char_length(excerpt) = span_end - span_start))`,
      ),
    ),
    check(
      'evidence_items_level_anchors',
      sql`(verification_level <> 'machine_verified' OR (artifact_id IS NOT NULL AND span_start IS NOT NULL)) AND (verification_level <> 'repo_corroborated' OR artifact_id IS NOT NULL)`,
    ),
  ],
);

// -- Relations ---------------------------------------------------------------------------------

/**
 * A claim and an evidence item of the same project: the evidence supports or contradicts the
 * claim. A pair has at most one relation, so duplicate and conflicting relations are impossible.
 * Creating a relation never changes the claim (claims are immutable). absence/unknown evidence
 * cannot be related (trigger): missing evidence is not negative evidence.
 */
export const evidenceRelations = pgTable(
  'evidence_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid('project_id').notNull(),
    claimId: uuid('claim_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    relationType: text('relation_type', { enum: EVIDENCE_RELATION_TYPE_VALUES }).notNull(),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('evidence_relations_seq_key').on(table.seq),
    unique('evidence_relations_claim_evidence_key').on(table.claimId, table.evidenceId),
    foreignKey({
      name: 'evidence_relations_claim_same_project_fk',
      columns: [table.claimId, table.projectId],
      foreignColumns: [claims.id, claims.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evidence_relations_evidence_same_project_fk',
      columns: [table.evidenceId, table.projectId],
      foreignColumns: [evidenceItems.id, evidenceItems.projectId],
    }).onDelete('restrict'),
    index('evidence_relations_project_id_seq_idx').on(table.projectId, table.seq),
    index('evidence_relations_evidence_id_idx').on(table.evidenceId),
    check(
      'evidence_relations_type_valid',
      sql`relation_type IN (${sqlLiteralList(EVIDENCE_RELATION_TYPE_VALUES)})`,
    ),
  ],
);

// -- Unknowns ----------------------------------------------------------------------------------

/**
 * Something relevant that is not established. It is NOT negative evidence and carries no score.
 * `claim_ids` / `evidence_ids` name the graph material that makes the gap understandable; a
 * trigger checks that every element exists in the same project (the targets can never change or
 * disappear, so this is equivalent to a foreign key and keeps the Unknown a single immutable row).
 */
export const unknowns = pgTable(
  'unknowns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    unknownType: text('unknown_type', { enum: UNKNOWN_TYPE_VALUES }).notNull(),
    text: text('text').notNull(),
    claimIds: uuid('claim_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('unknowns_seq_key').on(table.seq),
    unique('unknowns_id_project_id_key').on(table.id, table.projectId),
    index('unknowns_project_id_seq_idx').on(table.projectId, table.seq),
    index('unknowns_claim_ids_idx').using('gin', table.claimIds),
    index('unknowns_evidence_ids_idx').using('gin', table.evidenceIds),
    check('unknowns_type_valid', sql`unknown_type IN (${sqlLiteralList(UNKNOWN_TYPE_VALUES)})`),
    check('unknowns_text_valid', textRule('text', L.unknownTextMaxChars)),
    check(
      'unknowns_reference_counts',
      sql.raw(
        `cardinality(claim_ids) <= ${String(L.unknownRefsMax)} AND cardinality(evidence_ids) <= ${String(L.unknownRefsMax)}`,
      ),
    ),
  ],
);

// -- Contradictions ----------------------------------------------------------------------------

/**
 * An inconsistency between two existing pieces of graph material (claim or evidence), recorded
 * as DATA FOR A JUDGE TO REVIEW: not a penalty, score, fraud flag or accusation. Exactly two
 * sides, in canonical order (`side_a_key < side_b_key`, byte order), so (A, B) and (B, A) are the
 * same record and a pair can be recorded once (unique key). Both sides are composite foreign keys
 * to the same project. absence/unknown evidence cannot be a side (trigger).
 */
export const contradictions = pgTable(
  'contradictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    sideAClaimId: uuid('side_a_claim_id'),
    sideAEvidenceId: uuid('side_a_evidence_id'),
    sideBClaimId: uuid('side_b_claim_id'),
    sideBEvidenceId: uuid('side_b_evidence_id'),
    sideAKey: text('side_a_key').generatedAlwaysAs(
      sql`CASE WHEN side_a_claim_id IS NOT NULL THEN 'claim:' || side_a_claim_id::text ELSE 'evidence:' || side_a_evidence_id::text END`,
    ),
    sideBKey: text('side_b_key').generatedAlwaysAs(
      sql`CASE WHEN side_b_claim_id IS NOT NULL THEN 'claim:' || side_b_claim_id::text ELSE 'evidence:' || side_b_evidence_id::text END`,
    ),
    description: text('description').notNull(),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('contradictions_seq_key').on(table.seq),
    unique('contradictions_id_project_id_key').on(table.id, table.projectId),
    unique('contradictions_pair_key').on(table.projectId, table.sideAKey, table.sideBKey),
    foreignKey({
      name: 'contradictions_side_a_claim_same_project_fk',
      columns: [table.sideAClaimId, table.projectId],
      foreignColumns: [claims.id, claims.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contradictions_side_a_evidence_same_project_fk',
      columns: [table.sideAEvidenceId, table.projectId],
      foreignColumns: [evidenceItems.id, evidenceItems.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contradictions_side_b_claim_same_project_fk',
      columns: [table.sideBClaimId, table.projectId],
      foreignColumns: [claims.id, claims.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contradictions_side_b_evidence_same_project_fk',
      columns: [table.sideBEvidenceId, table.projectId],
      foreignColumns: [evidenceItems.id, evidenceItems.projectId],
    }).onDelete('restrict'),
    index('contradictions_project_id_seq_idx').on(table.projectId, table.seq),
    index('contradictions_side_a_key_idx').on(table.sideAKey),
    index('contradictions_side_b_key_idx').on(table.sideBKey),
    check(
      'contradictions_side_a_exactly_one',
      sql`(side_a_claim_id IS NOT NULL) <> (side_a_evidence_id IS NOT NULL)`,
    ),
    check(
      'contradictions_side_b_exactly_one',
      sql`(side_b_claim_id IS NOT NULL) <> (side_b_evidence_id IS NOT NULL)`,
    ),
    // Distinct sides in canonical (byte) order: collation-independent.
    check('contradictions_sides_canonical', sql`side_a_key COLLATE "C" < side_b_key COLLATE "C"`),
    check(
      'contradictions_description_valid',
      textRule('description', L.contradictionDescriptionMaxChars),
    ),
  ],
);
