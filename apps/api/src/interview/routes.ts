import {
  IdempotencyKey,
  InterviewParams,
  RecordJudgeObservationParams,
  RecordJudgeObservationRequest,
  RecordTeamAnswerParams,
  RecordTeamAnswerRequest,
} from '@judge-copilot/schemas';
import { actorOf, type Guard } from '../auth.js';
import { parseRequest, RequestValidationError, type ApiApp } from '../http.js';
import { InterviewApiError } from './errors.js';
import type { InterviewService } from './service.js';

/** `Idempotency-Key`: a UUID. Required: a record without a stable request identity could not be retried without the risk of saving it twice. */
function idempotencyKeyOf(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key'];
  const parsed = IdempotencyKey.safeParse(typeof raw === 'string' ? raw.trim() : undefined);
  if (!parsed.success) {
    throw new RequestValidationError('headers', [
      { path: 'idempotency-key', message: 'A UUID Idempotency-Key header is required' },
    ]);
  }
  return parsed.data;
}

/**
 * M7 interview routes. Authenticated; `interview.read` for the GET, `interview.record` for the two POSTs. A record is immutable and there is no route that edits or
 * deletes one (every other method on these paths answers 405): a correction is another POST that names the record it replaces. The actor and the role come from the
 * credential, and the body is strict, so a client cannot name them. A POST answers 201 for a record it just created and 200 for the replay of a request it already
 * saved (the same Idempotency-Key and content).
 */
export function registerInterviewRoutes(
  app: ApiApp,
  service: InterviewService,
  guard: Guard,
): void {
  const read = { preHandler: guard('interview.read') };
  const record = { preHandler: guard('interview.record') };

  app.get('/projects/:projectId/assessments/:assessmentId/interview', read, async (request) => {
    const { projectId, assessmentId } = parseRequest(InterviewParams, request.params, 'params');
    return service.list(projectId, assessmentId);
  });

  app.post(
    '/projects/:projectId/question-sets/:setId/questions/:questionId/team-answers',
    record,
    async (request, reply) => {
      const { projectId, setId, questionId } = parseRequest(
        RecordTeamAnswerParams,
        request.params,
        'params',
      );
      const key = idempotencyKeyOf(request.headers);
      const body = parseRequest(RecordTeamAnswerRequest, request.body, 'body');
      const outcome = await service.recordTeamAnswer(
        projectId,
        setId,
        questionId,
        body,
        actorOf(request),
        key,
      );
      return reply.code(outcome.result === 'created' ? 201 : 200).send(outcome);
    },
  );

  app.post(
    '/projects/:projectId/assessments/:assessmentId/judge-observations',
    record,
    async (request, reply) => {
      const { projectId, assessmentId } = parseRequest(
        RecordJudgeObservationParams,
        request.params,
        'params',
      );
      const key = idempotencyKeyOf(request.headers);
      const body = parseRequest(RecordJudgeObservationRequest, request.body, 'body');
      const outcome = await service.recordJudgeObservation(
        projectId,
        assessmentId,
        body,
        actorOf(request),
        key,
      );
      return reply.code(outcome.result === 'created' ? 201 : 200).send(outcome);
    },
  );

  const refuse = () => {
    throw new InterviewApiError(
      'INTERVIEW_RECORDS_IMMUTABLE',
      'Interview records are immutable: a correction is a new record that names the one it replaces',
    );
  };
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments/:assessmentId/interview',
    preHandler: guard('interview.read'),
    handler: refuse,
  });
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/question-sets/:setId/questions/:questionId/team-answers',
    preHandler: guard('interview.read'),
    handler: refuse,
  });
  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments/:assessmentId/judge-observations',
    preHandler: guard('interview.read'),
    handler: refuse,
  });
}
