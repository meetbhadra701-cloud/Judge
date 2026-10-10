import { FIDELITY_DISPOSITION_VALUES, UNIT_DISPOSITION_VALUES } from '@judge-copilot/assessment';
import {
  ASSESSMENT_REQUEST_MODE_VALUES,
  ASSESSMENT_RUN_OUTCOME_VALUES,
  ASSESSMENT_STAGE_VALUES,
  CALL_STATE_VALUES,
  EXTRACTION_EVIDENCE_ROLE_VALUES,
  EXTRACTION_KIND_VALUES,
  GRAPH_RECORD_TYPE_VALUES,
  IDENTIFIER_PATTERN,
  PROVIDER_MODE_VALUES,
  REFERENCE_APPLICABILITY_VALUES,
  REFERENCE_KIND_VALUES,
  RELATION_BASIS_VALUES,
  RESPONSE_RECORD_STATE_VALUES,
  SCORING_TARGET_KIND_VALUES,
  USAGE_BASIS_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { analysisRuns } from './analysis-runs.js';
import { eventContextVersions } from './event-context-versions.js';
import { evidenceItems } from './evidence-graph.js';
import { projects } from './projects.js';
import { sourceSnapshots } from './source-snapshots.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

/*
 * M5 P4: assessment persistence (docs/milestones/M5-design.md §7-§8, as amended by M5-P4-note.md).
 *
 * Every table is append-only except the ledger row (`assessment_run_calls`), which makes exactly one `reserved` -> terminal transition.
 * Migration 0011 adds the triggers: immutability, version sequencing, ownership, the deferred completeness checks and the budget
 * guard. Money is stored as exact integer NANO-USD (the unit of `packages/llm`): there is no micro-USD column, so there is nothing to
 * round. All hashes are 64 lowercase hex characters.
 */

const HEX64 = sqlPattern('^[0-9a-f]{64}$');
const MAX_SAFE = '9007199254740991';
const hexCheck = (name: string, column: string) =>
  check(name, sql.raw(`${column} IS NULL OR ${column} ~ '^[0-9a-f]{64}$'`));
const nonNegative = (name: string, column: string) =>
  check(name, sql.raw(`${column} IS NULL OR (${column} >= 0 AND ${column} <= ${MAX_SAFE})`));
const identifier = sqlPattern(IDENTIFIER_PATTERN);

/** A bigint holding an exact integer no larger than 2^53-1, so JavaScript reads it without loss. */
const safeBigint = (name: string) => bigint(name, { mode: 'number' });

// -- Run inputs (immutable pins) -----------------------------------------------------------------------------------------

/**
 * What the assessment is ABOUT, fixed at S0 under the project lock (§7.2): the locked context version and its content hash, the
 * declared track keys, the scoring target and the pipeline configuration. 1:1 with the run. Later captures, declarations or
 * context changes do not alter it.
 */
export const assessmentRunInputs = pgTable(
  'assessment_run_inputs',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => analysisRuns.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    eventId: uuid('event_id').notNull(),
    contextVersionId: uuid('context_version_id').notNull(),
    lockedContentHash: text('locked_content_hash').notNull(),
    declaredTrackKeys: text('declared_track_keys').array().notNull(),
    trackSelectionIds: uuid('track_selection_ids').array().notNull(),
    trackSelectionSetHash: text('track_selection_set_hash').notNull(),
    targetKind: text('target_kind', { enum: SCORING_TARGET_KIND_VALUES }).notNull(),
    targetTrackKey: text('target_track_key'),
    inputsFingerprint: text('inputs_fingerprint').notNull(),
    pipelineConfig: jsonb('pipeline_config').$type<Record<string, unknown>>().notNull(),
    pipelineConfigHash: text('pipeline_config_hash').notNull(),
    requestedByActorId: uuid('requested_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'assessment_run_inputs_run_same_project_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_run_inputs_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_run_inputs_context_same_event_fk',
      columns: [table.contextVersionId, table.eventId],
      foreignColumns: [eventContextVersions.id, eventContextVersions.eventId],
    }).onDelete('restrict'),
    unique('assessment_run_inputs_run_context_key').on(table.runId, table.contextVersionId),
    check('assessment_run_inputs_locked_hash_hex', sql`locked_content_hash ~ ${HEX64}`),
    check('assessment_run_inputs_selection_hash_hex', sql`track_selection_set_hash ~ ${HEX64}`),
    check('assessment_run_inputs_fingerprint_hex', sql`inputs_fingerprint ~ ${HEX64}`),
    check('assessment_run_inputs_config_hash_hex', sql`pipeline_config_hash ~ ${HEX64}`),
    check(
      'assessment_run_inputs_target_valid',
      sql`target_kind IN (${sqlLiteralList(SCORING_TARGET_KIND_VALUES)}) AND ((target_kind = 'track') = (target_track_key IS NOT NULL))`,
    ),
    check(
      'assessment_run_inputs_track_arrays_match',
      sql`cardinality(declared_track_keys) = cardinality(track_selection_ids) AND array_position(declared_track_keys, NULL) IS NULL AND array_position(track_selection_ids, NULL) IS NULL`,
    ),
    check('assessment_run_inputs_config_is_object', sql`jsonb_typeof(pipeline_config) = 'object'`),
  ],
);

