import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  InterviewAlreadyCorrectedError,
  InterviewKeyReusedError,
  InterviewProjectVoidedError,
  InterviewStore,
  InterviewTargetMismatchError,
  InterviewTargetNotFoundError,
  QuestionInputReader,
  QuestionSetStore,
  AssessmentReadStore,
  type JudgeDatabase,
} from '@judge-copilot/database';
import {
  INTERVIEW_IMMUTABLE_NOTICE,
  INTERVIEW_OBSERVATION_NOTICE,
  INTERVIEW_TESTIMONY_NOTICE,
  type InterviewRecordsResponse,
  type RecordJudgeObservationRequest,
  type RecordJudgeObservationResponse,
  type RecordTeamAnswerRequest,
  type RecordTeamAnswerResponse,
  type RecorderRole,
} from '@judge-copilot/schemas';
import type { AuthenticatedActor } from '../auth.js';
import { InterviewApiError } from './errors.js';

export interface InterviewServiceOptions {
  readonly db: JudgeDatabase;
}

/** The role the credential is recorded under: `judge` whenever the identity holds it, else `organizer`. (The route's permission check already admitted it.) */
export function recorderRoleOf(actor: Pick<AuthenticatedActor, 'roles'>): RecorderRole {
  return actor.roles.includes('judge') ? 'judge' : 'organizer';
}

const requestHashOf = (value: unknown): string => sha256Hex(canonicalJson(value));

/**
 * Recording and reading the interview (M7): the team's answers to suggested questions and the judge's own observations. Every write is for ONE verified
 * pre-interview assessment of ONE project; the actor and the role come from the authenticated credential, never from the request; every identifier in a request is
 * resolved inside the project in the URL (an object of another project is reported exactly like a nonexistent one). Nothing here calls a model, reads a score or
 * changes an assessment, a question set or the evidence graph: the records are testimony and the judge's own report, kept as immutable history.
 */
export class InterviewService {
  private readonly store: InterviewStore;
  private readonly sets: QuestionSetStore;
  private readonly reader: QuestionInputReader;
  private readonly reads: AssessmentReadStore;

  constructor(options: InterviewServiceOptions) {
    this.store = new InterviewStore(options.db);
    this.sets = new QuestionSetStore(options.db);
    this.reader = new QuestionInputReader(options.db);
    this.reads = new AssessmentReadStore(options.db);
  }

  private async requireProject(projectId: string): Promise<void> {
    if (!(await this.reads.projectExists(projectId))) {
      throw new InterviewApiError('PROJECT_NOT_FOUND', 'Project not found');
    }
  }

  async list(projectId: string, assessmentId: string): Promise<InterviewRecordsResponse> {
    await this.requireProject(projectId);
    if (!(await this.store.assessmentExists(projectId, assessmentId))) {
      throw new InterviewApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    }
    const verified = (await this.reader.read(projectId, assessmentId)).kind === 'ready';
    const voided = await this.store.projectVoided(projectId);
    // FAIL CLOSED, like the assessment and its question sets: a record is shown only beside an assessment that still verifies
    const records = verified
      ? await this.store.listForAssessment(projectId, assessmentId)
      : { teamAnswers: [], judgeObservations: [] };
    return {
      projectId,
      assessmentId,
      assessmentVerified: verified,
      voided,
      ...records,
      notices: {
        testimony: INTERVIEW_TESTIMONY_NOTICE,
        observation: INTERVIEW_OBSERVATION_NOTICE,
        immutable: INTERVIEW_IMMUTABLE_NOTICE,
        scores: 'interview_records_never_change_scores',
      },
    };
  }

