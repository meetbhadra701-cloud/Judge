import {
  PROVIDER_MODE_VALUES,
  QUESTION_MODE_VALUES,
  QUESTION_SET_SIZE,
  QUESTION_SHORTFALL_VALUES,
  UNCERTAINTY_KIND_VALUES,
  UNCERTAINTY_SEVERITY_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { preInterviewAssessments } from './assessment.js';
import { projects } from './projects.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

/*
 * M6: immutable question sets. A set is one deterministic run of the question engine over ONE verified pre-interview assessment: the uncertainty
 * opportunities it found, the five (or fewer) questions it selected and why, and the identities of everything that produced them (assessment report
 * hash, locked context version, engine policy, prompt, provider). Rows are append-only (migration 0023 adds the triggers: immutability, completeness
 * and ownership). A later capture, a context revision or a new assessment never changes a stored set; they create a different one.
 *
 * `generation_key` is the idempotency key: the hash of every identity the set depends on. A second request for the same key finds the first set.
 */

const HEX64 = sqlPattern('^[0-9a-f]{64}$');
const OPP_KEY = sqlPattern('^opp-[0-9a-f]{16}$');
const CAND_KEY = sqlPattern('^cand-[0-9a-f]{16}$');
const VERSION = sqlPattern('^[a-z0-9-]+/v[0-9]+$');

export const questionSets = pgTable(
  'question_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    assessmentId: uuid('assessment_id').notNull(),
    /** Copied from the verified assessment; migration 0023 checks that they equal the assessment row. */
    contextVersionId: uuid('context_version_id').notNull(),
    extractionId: uuid('extraction_id').notNull(),
    reportOutputHash: text('report_output_hash').notNull(),
    policyVersion: text('policy_version').notNull(),
    uncertaintyEngineVersion: text('uncertainty_engine_version').notNull(),
    /** `official`, or `equal_for_ranking_only` when the rubric publishes no weights (the equal share only orders opportunities). */
    weightBasis: text('weight_basis').notNull(),
    generationKey: text('generation_key').notNull(),
    /** SHA-256 of the canonical uncertainty input the set was derived from. */
    inputHash: text('input_hash').notNull(),
    providerMode: text('provider_mode', { enum: PROVIDER_MODE_VALUES }).notNull(),
    providerId: text('provider_id').notNull(),
    /** True for a replay or scripted provider: the questions were NOT phrased by a model. */
    demonstration: boolean('demonstration').notNull(),
    model: text('model').notNull(),
    promptId: text('prompt_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    outputSchemaHash: text('output_schema_hash').notNull(),
    /** Digest of the exact request sent to the provider; null when no candidate generation was needed (no uncertainty). */
    requestDigest: text('request_digest'),
    /** Hash of the canonical candidate output the provider returned (before validation); null when none was requested. */
    candidateOutputHash: text('candidate_output_hash'),
    opportunityCount: integer('opportunity_count').notNull(),
    candidateCount: integer('candidate_count').notNull(),
    rejectedCount: integer('rejected_count').notNull(),
    selectedCount: integer('selected_count').notNull(),
    shortfallCode: text('shortfall_code', { enum: QUESTION_SHORTFALL_VALUES }),
    shortfallExplanation: text('shortfall_explanation'),
    /**
     * question-engine/v2 (M6-R1): valid candidates left out as repeats / as below the minimum value. NULL for a v1 set, which did not record the split (never
     * back-filled: an immutable set is not reinterpreted).
     */
    excludedRedundant: integer('excluded_redundant'),
    excludedBelowMinimum: integer('excluded_below_minimum'),
    /** [{ code, count }] by stable code; a refused candidate's text is never stored. */
    rejections: jsonb('rejections').$type<{ code: string; count: number }[]>().notNull(),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('question_sets_generation_key_key').on(table.generationKey),
    unique('question_sets_id_project_id_key').on(table.id, table.projectId),
    foreignKey({
      name: 'question_sets_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'question_sets_assessment_same_project_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    index('question_sets_assessment_idx').on(table.assessmentId, table.createdAt),
    index('question_sets_project_idx').on(table.projectId, table.createdAt),
    check(
      'question_sets_hashes_hex',
      sql`report_output_hash ~ ${HEX64} AND generation_key ~ ${HEX64} AND input_hash ~ ${HEX64} AND prompt_template_hash ~ ${HEX64} AND output_schema_hash ~ ${HEX64} AND (request_digest IS NULL OR request_digest ~ ${HEX64}) AND (candidate_output_hash IS NULL OR candidate_output_hash ~ ${HEX64})`,
    ),
    check(
      'question_sets_versions_valid',
      sql`policy_version ~ ${VERSION} AND uncertainty_engine_version ~ ${VERSION}`,
    ),
    check(
      'question_sets_provider_mode_valid',
      sql`provider_mode IN (${sqlLiteralList(PROVIDER_MODE_VALUES)})`,
    ),
    check(
      'question_sets_demonstration_matches_mode',
      sql`demonstration = (provider_mode <> 'live')`,
    ),
    check(
      'question_sets_request_pair',
      sql`(request_digest IS NULL) = (candidate_output_hash IS NULL)`,
    ),
    check(
      'question_sets_counts_valid',
      sql.raw(
        `opportunity_count >= 0 AND candidate_count >= 0 AND rejected_count >= 0 AND selected_count >= 0 AND selected_count <= ${String(QUESTION_SET_SIZE)} AND selected_count <= candidate_count AND (opportunity_count > 0 OR selected_count = 0)`,
      ),
    ),
    check(
      'question_sets_shortfall_shape',
      sql.raw(
        `(selected_count = ${String(QUESTION_SET_SIZE)}) = (shortfall_code IS NULL) AND (shortfall_code IS NULL) = (shortfall_explanation IS NULL) AND (shortfall_code IS NULL OR shortfall_code IN (${QUESTION_SHORTFALL_VALUES.map((v) => `'${v}'`).join(', ')}))`,
      ),
    ),
    check(
      'question_sets_excluded_shape',
      sql`(excluded_redundant IS NULL) = (excluded_below_minimum IS NULL) AND (excluded_redundant IS NULL OR (excluded_redundant >= 0 AND excluded_below_minimum >= 0 AND excluded_redundant + excluded_below_minimum + selected_count <= candidate_count))`,
    ),
    check(
      'question_sets_text_bounded',
      sql`shortfall_explanation IS NULL OR char_length(shortfall_explanation) BETWEEN 1 AND 2000`,
    ),
  ],
);

export const questionSetOpportunities = pgTable(
  'question_set_opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => questionSets.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    /** `opp-` + 16 hex: reproducible from the kind and the subject ids. */
    opportunityKey: text('opportunity_key').notNull(),
    kind: text('kind', { enum: UNCERTAINTY_KIND_VALUES }).notNull(),
    severity: text('severity', { enum: UNCERTAINTY_SEVERITY_VALUES }).notNull(),
    dimensionIds: jsonb('dimension_ids').$type<string[]>().notNull(),
    relevanceMilli: integer('relevance_milli').notNull(),
    observation: text('observation').notNull(),
    clarifiedBy: jsonb('clarified_by').$type<string[]>().notNull(),
    /** [{ type, id, role }] of stored ids: the reproducible evidence trail. */
    trail: jsonb('trail').$type<{ type: string; id: string; role: string }[]>().notNull(),
    /** [{ type, id, label, verificationLevel? }]: what the trail points at, snapshotted so the set reads without re-deriving anything. */
    referenceViews: jsonb('reference_views').$type<Record<string, unknown>[]>().notNull(),
  },
  (table) => [
    unique('question_set_opportunities_ordinal_key').on(table.setId, table.ordinal),
    unique('question_set_opportunities_key_key').on(table.setId, table.opportunityKey),
    check('question_set_opportunities_key_valid', sql`opportunity_key ~ ${OPP_KEY}`),
    check('question_set_opportunities_ordinal_positive', sql`ordinal >= 1`),
    check(
      'question_set_opportunities_kind_valid',
      sql`kind IN (${sqlLiteralList(UNCERTAINTY_KIND_VALUES)})`,
    ),
    check(
      'question_set_opportunities_severity_valid',
      sql`severity IN (${sqlLiteralList(UNCERTAINTY_SEVERITY_VALUES)})`,
    ),
    check('question_set_opportunities_relevance_range', sql`relevance_milli BETWEEN 0 AND 1000`),
    check(
      'question_set_opportunities_observation_bounded',
      sql`char_length(observation) BETWEEN 1 AND 2000`,
    ),
    check(
      'question_set_opportunities_json_shapes',
      sql`jsonb_typeof(dimension_ids) = 'array' AND jsonb_typeof(clarified_by) = 'array' AND jsonb_typeof(trail) = 'array' AND jsonb_array_length(trail) <= 64 AND jsonb_typeof(reference_views) = 'array' AND jsonb_array_length(reference_views) <= 64`,
    ),
  ],
);

export const questionSetQuestions = pgTable(
  'question_set_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    setId: uuid('set_id')
      .notNull()
      .references(() => questionSets.id, { onDelete: 'restrict' }),
    rank: integer('rank').notNull(),
    candidateKey: text('candidate_key').notNull(),
    mode: text('mode', { enum: QUESTION_MODE_VALUES }).notNull(),
    text: text('text').notNull(),
    reason: text('reason').notNull(),
    expectedInformation: jsonb('expected_information').$type<string[]>().notNull(),
    /** [{ id, name, weightShareMilli }] of the rubric dimensions the question bears on. */
    dimensions: jsonb('dimensions')
      .$type<{ id: string; name: string; weightShareMilli: number }[]>()
      .notNull(),
    /** `opp-...` keys of this set's opportunities that the question addresses. */
    opportunityKeys: jsonb('opportunity_keys').$type<string[]>().notNull(),
    /** [{ type, id, label, verificationLevel? }] stored records the question draws on (claims, unknowns, evidence, contradictions, requirements, tracks). */
    referenceViews: jsonb('reference_views').$type<Record<string, unknown>[]>().notNull(),
    /** A deterministic ordering number of this policy, NOT a probability. */
    rankingValueBp: integer('ranking_value_bp').notNull(),
    marginalBp: integer('marginal_bp').notNull(),
    noveltyMilli: integer('novelty_milli').notNull(),
    factors: jsonb('factors').$type<Record<string, number>>().notNull(),
  },
  (table) => [
    unique('question_set_questions_rank_key').on(table.setId, table.rank),
    unique('question_set_questions_candidate_key').on(table.setId, table.candidateKey),
    check(
      'question_set_questions_rank_range',
      sql.raw(`rank BETWEEN 1 AND ${String(QUESTION_SET_SIZE)}`),
    ),
    check('question_set_questions_candidate_key_valid', sql`candidate_key ~ ${CAND_KEY}`),
    check(
      'question_set_questions_mode_valid',
      sql`mode IN (${sqlLiteralList(QUESTION_MODE_VALUES)})`,
    ),
    check(
      'question_set_questions_text_bounded',
      sql`char_length(text) BETWEEN 1 AND 400 AND char_length(reason) BETWEEN 1 AND 600`,
    ),
    check(
      'question_set_questions_numbers_valid',
      sql`ranking_value_bp BETWEEN 0 AND 10000 AND marginal_bp BETWEEN 0 AND 10000 AND novelty_milli BETWEEN 0 AND 1000`,
    ),
    check(
      'question_set_questions_json_shapes',
      sql`jsonb_typeof(expected_information) = 'array' AND jsonb_typeof(dimensions) = 'array' AND jsonb_typeof(opportunity_keys) = 'array' AND jsonb_array_length(opportunity_keys) >= 1 AND jsonb_typeof(reference_views) = 'array' AND jsonb_typeof(factors) = 'object'`,
    ),
  ],
);

/**
 * M6-R1 (R9A P2-1): the durable CLAIM of one generation identity. Exactly one request at a time holds a running claim for a `generation_key`; every other request
 * (in this process or another sharing the database) waits for the set or gets a typed in-progress or failed answer. The claim is a lease on the DATABASE clock
 * (`lease_expires_at`), renewed by a heartbeat while the holder lives; `claim_token` fences the holder: a publish succeeds only for the current token, so a holder
 * whose claim was taken over cannot publish. Unlike the sets, claims are working state: they change and are deleted when the set is published.
 *
 * No ordinary transaction is held across a provider call: claim, renew, fail and publish are each one short statement or transaction.
 */
export const questionGenerationClaims = pgTable(
  'question_generation_claims',
  {
    generationKey: text('generation_key').primaryKey(),
    projectId: uuid('project_id').notNull(),
    assessmentId: uuid('assessment_id').notNull(),
    claimToken: uuid('claim_token').notNull(),
    /** Which process holds it (diagnostic only; authority is the token). */
    holder: text('holder').notNull(),
    state: text('state', { enum: ['running', 'failed'] }).notNull(),
    attempt: integer('attempt').notNull(),
    leaseExpiresAt: timestamptz('lease_expires_at').notNull(),
    failureCategory: text('failure_category'),
    failedAt: timestamptz('failed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'question_generation_claims_assessment_same_project_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    index('question_generation_claims_assessment_idx').on(table.assessmentId),
    check('question_generation_claims_key_hex', sql`generation_key ~ ${HEX64}`),
    check('question_generation_claims_attempt_positive', sql`attempt >= 1`),
    check('question_generation_claims_holder_bounded', sql`char_length(holder) BETWEEN 1 AND 200`),
    check(
      'question_generation_claims_state_shape',
      sql`(state = 'running' AND failed_at IS NULL AND failure_category IS NULL) OR (state = 'failed' AND failed_at IS NOT NULL AND failure_category IS NOT NULL AND char_length(failure_category) BETWEEN 1 AND 100)`,
    ),
  ],
);
