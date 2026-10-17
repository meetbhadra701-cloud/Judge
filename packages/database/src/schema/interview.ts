import {
  INTERVIEW_FORBIDDEN_TEXT_SQL,
  INTERVIEW_LIMITS,
  OBSERVATION_OUTCOME_VALUES,
  RECORDER_ROLE_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { preInterviewAssessments } from './assessment.js';
import { projects } from './projects.js';
import { questionSetQuestions, questionSets } from './questions.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

/*
 * M7: the records of an interview, persisted as immutable history (migration 0025 adds the append-only, no-truncate, stamping and not-voided triggers).
 *
 *   team_answers        "the judge recorded that the team said this": testimony about ONE suggested question, never a verified fact.
 *   judge_observations  "the authenticated judge reports observing this": a separate record of a live demonstration or verification attempt. Optionally linked
 *                       to the question (and to the team answer) being discussed; it may also stand alone for the assessment.
 *
 * Neither table is evidence in the M3 graph: the `team_answer` / `judge_observation` evidence origins stay refused there until a later milestone approves a
 * trusted path from these rows (docs/milestones/M7_INTERVIEW_MODE_REPORT.md, "M8 handoff").
 *
 * Integrity is structural. Every link is a COMPOSITE foreign key that carries the project (and the assessment, set and question the row names), so a record
 * cannot point at the object of another project, at a set of another assessment, or at a question of another set, whatever the application did.
 * A correction is a new row that names the row it supersedes (same project, assessment and question); one row can be superseded at most once, so a chain is
 * linear and two concurrent corrections of the same record cannot both succeed.
 */

const HEX64 = sqlPattern('^[0-9a-f]{64}$');
const FORBIDDEN = sqlPattern(INTERVIEW_FORBIDDEN_TEXT_SQL);
// the bounds are inlined as literals so the generated DDL is a plain constant expression
const ANSWER_MAX = sql.raw(String(INTERVIEW_LIMITS.answerMaxChars));
const SUBJECT_MAX = sql.raw(String(INTERVIEW_LIMITS.subjectMaxChars));
const OBSERVED_MAX = sql.raw(String(INTERVIEW_LIMITS.observedMaxChars));

export const teamAnswers = pgTable(
  'team_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    assessmentId: uuid('assessment_id').notNull(),
    questionSetId: uuid('question_set_id').notNull(),
    questionId: uuid('question_id').notNull(),
    /** The answer as the judge typed it (trimmed). Testimony: never a verified fact. */
    answerText: text('answer_text').notNull(),
    recordedByActorId: uuid('recorded_by_actor_id').notNull(),
    /** The role the recording credential held (checked against the vocabulary). */
    recordedAsRole: text('recorded_as_role', { enum: RECORDER_ROLE_VALUES }).notNull(),
    /** One logical request: the same actor and key return the stored record, and different content under a used key is refused. */
    idempotencyKey: uuid('idempotency_key').notNull(),
    /** SHA-256 of the canonical request (what makes a replay a replay and not a different request). */
    requestHash: text('request_hash').notNull(),
    /** The record this one corrects (same project, assessment, set and question), or null for an original. */
    supersedesAnswerId: uuid('supersedes_answer_id'),
    /** Assigned by the database (trigger), never by the application or the client. */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('team_answers_actor_key_key').on(table.recordedByActorId, table.idempotencyKey),
    /** The target of every link that must agree on project, assessment, set AND question (a correction; an observation that names an answer). */
    unique('team_answers_identity_key').on(
      table.id,
      table.projectId,
      table.assessmentId,
      table.questionSetId,
      table.questionId,
    ),
    /** A record is superseded at most once: a chain is linear, and a second correction of the same record is refused. */
    unique('team_answers_one_correction_key').on(table.supersedesAnswerId),
    foreignKey({
      name: 'team_answers_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'team_answers_assessment_same_project_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'team_answers_set_same_assessment_fk',
      columns: [table.questionSetId, table.projectId, table.assessmentId],
      foreignColumns: [questionSets.id, questionSets.projectId, questionSets.assessmentId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'team_answers_question_in_set_fk',
      columns: [table.questionId, table.questionSetId],
      foreignColumns: [questionSetQuestions.id, questionSetQuestions.setId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'team_answers_actor_fk',
      columns: [table.recordedByActorId],
      foreignColumns: [actors.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'team_answers_supersedes_same_question_fk',
      columns: [
        table.supersedesAnswerId,
        table.projectId,
        table.assessmentId,
        table.questionSetId,
        table.questionId,
      ],
      foreignColumns: [
        table.id,
        table.projectId,
        table.assessmentId,
        table.questionSetId,
        table.questionId,
      ],
    }).onDelete('restrict'),
    index('team_answers_assessment_idx').on(table.assessmentId, table.createdAt),
    index('team_answers_question_idx').on(table.questionId, table.createdAt),
    check(
      'team_answers_text_valid',
      sql`char_length(answer_text) BETWEEN 1 AND ${ANSWER_MAX} AND btrim(answer_text) <> '' AND answer_text !~ ${FORBIDDEN}`,
    ),
    check(
      'team_answers_role_valid',
      sql`recorded_as_role IN (${sqlLiteralList(RECORDER_ROLE_VALUES)})`,
    ),
    check('team_answers_hash_hex', sql`request_hash ~ ${HEX64}`),
    check('team_answers_not_self_correcting', sql`supersedes_answer_id IS DISTINCT FROM id`),
  ],
);

export const judgeObservations = pgTable(
  'judge_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    assessmentId: uuid('assessment_id').notNull(),
    /** Both null (an observation about the assessment as a whole) or both set (about one suggested question). */
    questionSetId: uuid('question_set_id'),
    questionId: uuid('question_id'),
    /** The team answer being discussed, when the judge links one. It must answer the same question. */
    teamAnswerId: uuid('team_answer_id'),
    /** What was demonstrated or examined. */
    subject: text('subject').notNull(),
    /** What the judge directly observed: the judge's own report, never proof. */
    observed: text('observed').notNull(),
    /** A description of the attempt (`confirmed`, `not_confirmed`, `inconclusive`, `unable_to_verify`): never a finding against the project. */
    outcome: text('outcome', { enum: OBSERVATION_OUTCOME_VALUES }).notNull(),
    recordedByActorId: uuid('recorded_by_actor_id').notNull(),
    recordedAsRole: text('recorded_as_role', { enum: RECORDER_ROLE_VALUES }).notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    supersedesObservationId: uuid('supersedes_observation_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('judge_observations_actor_key_key').on(table.recordedByActorId, table.idempotencyKey),
    unique('judge_observations_identity_key').on(table.id, table.projectId, table.assessmentId),
    unique('judge_observations_one_correction_key').on(table.supersedesObservationId),
    foreignKey({
      name: 'judge_observations_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_assessment_same_project_fk',
      columns: [table.assessmentId, table.projectId],
      foreignColumns: [preInterviewAssessments.id, preInterviewAssessments.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_set_same_assessment_fk',
      columns: [table.questionSetId, table.projectId, table.assessmentId],
      foreignColumns: [questionSets.id, questionSets.projectId, questionSets.assessmentId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_question_in_set_fk',
      columns: [table.questionId, table.questionSetId],
      foreignColumns: [questionSetQuestions.id, questionSetQuestions.setId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_team_answer_same_question_fk',
      columns: [
        table.teamAnswerId,
        table.projectId,
        table.assessmentId,
        table.questionSetId,
        table.questionId,
      ],
      foreignColumns: [
        teamAnswers.id,
        teamAnswers.projectId,
        teamAnswers.assessmentId,
        teamAnswers.questionSetId,
        teamAnswers.questionId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_actor_fk',
      columns: [table.recordedByActorId],
      foreignColumns: [actors.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'judge_observations_supersedes_same_assessment_fk',
      columns: [table.supersedesObservationId, table.projectId, table.assessmentId],
      foreignColumns: [table.id, table.projectId, table.assessmentId],
    }).onDelete('restrict'),
    index('judge_observations_assessment_idx').on(table.assessmentId, table.createdAt),
    index('judge_observations_question_idx').on(table.questionId, table.createdAt),
    check(
      'judge_observations_link_shape',
      sql`(question_set_id IS NULL) = (question_id IS NULL) AND (team_answer_id IS NULL OR question_id IS NOT NULL)`,
    ),
    check(
      'judge_observations_text_valid',
      sql`char_length(subject) BETWEEN 1 AND ${SUBJECT_MAX} AND btrim(subject) <> '' AND subject !~ ${FORBIDDEN} AND char_length(observed) BETWEEN 1 AND ${OBSERVED_MAX} AND btrim(observed) <> '' AND observed !~ ${FORBIDDEN}`,
    ),
    check(
      'judge_observations_outcome_valid',
      sql`outcome IN (${sqlLiteralList(OBSERVATION_OUTCOME_VALUES)})`,
    ),
    check(
      'judge_observations_role_valid',
      sql`recorded_as_role IN (${sqlLiteralList(RECORDER_ROLE_VALUES)})`,
    ),
    check('judge_observations_hash_hex', sql`request_hash ~ ${HEX64}`),
    check(
      'judge_observations_not_self_correcting',
      sql`supersedes_observation_id IS DISTINCT FROM id`,
    ),
  ],
);