  async recordTeamAnswer(
    projectId: string,
    setId: string,
    questionId: string,
    body: RecordTeamAnswerRequest,
    actor: AuthenticatedActor,
    idempotencyKey: string,
  ): Promise<RecordTeamAnswerResponse> {
    await this.requireProject(projectId);
    // the set (and so the assessment) is resolved INSIDE the project; a set of another project is a 404, and a set whose assessment no longer verifies takes no record
    const set = await this.sets.getView(projectId, setId);
    if (!set) throw new InterviewApiError('QUESTION_SET_NOT_FOUND', 'Question set not found');
    if (!set.assessmentVerified) {
      throw new InterviewApiError(
        'ASSESSMENT_NOT_VERIFIED',
        'This assessment did not pass verification, so no interview record can be added to it',
      );
    }
    if (!set.questions.some((q) => q.id === questionId)) {
      throw new InterviewApiError('QUESTION_NOT_FOUND', 'Question not found in this question set');
    }
    try {
      const result = await this.store.recordTeamAnswer({
        projectId,
        setId,
        questionId,
        text: body.text,
        supersedesAnswerId: body.supersedesAnswerId ?? null,
        actorId: actor.id,
        role: recorderRoleOf(actor),
        idempotencyKey,
        requestHash: requestHashOf({
          kind: 'team_answer',
          projectId,
          setId,
          questionId,
          text: body.text,
          supersedes: body.supersedesAnswerId ?? null,
        }),
      });
      const view = await this.store.teamAnswerView(projectId, result.id);
      if (!view) throw new InterviewApiError('INTERVIEW_RECORD_NOT_FOUND', 'Record not found');
      return { result: result.kind, teamAnswer: view };
    } catch (error) {
      throw this.translate(error);
    }
  }

  async recordJudgeObservation(
    projectId: string,
    assessmentId: string,
    body: RecordJudgeObservationRequest,
    actor: AuthenticatedActor,
    idempotencyKey: string,
  ): Promise<RecordJudgeObservationResponse> {
    await this.requireProject(projectId);
    if (!(await this.store.assessmentExists(projectId, assessmentId))) {
      throw new InterviewApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
    }
    if ((await this.reader.read(projectId, assessmentId)).kind !== 'ready') {
      throw new InterviewApiError(
        'ASSESSMENT_NOT_VERIFIED',
        'This assessment did not pass verification, so no interview record can be added to it',
      );
    }
    try {
      const result = await this.store.recordJudgeObservation({
        projectId,
        assessmentId,
        questionSetId: body.questionSetId ?? null,
        questionId: body.questionId ?? null,
        teamAnswerId: body.teamAnswerId ?? null,
        subject: body.subject,
        observed: body.observed,
        outcome: body.outcome,
        supersedesObservationId: body.supersedesObservationId ?? null,
        actorId: actor.id,
        role: recorderRoleOf(actor),
        idempotencyKey,
        requestHash: requestHashOf({
          kind: 'judge_observation',
          projectId,
          assessmentId,
          questionSetId: body.questionSetId ?? null,
          questionId: body.questionId ?? null,
          teamAnswerId: body.teamAnswerId ?? null,
          subject: body.subject,
          observed: body.observed,
          outcome: body.outcome,
          supersedes: body.supersedesObservationId ?? null,
        }),
      });
      const view = await this.store.judgeObservationView(projectId, result.id);
      if (!view) throw new InterviewApiError('INTERVIEW_RECORD_NOT_FOUND', 'Record not found');
      return { result: result.kind, judgeObservation: view };
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** The store's typed refusals as the API's typed errors. Messages are fixed text: nothing a client typed is ever echoed. */
  private translate(error: unknown): unknown {
    if (error instanceof InterviewApiError) return error;
    if (error instanceof InterviewProjectVoidedError) {
      return new InterviewApiError(
        'PROJECT_VOIDED',
        'This project was voided by an organizer, so no new interview record can be added. Its interview history stays readable',
      );
    }
    if (error instanceof InterviewKeyReusedError) {
      return new InterviewApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different record',
      );
    }
    if (error instanceof InterviewAlreadyCorrectedError) {
      return new InterviewApiError(
        'INTERVIEW_ALREADY_CORRECTED',
        'That record has already been corrected; correct the newest record of the chain instead',
        error.supersededById === null ? {} : { supersededById: error.supersededById },
      );
    }
    if (error instanceof InterviewTargetMismatchError) {
      return new InterviewApiError(
        'INTERVIEW_TARGET_MISMATCH',
        'The records named in this request do not belong together',
        { relation: error.relation },
      );
    }
    if (error instanceof InterviewTargetNotFoundError) {
      switch (error.target) {
        case 'assessment':
          return new InterviewApiError('ASSESSMENT_NOT_FOUND', 'Assessment not found');
        case 'question_set':
          return new InterviewApiError('QUESTION_SET_NOT_FOUND', 'Question set not found');
        case 'question':
          return new InterviewApiError(
            'QUESTION_NOT_FOUND',
            'Question not found in this question set',
          );
        default:
          return new InterviewApiError('INTERVIEW_RECORD_NOT_FOUND', 'Record not found');
      }
    }
    return error;
  }
}
