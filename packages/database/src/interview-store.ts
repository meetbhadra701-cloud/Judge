import { createAuditEvent } from '@judge-copilot/audit';
import type {
  InterviewRecordsResponse,
  JudgeObservationView,
  ObservationOutcome,
  RecorderRole,
  TeamAnswerView,
} from '@judge-copilot/schemas';
import { and, asc, eq } from 'drizzle-orm';
import type { JudgeDatabase } from './client.js';
import {
  actors,
  auditEvents,
  judgeObservations,
  preInterviewAssessments,
  projectVoids,
  questionSetQuestions,
  questionSets,
  teamAnswers,
} from './schema/index.js';

/*
 * Persistence and reading of the records of an interview (M7).
 *
 *   append-only      a record is never updated or deleted (triggers, migration 0025). A correction is a new row that names the one it supersedes.
 *   structural       every link is a composite foreign key (project, assessment, set, question): the database refuses a record that points across projects,
 *                    assessments or sets, whatever this class did. This class checks the same things first so a refusal is precise and leaks nothing about
 *                    another project's objects (an object of another project is reported exactly like a nonexistent one).
 *   idempotent       one actor and one Idempotency-Key are one logical request. A replay returns the stored record; the same key with other content is refused;
 *                    two simultaneous identical requests create exactly one row (the unique index serialises them, the second finds the first).
 *   audited          the audit event (identifiers and the action only, never the text) is written in the SAME transaction as the record.
 *   void-safe        a voided project refuses a new record: checked up front, and again by the database (the shared not-voided guard takes FOR SHARE on the
 *                    project row, which conflicts with the FOR UPDATE a void takes), so a record racing a void is either completed first or refused.
 *   server-assigned  the id and the timestamp are the database's; the actor and the role come from the authenticated caller, never from a request body.
 */

export type InterviewTargetKind =
  | 'assessment'
  | 'question_set'
  | 'question'
  | 'team_answer'
  | 'team_answer_to_correct'
  | 'observation_to_correct';

/** The record or target does not exist in this project (an object of another project is reported exactly like this). */
export class InterviewTargetNotFoundError extends Error {
  constructor(readonly target: InterviewTargetKind) {
    super(`interview target not found: ${target}`);
    this.name = 'InterviewTargetNotFoundError';
  }
}

/** The named objects exist but do not belong together (a question outside its set, a set of another assessment, an answer to another question). */
export class InterviewTargetMismatchError extends Error {
  constructor(readonly relation: string) {
    super(`interview records do not belong together: ${relation}`);
    this.name = 'InterviewTargetMismatchError';
  }
}

/** The same Idempotency-Key was already used by this actor for a different request. */
export class InterviewKeyReusedError extends Error {
  constructor() {
    super('idempotency key reused for a different request');
    this.name = 'InterviewKeyReusedError';
  }
}

/** The record to correct has already been corrected (a chain is linear: only its newest record can be corrected). */
export class InterviewAlreadyCorrectedError extends Error {
  constructor(readonly supersededById: string | null) {
    super('the record was already corrected');
    this.name = 'InterviewAlreadyCorrectedError';
  }
}

/** The project was voided: its interview history stays readable and it takes no new record. */
export class InterviewProjectVoidedError extends Error {
  constructor() {
    super('the project was voided');
    this.name = 'InterviewProjectVoidedError';
  }
}

interface PgFacts {
  readonly code?: string;
  readonly constraint?: string;
  readonly message: string;
}

/** The PostgreSQL error facts found anywhere in an error's cause chain (drizzle wraps the driver's error). */
function pgFactsOf(error: unknown): PgFacts[] {
  const facts: PgFacts[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 6; depth += 1) {
    // PGlite and node-postgres name the violated constraint `constraint`; postgres.js names it `constraint_name`
    const e = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const constraint = typeof e.constraint === 'string' ? e.constraint : e.constraint_name;
    facts.push({
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof constraint === 'string' ? { constraint } : {}),
      message: typeof e.message === 'string' ? e.message : '',
    });
    current = e.cause;
  }
  return facts;
}

export function isInterviewVoidRefusal(error: unknown): boolean {
  return pgFactsOf(error).some(
    (f) =>
      f.constraint === 'project_not_voided' || f.message.includes('this project has been voided'),
  );
}