/** The exact terminal, content-bearing snapshots a run is about (project ownership by composite FK, hash by trigger). */
export const assessmentRunInputSnapshots = pgTable(
  'assessment_run_input_snapshots',
  {
    runId: uuid('run_id').notNull(),
    projectId: uuid('project_id').notNull(),
    snapshotId: uuid('snapshot_id').notNull(),
    snapshotContentHash: text('snapshot_content_hash').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'assessment_run_input_snapshots_pkey',
      columns: [table.runId, table.snapshotId],
    }),
    foreignKey({
      name: 'assessment_run_input_snapshots_run_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_run_input_snapshots_snapshot_same_project_fk',
      columns: [table.snapshotId, table.projectId],
      foreignColumns: [sourceSnapshots.id, sourceSnapshots.projectId],
    }).onDelete('restrict'),
    check('assessment_run_input_snapshots_hash_hex', sql`snapshot_content_hash ~ ${HEX64}`),
  ],
);

// -- Budget and call ledger ---------------------------------------------------------------------------------------------

/**
 * The LIMITS of one run's local spending guard, fixed when the run is created, and the row every reserve/settle locks
 * (`SELECT ... FOR UPDATE`). Totals are NOT stored here: they are derived from the ledger under that lock, so a counter can never
 * disagree with the calls it summarizes. It is a local guard, not a provider billing limit.
 */
export const assessmentRunBudget = pgTable(
  'assessment_run_budget',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => analysisRuns.id, { onDelete: 'restrict' }),
    maxCalls: integer('max_calls').notNull(),
    maxInputTokens: safeBigint('max_input_tokens').notNull(),
    maxOutputTokens: safeBigint('max_output_tokens').notNull(),
    maxCostNanoUsd: safeBigint('max_cost_nano_usd').notNull(),
    maxReservedInputTokensPerCall: safeBigint('max_reserved_input_tokens_per_call').notNull(),
    runWallClockMs: safeBigint('run_wall_clock_ms').notNull(),
    priceTableId: text('price_table_id').notNull(),
  },
  () => [
    check(
      'assessment_run_budget_limits_positive',
      sql.raw(
        `max_calls > 0 AND max_input_tokens > 0 AND max_output_tokens > 0 AND max_cost_nano_usd > 0 AND max_reserved_input_tokens_per_call > 0 AND run_wall_clock_ms > 0 AND max_input_tokens <= ${MAX_SAFE} AND max_output_tokens <= ${MAX_SAFE} AND max_cost_nano_usd <= ${MAX_SAFE} AND run_wall_clock_ms <= ${MAX_SAFE}`,
      ),
    ),
    check('assessment_run_budget_price_table_format', sql`price_table_id ~ '^prices/v[0-9]+$'`),
  ],
);

/**
 * The append-only call ledger. Every attempt is a row (released and unknown ones included, so the attempt limit cannot be evaded).
 * The one allowed UPDATE is `reserved` -> `settled | released | unknown`. No prompt text, system text, schema text, header or
 * credential is ever stored: only digests, versions, the bounded model ANSWER (as canonical text) and the closed set the request
 * offered (handles only).
 */
export const assessmentRunCalls = pgTable(
  'assessment_run_calls',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    stage: text('stage', { enum: ASSESSMENT_STAGE_VALUES }).notNull(),
    attempt: integer('attempt').notNull(),
    model: text('model').notNull(),
    provider: text('provider'),
    providerMode: text('provider_mode', { enum: PROVIDER_MODE_VALUES }),
    requestDigest: text('request_digest').notNull(),
    promptId: text('prompt_id'),
    promptVersion: text('prompt_version'),
    promptTemplateHash: text('prompt_template_hash'),
    schemaId: text('schema_id'),
    schemaVersion: text('schema_version'),
    generationSettings: jsonb('generation_settings').$type<Record<string, unknown>>(),
    closedSet: jsonb('closed_set').$type<Record<string, unknown>>(),
    closedSetHash: text('closed_set_hash'),
    reservedInputTokens: safeBigint('reserved_input_tokens').notNull(),
    reservedOutputTokens: safeBigint('reserved_output_tokens').notNull(),
    reservedCostNanoUsd: safeBigint('reserved_cost_nano_usd').notNull(),
    state: text('state', { enum: CALL_STATE_VALUES }).notNull().default('reserved'),
    usageBasis: text('usage_basis', { enum: USAGE_BASIS_VALUES }),
    inputTokens: safeBigint('input_tokens'),
    outputTokens: safeBigint('output_tokens'),
    costNanoUsd: safeBigint('cost_nano_usd'),
    outcomeCode: text('outcome_code'),
    responseHash: text('response_hash'),
    responseCanonical: text('response_canonical'),
    responseRecord: text('response_record', { enum: RESPONSE_RECORD_STATE_VALUES })
      .notNull()
      .default('none'),
    responseBytes: integer('response_bytes'),
    boundViolation: boolean('bound_violation').notNull().default(false),
    reservedAt: timestamptz('reserved_at').notNull().defaultNow(),
    settledAt: timestamptz('settled_at'),
  },
  (table) => [
    primaryKey({ name: 'assessment_run_calls_pkey', columns: [table.runId, table.seq] }),
    unique('assessment_run_calls_run_digest_attempt_key').on(
      table.runId,
      table.requestDigest,
      table.attempt,
    ),
    index('assessment_run_calls_run_state_idx').on(table.runId, table.state),
    check('assessment_run_calls_seq_positive', sql`seq >= 1 AND attempt >= 1`),
    check('assessment_run_calls_state_valid', sql`state IN (${sqlLiteralList(CALL_STATE_VALUES)})`),
    check(
      'assessment_run_calls_usage_basis_valid',
      sql`usage_basis IS NULL OR usage_basis IN (${sqlLiteralList(USAGE_BASIS_VALUES)})`,
    ),
    check(
      'assessment_run_calls_response_record_valid',
      sql`response_record IN (${sqlLiteralList(RESPONSE_RECORD_STATE_VALUES)})`,
    ),
    check(
      'assessment_run_calls_digest_format',
      sql`length(request_digest) BETWEEN 1 AND 128 AND request_digest !~ '[[:space:]]'`,
    ),
    check(
      'assessment_run_calls_response_hash_format',
      sql`response_hash IS NULL OR (length(response_hash) BETWEEN 1 AND 128 AND response_hash !~ '[[:space:]]')`,
    ),
    hexCheck('assessment_run_calls_closed_set_hash_hex', 'closed_set_hash'),
    hexCheck('assessment_run_calls_template_hash_hex', 'prompt_template_hash'),
    nonNegative('assessment_run_calls_reserved_input_valid', 'reserved_input_tokens'),
    nonNegative('assessment_run_calls_reserved_output_valid', 'reserved_output_tokens'),
    nonNegative('assessment_run_calls_reserved_cost_valid', 'reserved_cost_nano_usd'),
    nonNegative('assessment_run_calls_input_valid', 'input_tokens'),
    nonNegative('assessment_run_calls_output_valid', 'output_tokens'),
    nonNegative('assessment_run_calls_cost_valid', 'cost_nano_usd'),
    check(
      'assessment_run_calls_state_shape',
      sql`(
        (state = 'reserved' AND usage_basis IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cost_nano_usd IS NULL AND outcome_code IS NULL AND settled_at IS NULL)
        OR (state = 'settled' AND usage_basis IN ('measured', 'estimated') AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cost_nano_usd IS NOT NULL AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
        OR (state = 'released' AND usage_basis IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cost_nano_usd IS NULL AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
        OR (state = 'unknown' AND usage_basis = 'unknown_reserved' AND input_tokens = reserved_input_tokens AND output_tokens = reserved_output_tokens AND cost_nano_usd = reserved_cost_nano_usd AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
      )`,
    ),
    check(
      'assessment_run_calls_response_shape',
      sql`(state = 'settled' OR (response_record = 'none' AND response_canonical IS NULL AND response_hash IS NULL AND response_bytes IS NULL))
        AND ((response_record = 'stored') = (response_canonical IS NOT NULL))
        AND (response_canonical IS NULL OR octet_length(response_canonical) <= 262144)
        AND (response_record <> 'stored' OR response_bytes = octet_length(response_canonical))`,
    ),
    check(
      'assessment_run_calls_closed_set_shape',
      sql`(closed_set IS NULL) = (closed_set_hash IS NULL) AND (closed_set IS NULL OR (jsonb_typeof(closed_set) = 'object' AND pg_column_size(closed_set) <= 524288))`,
    ),
    check(
      'assessment_run_calls_settings_shape',
      sql`generation_settings IS NULL OR (jsonb_typeof(generation_settings) = 'object' AND pg_column_size(generation_settings) <= 8192)`,
    ),
    check(
      'assessment_run_calls_outcome_code_format',
      sql`outcome_code IS NULL OR outcome_code ~ ${identifier}`,
    ),
  ],
);