const ONE_CORRECTION_CONSTRAINTS = new Set([
  'team_answers_one_correction_key',
  'judge_observations_one_correction_key',
]);

export interface RecordingActor {
  readonly actorId: string;
  readonly role: RecorderRole;
}

export interface RecordTeamAnswerInput extends RecordingActor {
  readonly projectId: string;
  readonly setId: string;
  readonly questionId: string;
  readonly text: string;
  readonly supersedesAnswerId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface RecordJudgeObservationInput extends RecordingActor {
  readonly projectId: string;
  readonly assessmentId: string;
  readonly questionSetId: string | null;
  readonly questionId: string | null;
  readonly teamAnswerId: string | null;
  readonly subject: string;
  readonly observed: string;
  readonly outcome: ObservationOutcome;
  readonly supersedesObservationId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type RecordResult =
  | { readonly kind: 'created'; readonly id: string }
  | { readonly kind: 'replayed'; readonly id: string };

type Tx = Parameters<Parameters<JudgeDatabase['transaction']>[0]>[0];

export class InterviewStore {
  constructor(private readonly db: JudgeDatabase) {}

  /** Whether the project has been voided (a voided project keeps its history and takes no new record). */
  async projectVoided(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: projectVoids.projectId })
      .from(projectVoids)
      .where(eq(projectVoids.projectId, projectId));
    return row !== undefined;
  }