// -- Terminal outcome ---------------------------------------------------------------------------------------------------

/** One row per terminal run, written in the same transaction as the terminal state. Totals are copied from the ledger. */
export const assessmentRunOutcomes = pgTable(
  'assessment_run_outcomes',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => analysisRuns.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    outcome: text('outcome', { enum: ASSESSMENT_RUN_OUTCOME_VALUES }).notNull(),
    failureCategory: text('failure_category'),
    failureCode: text('failure_code'),
    stageReached: text('stage_reached'),
    providerMode: text('provider_mode', { enum: PROVIDER_MODE_VALUES }),
    attemptsStarted: integer('attempts_started').notNull(),
    settledCalls: integer('settled_calls').notNull(),
    unknownCalls: integer('unknown_calls').notNull(),
    releasedCalls: integer('released_calls').notNull(),
    inputTokens: safeBigint('input_tokens').notNull(),
    outputTokens: safeBigint('output_tokens').notNull(),
    costNanoUsd: safeBigint('cost_nano_usd').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'assessment_run_outcomes_run_same_project_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    check(
      'assessment_run_outcomes_outcome_valid',
      sql`outcome IN (${sqlLiteralList(ASSESSMENT_RUN_OUTCOME_VALUES)})`,
    ),
    check(
      'assessment_run_outcomes_failure_matches_outcome',
      sql`(outcome = 'failed') = (failure_category IS NOT NULL)`,
    ),
    check(
      'assessment_run_outcomes_codes_format',
      sql`(failure_code IS NULL OR failure_code ~ ${identifier}) AND (stage_reached IS NULL OR stage_reached ~ ${identifier})`,
    ),
    check(
      'assessment_run_outcomes_counts_valid',
      sql`attempts_started = settled_calls + unknown_calls + released_calls AND attempts_started >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND cost_nano_usd >= 0`,
    ),
  ],
);

// -- Extractions (graph membership) -------------------------------------------------------------------------------------

/**
 * One atomic extraction: the graph records one pipeline pass created, with their explicit membership. Written in the SAME
 * transaction as the records (`GraphExtractionStore`); membership is exactly the rows of `graph_extraction_items`, never derived from
 * a query such as "evidence on these snapshots". `members_hash` is recomputed by the database (migration 0011) from those rows.
 */