  /** Whether the assessment exists in the project (an assessment of another project is reported as nonexistent). */
  async assessmentExists(projectId: string, assessmentId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: preInterviewAssessments.id })
      .from(preInterviewAssessments)
      .where(
        and(
          eq(preInterviewAssessments.id, assessmentId),
          eq(preInterviewAssessments.projectId, projectId),
        ),
      );
    return row !== undefined;
  }

  // -- writing -------------------------------------------------------------------------------------------------------------------

  async recordTeamAnswer(input: RecordTeamAnswerInput): Promise<RecordResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const replay = await this.earlierAnswer(tx, input);
        if (replay) return replay;
        await this.requireNotVoided(tx, input.projectId);

        // the question must be one of THIS project's sets; the assessment is DERIVED from the set, never taken from the request
        const [target] = await tx
          .select({ assessmentId: questionSets.assessmentId })
          .from(questionSetQuestions)
          .innerJoin(questionSets, eq(questionSets.id, questionSetQuestions.setId))
          .where(
            and(
              eq(questionSetQuestions.id, input.questionId),
              eq(questionSetQuestions.setId, input.setId),
              eq(questionSets.projectId, input.projectId),
            ),
          );
        if (!target) throw new InterviewTargetNotFoundError('question');

        if (input.supersedesAnswerId !== null) {
          const [previous] = await tx
            .select({
              id: teamAnswers.id,
              questionId: teamAnswers.questionId,
              questionSetId: teamAnswers.questionSetId,
            })
            .from(teamAnswers)
            .where(
              and(
                eq(teamAnswers.id, input.supersedesAnswerId),
                eq(teamAnswers.projectId, input.projectId),
              ),
            );
          if (!previous) throw new InterviewTargetNotFoundError('team_answer_to_correct');
          if (previous.questionId !== input.questionId || previous.questionSetId !== input.setId) {
            throw new InterviewTargetMismatchError(
              'the record to correct answers a different question',
            );
          }
          const [next] = await tx
            .select({ id: teamAnswers.id })
            .from(teamAnswers)
            .where(eq(teamAnswers.supersedesAnswerId, input.supersedesAnswerId));
          if (next) throw new InterviewAlreadyCorrectedError(next.id);
        }

        const [inserted] = await tx
          .insert(teamAnswers)
          .values({
            projectId: input.projectId,
            assessmentId: target.assessmentId,
            questionSetId: input.setId,
            questionId: input.questionId,
            answerText: input.text,
            recordedByActorId: input.actorId,
            recordedAsRole: input.role,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            supersedesAnswerId: input.supersedesAnswerId,
          })
          .onConflictDoNothing({
            target: [teamAnswers.recordedByActorId, teamAnswers.idempotencyKey],
          })
          .returning({ id: teamAnswers.id });
        if (!inserted) {
          // a simultaneous request with the same key won: it is the same logical request (or a reused key)
          const raced = await this.earlierAnswer(tx, input);
          if (raced) return raced;
          throw new Error('interview answer insert produced no row and no earlier record');
        }
        await this.audit(tx, {
          actorId: input.actorId,
          entityType: 'team_answer',
          entityId: inserted.id,
          action:
            input.supersedesAnswerId === null
              ? 'interview.team_answer_recorded'
              : 'interview.team_answer_corrected',
          metadata: {
            projectId: input.projectId,
            assessmentId: target.assessmentId,
            questionSetId: input.setId,
            questionId: input.questionId,
            role: input.role,
            ...(input.supersedesAnswerId === null
              ? {}
              : { supersedesAnswerId: input.supersedesAnswerId }),
          },
        });
        return { kind: 'created', id: inserted.id } as const;
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async recordJudgeObservation(input: RecordJudgeObservationInput): Promise<RecordResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const replay = await this.earlierObservation(tx, input);
        if (replay) return replay;
        await this.requireNotVoided(tx, input.projectId);

        const [assessment] = await tx
          .select({ id: preInterviewAssessments.id })
          .from(preInterviewAssessments)
          .where(
            and(
              eq(preInterviewAssessments.id, input.assessmentId),
              eq(preInterviewAssessments.projectId, input.projectId),
            ),
          );
        if (!assessment) throw new InterviewTargetNotFoundError('assessment');

        if (input.questionSetId !== null && input.questionId !== null) {
          const [set] = await tx
            .select({ assessmentId: questionSets.assessmentId })
            .from(questionSets)
            .where(
              and(
                eq(questionSets.id, input.questionSetId),
                eq(questionSets.projectId, input.projectId),
              ),
            );
          if (!set) throw new InterviewTargetNotFoundError('question_set');
          if (set.assessmentId !== input.assessmentId) {
            throw new InterviewTargetMismatchError(
              'the question set belongs to a different assessment',
            );
          }
          const [question] = await tx
            .select({ setId: questionSetQuestions.setId })
            .from(questionSetQuestions)
            .innerJoin(questionSets, eq(questionSets.id, questionSetQuestions.setId))
            .where(
              and(
                eq(questionSetQuestions.id, input.questionId),
                eq(questionSets.projectId, input.projectId),
              ),
            );
          if (!question) throw new InterviewTargetNotFoundError('question');
          if (question.setId !== input.questionSetId) {
            throw new InterviewTargetMismatchError(
              'the question is not part of the named question set',
            );
          }
        }

        if (input.teamAnswerId !== null) {
          const [answer] = await tx
            .select({
              assessmentId: teamAnswers.assessmentId,
              questionId: teamAnswers.questionId,
              questionSetId: teamAnswers.questionSetId,
            })
            .from(teamAnswers)
            .where(
              and(
                eq(teamAnswers.id, input.teamAnswerId),
                eq(teamAnswers.projectId, input.projectId),
              ),
            );
          if (!answer) throw new InterviewTargetNotFoundError('team_answer');
          if (
            answer.assessmentId !== input.assessmentId ||
            answer.questionId !== input.questionId ||
            answer.questionSetId !== input.questionSetId
          ) {
            throw new InterviewTargetMismatchError(
              'the linked team answer is not an answer to the named question',
            );
          }
        }

        if (input.supersedesObservationId !== null) {
          const [previous] = await tx
            .select({ assessmentId: judgeObservations.assessmentId })
            .from(judgeObservations)
            .where(
              and(
                eq(judgeObservations.id, input.supersedesObservationId),
                eq(judgeObservations.projectId, input.projectId),
              ),
            );
          if (!previous) throw new InterviewTargetNotFoundError('observation_to_correct');
          if (previous.assessmentId !== input.assessmentId) {
            throw new InterviewTargetMismatchError(
              'the observation to correct belongs to a different assessment',
            );
          }
          const [next] = await tx
            .select({ id: judgeObservations.id })
            .from(judgeObservations)
            .where(eq(judgeObservations.supersedesObservationId, input.supersedesObservationId));
          if (next) throw new InterviewAlreadyCorrectedError(next.id);
        }

        const [inserted] = await tx
          .insert(judgeObservations)
          .values({
            projectId: input.projectId,
            assessmentId: input.assessmentId,
            questionSetId: input.questionSetId,
            questionId: input.questionId,
            teamAnswerId: input.teamAnswerId,
            subject: input.subject,
            observed: input.observed,
            outcome: input.outcome,
            recordedByActorId: input.actorId,
            recordedAsRole: input.role,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            supersedesObservationId: input.supersedesObservationId,
          })
          .onConflictDoNothing({
            target: [judgeObservations.recordedByActorId, judgeObservations.idempotencyKey],
          })
          .returning({ id: judgeObservations.id });
        if (!inserted) {
          const raced = await this.earlierObservation(tx, input);
          if (raced) return raced;
          throw new Error('interview observation insert produced no row and no earlier record');
        }
        await this.audit(tx, {
          actorId: input.actorId,
          entityType: 'judge_observation',
          entityId: inserted.id,
          action:
            input.supersedesObservationId === null
              ? 'interview.judge_observation_recorded'
              : 'interview.judge_observation_corrected',
          // identifiers and the state of the attempt only: never what was typed
          metadata: {
            projectId: input.projectId,
            assessmentId: input.assessmentId,
            outcome: input.outcome,
            role: input.role,
            ...(input.questionSetId === null ? {} : { questionSetId: input.questionSetId }),
            ...(input.questionId === null ? {} : { questionId: input.questionId }),
            ...(input.teamAnswerId === null ? {} : { teamAnswerId: input.teamAnswerId }),
            ...(input.supersedesObservationId === null
              ? {}
              : { supersedesObservationId: input.supersedesObservationId }),
          },
        });
        return { kind: 'created', id: inserted.id } as const;
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  // -- reading -------------------------------------------------------------------------------------------------------------------

  /** Every record of one assessment, oldest first (the order the interview happened in), with who recorded it and what corrected what. */
  async listForAssessment(
    projectId: string,
    assessmentId: string,
  ): Promise<Pick<InterviewRecordsResponse, 'teamAnswers' | 'judgeObservations'>> {
    const answerRows = await this.db
      .select({ row: teamAnswers, subject: actors.subject })
      .from(teamAnswers)
      .innerJoin(actors, eq(actors.id, teamAnswers.recordedByActorId))
      .where(and(eq(teamAnswers.projectId, projectId), eq(teamAnswers.assessmentId, assessmentId)))
      .orderBy(asc(teamAnswers.createdAt), asc(teamAnswers.id));
    const observationRows = await this.db
      .select({ row: judgeObservations, subject: actors.subject })
      .from(judgeObservations)
      .innerJoin(actors, eq(actors.id, judgeObservations.recordedByActorId))
      .where(
        and(
          eq(judgeObservations.projectId, projectId),
          eq(judgeObservations.assessmentId, assessmentId),
        ),
      )
      .orderBy(asc(judgeObservations.createdAt), asc(judgeObservations.id));

    const answerSuccessor = new Map<string, string>();
    for (const { row } of answerRows) {
      if (row.supersedesAnswerId !== null) answerSuccessor.set(row.supersedesAnswerId, row.id);
    }
    const observationSuccessor = new Map<string, string>();
    for (const { row } of observationRows) {
      if (row.supersedesObservationId !== null) {
        observationSuccessor.set(row.supersedesObservationId, row.id);
      }
    }
    return {
      teamAnswers: answerRows.map(({ row, subject }): TeamAnswerView => ({
        id: row.id,
        projectId: row.projectId,
        assessmentId: row.assessmentId,
        questionSetId: row.questionSetId,
        questionId: row.questionId,
        text: row.answerText,
        recordedAt: row.createdAt.toISOString(),
        recordedBy: { id: row.recordedByActorId, subject },
        recordedAsRole: row.recordedAsRole,
        supersedesAnswerId: row.supersedesAnswerId,
        supersededByAnswerId: answerSuccessor.get(row.id) ?? null,
        isCurrent: !answerSuccessor.has(row.id),
      })),
      judgeObservations: observationRows.map(({ row, subject }): JudgeObservationView => ({
        id: row.id,
        projectId: row.projectId,
        assessmentId: row.assessmentId,
        questionSetId: row.questionSetId,
        questionId: row.questionId,
        teamAnswerId: row.teamAnswerId,
        subject: row.subject,
        observed: row.observed,
        outcome: row.outcome,
        recordedAt: row.createdAt.toISOString(),
        recordedBy: { id: row.recordedByActorId, subject },
        recordedAsRole: row.recordedAsRole,
        supersedesObservationId: row.supersedesObservationId,
        supersededByObservationId: observationSuccessor.get(row.id) ?? null,
        isCurrent: !observationSuccessor.has(row.id),
      })),
    };
  }

  /** One team answer as a view (the record a write just returned), or null when it is not in the project. */
  async teamAnswerView(projectId: string, id: string): Promise<TeamAnswerView | null> {
    const [row] = await this.db
      .select({ assessmentId: teamAnswers.assessmentId })
      .from(teamAnswers)
      .where(and(eq(teamAnswers.id, id), eq(teamAnswers.projectId, projectId)));
    if (!row) return null;
    const all = await this.listForAssessment(projectId, row.assessmentId);
    return all.teamAnswers.find((a) => a.id === id) ?? null;
  }

  async judgeObservationView(projectId: string, id: string): Promise<JudgeObservationView | null> {
    const [row] = await this.db
      .select({ assessmentId: judgeObservations.assessmentId })
      .from(judgeObservations)
      .where(and(eq(judgeObservations.id, id), eq(judgeObservations.projectId, projectId)));
    if (!row) return null;
    const all = await this.listForAssessment(projectId, row.assessmentId);
    return all.judgeObservations.find((o) => o.id === id) ?? null;
  }

  // -- internals -----------------------------------------------------------------------------------------------------------------

  private async requireNotVoided(tx: Tx, projectId: string): Promise<void> {
    const [voided] = await tx
      .select({ id: projectVoids.projectId })
      .from(projectVoids)
      .where(eq(projectVoids.projectId, projectId));
    if (voided) throw new InterviewProjectVoidedError();
  }

  private async earlierAnswer(
    tx: Tx,
    input: Pick<RecordTeamAnswerInput, 'actorId' | 'idempotencyKey' | 'requestHash'>,
  ): Promise<RecordResult | null> {
    const [earlier] = await tx
      .select({ id: teamAnswers.id, requestHash: teamAnswers.requestHash })
      .from(teamAnswers)
      .where(
        and(
          eq(teamAnswers.recordedByActorId, input.actorId),
          eq(teamAnswers.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!earlier) return null;
    if (earlier.requestHash !== input.requestHash) throw new InterviewKeyReusedError();
    return { kind: 'replayed', id: earlier.id };
  }

  private async earlierObservation(
    tx: Tx,
    input: Pick<RecordJudgeObservationInput, 'actorId' | 'idempotencyKey' | 'requestHash'>,
  ): Promise<RecordResult | null> {
    const [earlier] = await tx
      .select({ id: judgeObservations.id, requestHash: judgeObservations.requestHash })
      .from(judgeObservations)
      .where(
        and(
          eq(judgeObservations.recordedByActorId, input.actorId),
          eq(judgeObservations.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!earlier) return null;
    if (earlier.requestHash !== input.requestHash) throw new InterviewKeyReusedError();
    return { kind: 'replayed', id: earlier.id };
  }

  private async audit(
    tx: Tx,
    input: {
      readonly actorId: string;
      readonly entityType: string;
      readonly entityId: string;
      readonly action: string;
      readonly metadata: Record<string, string>;
    },
  ): Promise<void> {
    const event = createAuditEvent(input);
    await tx.insert(auditEvents).values({
      id: event.id,
      actorId: event.actorId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      metadata: event.metadata,
      createdAt: event.createdAt,
    });
  }

  /** The database's own refusals, as the typed errors the caller understands. Anything else is not ours to interpret. */
  private translate(error: unknown): unknown {
    if (
      error instanceof InterviewTargetNotFoundError ||
      error instanceof InterviewTargetMismatchError ||
      error instanceof InterviewKeyReusedError ||
      error instanceof InterviewAlreadyCorrectedError ||
      error instanceof InterviewProjectVoidedError
    ) {
      return error;
    }
    if (isInterviewVoidRefusal(error)) return new InterviewProjectVoidedError();
    const facts = pgFactsOf(error);
    if (
      facts.some(
        (f) =>
          f.code === '23505' &&
          f.constraint !== undefined &&
          ONE_CORRECTION_CONSTRAINTS.has(f.constraint),
      )
    ) {
      // two corrections of the same record raced: exactly one row was written, and it is not this request's
      return new InterviewAlreadyCorrectedError(null);
    }
    return error;
  }
}