export const graphExtractions = pgTable(
  'graph_extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    eventId: uuid('event_id').notNull(),
    kind: text('kind', { enum: EXTRACTION_KIND_VALUES }).notNull(),
    extractionKey: text('extraction_key').notNull(),
    snapshotIds: uuid('snapshot_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    contextVersionId: uuid('context_version_id'),
    configHash: text('config_hash').notNull(),
    claimCount: integer('claim_count').notNull(),
    evidenceCount: integer('evidence_count').notNull(),
    relationCount: integer('relation_count').notNull(),
    unknownCount: integer('unknown_count').notNull(),
    contradictionCount: integer('contradiction_count').notNull(),
    membersHash: text('members_hash').notNull(),
    createdByRunId: uuid('created_by_run_id').references(() => analysisRuns.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('graph_extractions_key_key').on(table.extractionKey),
    unique('graph_extractions_id_project_id_key').on(table.id, table.projectId),
    foreignKey({
      name: 'graph_extractions_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'graph_extractions_context_same_event_fk',
      columns: [table.contextVersionId, table.eventId],
      foreignColumns: [eventContextVersions.id, eventContextVersions.eventId],
    }).onDelete('restrict'),
    index('graph_extractions_project_id_idx').on(table.projectId),
    check('graph_extractions_kind_valid', sql`kind IN (${sqlLiteralList(EXTRACTION_KIND_VALUES)})`),
    check('graph_extractions_key_hex', sql`extraction_key ~ ${HEX64}`),
    check('graph_extractions_config_hash_hex', sql`config_hash ~ ${HEX64}`),
    check('graph_extractions_members_hash_hex', sql`members_hash ~ ${HEX64}`),
    check(
      'graph_extractions_kind_shape',
      sql`(kind = 'source' AND context_version_id IS NULL AND cardinality(snapshot_ids) >= 1) OR (kind = 'context_evidence' AND context_version_id IS NOT NULL AND cardinality(snapshot_ids) = 0)`,
    ),
    check(
      'graph_extractions_counts_valid',
      sql`claim_count >= 0 AND evidence_count >= 0 AND relation_count >= 0 AND unknown_count >= 0 AND contradiction_count >= 0 AND claim_count + evidence_count + relation_count + unknown_count + contradiction_count >= 1`,
    ),
  ],
);

/**
 * One member record of an extraction and how it came to be. A record belongs to AT MOST ONE extraction (primary key on the
 * record). `ordinal` is the 1-based creation order within the extraction and type: the order defines the handles C-001, E-001, ...
 */
export const graphExtractionItems = pgTable(
  'graph_extraction_items',
  {
    recordType: text('record_type', { enum: GRAPH_RECORD_TYPE_VALUES }).notNull(),
    recordId: uuid('record_id').notNull(),
    extractionId: uuid('extraction_id').notNull(),
    projectId: uuid('project_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    /** Evidence only. */
    role: text('role', { enum: EXTRACTION_EVIDENCE_ROLE_VALUES }),
    /** Claims and interpreted evidence: how the stored text relates to the source (§4.5). */
    grounding: text('grounding', { enum: FIDELITY_DISPOSITION_VALUES }),
    /** Relations only. */
    relationBasis: text('relation_basis', { enum: RELATION_BASIS_VALUES }),
    /** Event-Context reference evidence only: the code-authored metadata (EventReferenceMeta). */
    referenceBuilder: text('reference_builder'),
    referenceKind: text('reference_kind', { enum: REFERENCE_KIND_VALUES }),
    referenceApplicability: text('reference_applicability', {
      enum: REFERENCE_APPLICABILITY_VALUES,
    }),
    referenceTrackKey: text('reference_track_key'),
  },
  (table) => [
    primaryKey({
      name: 'graph_extraction_items_pkey',
      columns: [table.recordType, table.recordId],
    }),
    unique('graph_extraction_items_ordinal_key').on(
      table.extractionId,
      table.recordType,
      table.ordinal,
    ),
    foreignKey({
      name: 'graph_extraction_items_extraction_same_project_fk',
      columns: [table.extractionId, table.projectId],
      foreignColumns: [graphExtractions.id, graphExtractions.projectId],
    }).onDelete('restrict'),
    index('graph_extraction_items_record_idx').on(table.recordId),
    check(
      'graph_extraction_items_type_valid',
      sql`record_type IN (${sqlLiteralList(GRAPH_RECORD_TYPE_VALUES)})`,
    ),
    check('graph_extraction_items_ordinal_positive', sql`ordinal >= 1`),
    check(
      'graph_extraction_items_role_shape',
      sql`(record_type = 'evidence') = (role IS NOT NULL)`,
    ),
    check(
      'graph_extraction_items_grounding_shape',
      sql`grounding IS NULL OR record_type IN ('claim', 'evidence')`,
    ),
    check(
      'graph_extraction_items_basis_shape',
      sql`(record_type = 'relation') = (relation_basis IS NOT NULL)`,
    ),
    check(
      'graph_extraction_items_reference_shape',
      sql`(role = 'event_reference') = (reference_builder IS NOT NULL AND reference_kind IS NOT NULL AND reference_applicability IS NOT NULL)
        AND (role = 'event_reference' OR reference_track_key IS NULL)
        AND (reference_applicability IS NULL OR (reference_applicability = 'overall_rule') = (reference_track_key IS NULL))`,
    ),
  ],
);

/** Which extractions a run uses (bound when its graph is written or reused); immutable, so the pair a report was scored from is on record. */
export const assessmentRunExtractions = pgTable(
  'assessment_run_extractions',
  {
    runId: uuid('run_id').notNull(),
    projectId: uuid('project_id').notNull(),
    kind: text('kind', { enum: EXTRACTION_KIND_VALUES }).notNull(),
    extractionId: uuid('extraction_id').notNull(),
    boundAt: timestamptz('bound_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'assessment_run_extractions_pkey', columns: [table.runId, table.kind] }),
    foreignKey({
      name: 'assessment_run_extractions_run_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_run_extractions_extraction_fk',
      columns: [table.extractionId, table.projectId],
      foreignColumns: [graphExtractions.id, graphExtractions.projectId],
    }).onDelete('restrict'),
    check(
      'assessment_run_extractions_kind_valid',
      sql`kind IN (${sqlLiteralList(EXTRACTION_KIND_VALUES)})`,
    ),
  ],
);

// -- The immutable assessment -------------------------------------------------------------------------------------------

/**
 * One successful, immutable `pre_interview` assessment (§8.1): the AI's estimate, never authoritative, never edited. A failed
 * run has NO row here (and a deferred trigger forbids one).
 */
export const preInterviewAssessments = pgTable(
  'pre_interview_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    eventId: uuid('event_id').notNull(),
    runId: uuid('run_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    kind: text('kind').notNull().default('pre_interview'),
    assessmentKey: text('assessment_key').notNull(),
    contextVersionId: uuid('context_version_id').notNull(),
    lockedContentHash: text('locked_content_hash').notNull(),
    pinnedSnapshotIds: uuid('pinned_snapshot_ids').array().notNull(),
    extractionId: uuid('extraction_id').notNull(),
    contextExtractionId: uuid('context_extraction_id').notNull(),
    targetKind: text('target_kind', { enum: SCORING_TARGET_KIND_VALUES }).notNull(),
    trackKey: text('track_key'),
    fallbackAnchorsVersion: text('fallback_anchors_version'),
    engineVersion: text('engine_version').notNull(),
    parametersHash: text('parameters_hash').notNull(),
    rubricFingerprint: text('rubric_fingerprint').notNull(),
    rubricSource: text('rubric_source').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    graphFingerprint: text('graph_fingerprint').notNull(),
    /** The M4 `outputHash` of the report BODY (it excludes itself). Not the hash of `report_canonical`. */
    outputHash: text('output_hash').notNull(),
    /** The authoritative bytes: the complete canonical report, including `outputHash`. */
    reportCanonical: text('report_canonical').notNull(),
    /** An independent SHA-256 of `report_canonical` (storage integrity only). */
    reportTextSha256: text('report_text_sha256').notNull(),
    /** A queryable mirror only; jsonb does not preserve key order or numeric text. */
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    limitations: jsonb('limitations').$type<unknown[]>().notNull(),
    pipelineConfigHash: text('pipeline_config_hash').notNull(),
    providerMode: text('provider_mode', { enum: PROVIDER_MODE_VALUES }).notNull(),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('pre_interview_assessments_run_id_key').on(table.runId),
    unique('pre_interview_assessments_key_key').on(table.assessmentKey),
    unique('pre_interview_assessments_project_version_key').on(
      table.projectId,
      table.versionNumber,
    ),
    unique('pre_interview_assessments_id_project_id_key').on(table.id, table.projectId),
    foreignKey({
      name: 'pre_interview_assessments_run_same_project_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pre_interview_assessments_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pre_interview_assessments_context_same_event_fk',
      columns: [table.contextVersionId, table.eventId],
      foreignColumns: [eventContextVersions.id, eventContextVersions.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pre_interview_assessments_extraction_fk',
      columns: [table.extractionId, table.projectId],
      foreignColumns: [graphExtractions.id, graphExtractions.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pre_interview_assessments_context_extraction_fk',
      columns: [table.contextExtractionId, table.projectId],
      foreignColumns: [graphExtractions.id, graphExtractions.projectId],
    }).onDelete('restrict'),
    index('pre_interview_assessments_project_id_idx').on(table.projectId),
    check('pre_interview_assessments_kind_literal', sql`kind = 'pre_interview'`),
    check('pre_interview_assessments_version_positive', sql`version_number >= 1`),
    check('pre_interview_assessments_key_hex', sql`assessment_key ~ ${HEX64}`),
    check('pre_interview_assessments_locked_hash_hex', sql`locked_content_hash ~ ${HEX64}`),
    check(
      'pre_interview_assessments_hashes_hex',
      sql`parameters_hash ~ ${HEX64} AND rubric_fingerprint ~ ${HEX64} AND input_fingerprint ~ ${HEX64} AND graph_fingerprint ~ ${HEX64} AND output_hash ~ ${HEX64} AND report_text_sha256 ~ ${HEX64} AND pipeline_config_hash ~ ${HEX64}`,
    ),
    check(
      'pre_interview_assessments_target_valid',
      sql`(target_kind = 'track') = (track_key IS NOT NULL)`,
    ),
    check(
      'pre_interview_assessments_distinct_extractions',
      sql`extraction_id <> context_extraction_id`,
    ),
    check(
      'pre_interview_assessments_report_is_object',
      sql`jsonb_typeof(report) = 'object' AND jsonb_typeof(limitations) = 'array'`,
    ),
    check(
      'pre_interview_assessments_report_bound',
      sql`octet_length(report_canonical) BETWEEN 2 AND 4194304`,
    ),
    check(
      'pre_interview_assessments_provider_mode_valid',
      sql`provider_mode IN (${sqlLiteralList(PROVIDER_MODE_VALUES)})`,
    ),
  ],
);

// -- Requests (idempotency) ----------------------------------------------------------------------------------------------

/**
 * One idempotent assessment request (§8.6). Immutable. Exactly one of `run_id` (a run was started) or `assessment_id` (an equal
 * assessment already existed). What became of a run is found through stable relations (`pre_interview_assessments.run_id`,
 * `assessment_run_outcomes.run_id`), never by editing this row.
 */
export const assessmentRequests = pgTable(
  'assessment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    mode: text('mode', { enum: ASSESSMENT_REQUEST_MODE_VALUES }).notNull(),
    runId: uuid('run_id'),
    assessmentId: uuid('assessment_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('assessment_requests_actor_key_key').on(table.actorId, table.idempotencyKey),
    unique('assessment_requests_run_id_key').on(table.runId),
    foreignKey({
      name: 'assessment_requests_assessment_same_project_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_requests_run_same_project_fk',
      columns: [table.runId, table.projectId],
      foreignColumns: [analysisRuns.id, analysisRuns.projectId],
    }).onDelete('restrict'),
    index('assessment_requests_project_id_idx').on(table.projectId),
    check('assessment_requests_key_format', sql`idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'`),
    check('assessment_requests_request_hash_hex', sql`request_hash ~ ${HEX64}`),
    check(
      'assessment_requests_mode_valid',
      sql`mode IN (${sqlLiteralList(ASSESSMENT_REQUEST_MODE_VALUES)})`,
    ),
    check(
      'assessment_requests_exactly_one_outcome',
      sql`(run_id IS NOT NULL) <> (assessment_id IS NOT NULL)`,
    ),
  ],
);

/** One judgment per assessed dimension (the assessor's answer after the deterministic gates), with the review state of Track units. */
export const assessmentDimensionJudgments = pgTable(
  'assessment_dimension_judgments',
  {
    assessmentId: uuid('assessment_id').notNull(),
    projectId: uuid('project_id').notNull(),
    dimensionId: text('dimension_id').notNull(),
    position: integer('position').notNull(),
    outcomeKind: text('outcome_kind').notNull(),
    score: doublePrecision('score'),
    disposition: text('disposition', { enum: UNIT_DISPOSITION_VALUES }).notNull(),
    rationale: text('rationale'),
    limitations: text('limitations')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    assessorAttempts: integer('assessor_attempts').notNull(),
    criticAttempts: integer('critic_attempts').notNull(),
    /** Ledger sequence numbers (assessment_run_calls.seq of the assessment's run); informational, checked by trigger. */
    assessorCallSeqs: integer('assessor_call_seqs')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    criticCallSeqs: integer('critic_call_seqs')
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    /** R3 A4: the P3 gate is structural. A scored Track judgment needs a completed critic review of its citations. */
    semanticRelevance: text('semantic_relevance').notNull().default('not_verified'),
    criticReviewRequired: boolean('critic_review_required').notNull(),
    criticReviewed: boolean('critic_reviewed').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'assessment_dimension_judgments_pkey',
      columns: [table.assessmentId, table.dimensionId],
    }),
    unique('assessment_dimension_judgments_position_key').on(table.assessmentId, table.position),
    foreignKey({
      name: 'assessment_dimension_judgments_assessment_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    check(
      'assessment_dimension_judgments_dimension_format',
      sql`dimension_id ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`,
    ),
    check(
      'assessment_dimension_judgments_outcome_valid',
      sql`outcome_kind IN ('scored', 'insufficient_evidence') AND ((outcome_kind = 'scored') = (score IS NOT NULL))`,
    ),
    check(
      'assessment_dimension_judgments_disposition_matches_outcome',
      sql`(disposition = 'scored') = (outcome_kind = 'scored')`,
    ),
    check(
      'assessment_dimension_judgments_counts_valid',
      sql`assessor_attempts >= 0 AND critic_attempts >= 0 AND position >= 0`,
    ),
    check(
      'assessment_dimension_judgments_semantic_literal',
      sql`semantic_relevance = 'not_verified'`,
    ),
    check(
      'assessment_dimension_judgments_track_review_required',
      sql`NOT (dimension_id LIKE 'track\\_prize\\_alignment.%' AND outcome_kind = 'scored') OR critic_review_required`,
    ),
    check(
      'assessment_dimension_judgments_review_completed',
      sql`(NOT critic_review_required OR critic_reviewed) AND (NOT critic_reviewed OR cardinality(critic_call_seqs) > 0)`,
    ),
    check(
      'assessment_dimension_judgments_disposition_valid',
      sql`disposition IN (${sqlLiteralList(UNIT_DISPOSITION_VALUES)})`,
    ),
  ],
);

/** The evidence a judgment cited, with the code-authored reference metadata that makes the semantic-relevance review auditable. */
export const assessmentJudgmentCitations = pgTable(
  'assessment_judgment_citations',
  {
    assessmentId: uuid('assessment_id').notNull(),
    projectId: uuid('project_id').notNull(),
    dimensionId: text('dimension_id').notNull(),
    position: integer('position').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    directness: text('directness').notNull(),
    specificity: text('specificity').notNull(),
    note: text('note'),
    referenceApplicability: text('reference_applicability', {
      enum: REFERENCE_APPLICABILITY_VALUES,
    }),
    referenceTrackKey: text('reference_track_key'),
  },
  (table) => [
    primaryKey({
      name: 'assessment_judgment_citations_pkey',
      columns: [table.assessmentId, table.dimensionId, table.position],
    }),
    unique('assessment_judgment_citations_evidence_key').on(
      table.assessmentId,
      table.dimensionId,
      table.evidenceId,
    ),
    foreignKey({
      name: 'assessment_judgment_citations_judgment_fk',
      columns: [table.assessmentId, table.dimensionId],
      foreignColumns: [
        assessmentDimensionJudgments.assessmentId,
        assessmentDimensionJudgments.dimensionId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_judgment_citations_assessment_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'assessment_judgment_citations_evidence_same_project_fk',
      columns: [table.evidenceId, table.projectId],
      foreignColumns: [evidenceItems.id, evidenceItems.projectId],
    }).onDelete('restrict'),
    check('assessment_judgment_citations_position_valid', sql`position >= 0`),
    check(
      'assessment_judgment_citations_reference_shape',
      sql`(reference_applicability IS NULL AND reference_track_key IS NULL)
        OR (reference_applicability = 'overall_rule' AND reference_track_key IS NULL)
        OR (reference_applicability IN ('declared_track_definition', 'track_specific_requirement') AND reference_track_key IS NOT NULL)`,
    ),
    check(
      'assessment_judgment_citations_event_reference_classification',
      sql`reference_applicability IS NULL OR (directness = 'indirect' AND specificity = 'generic')`,
    ),
  ],
);

export const ASSESSMENT_TABLE_NAMES = [
  'assessment_dimension_judgments',
  'assessment_judgment_citations',
  'assessment_requests',
  'assessment_run_budget',
  'assessment_run_calls',
  'assessment_run_extractions',
  'assessment_run_input_snapshots',
  'assessment_run_inputs',
  'assessment_run_outcomes',
  'graph_extraction_items',
  'graph_extractions',
  'pre_interview_assessments',
] as const;
