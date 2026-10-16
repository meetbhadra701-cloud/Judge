import { CreateQuestionSetRequest, QuestionSetParams, Uuid } from '@judge-copilot/schemas';
import { z } from 'zod';
import { actorOf, type Guard } from '../auth.js';
import { parseRequest, type ApiApp } from '../http.js';
import { QuestionApiError } from './errors.js';
import type { QuestionService } from './service.js';

const SetParams = z.object({ projectId: Uuid, setId: Uuid });

/**
 * M6 question routes. Authenticated; `question.read` for the GETs, `question.generate` for the POST. A question set is immutable and written only by trusted
 * server code: there is no route that edits, deletes, ranks or re-scores one, and every other method on these paths answers 405. The POST is idempotent
 * (the same assessment, policy, prompt and provider return the stored set with 200) and answers 201 for a set it just created.
 */
export function registerQuestionRoutes(app: ApiApp, service: QuestionService, guard: Guard): void {
  const read = { preHandler: guard('question.read') };

  app.get('/projects/:projectId/assessments/:assessmentId/question-sets', read, async (request) => {
    const { projectId, assessmentId } = parseRequest(QuestionSetParams, request.params, 'params');
    return service.list(projectId, assessmentId);
  });

  app.post(
    '/projects/:projectId/assessments/:assessmentId/question-sets',
    { preHandler: guard('question.generate') },
    async (request, reply) => {
      const { projectId, assessmentId } = parseRequest(QuestionSetParams, request.params, 'params');
      parseRequest(CreateQuestionSetRequest, request.body ?? {}, 'body');
      const outcome = await service.create(projectId, assessmentId, actorOf(request).id);
      return reply.code(outcome.result === 'created' ? 201 : 200).send(outcome);
    },
  );

  app.get('/projects/:projectId/question-sets/:setId', read, async (request) => {
    const { projectId, setId } = parseRequest(SetParams, request.params, 'params');
    return service.get(projectId, setId);
  });

  const refuse = () => {
    throw new QuestionApiError(
      'QUESTION_SET_READ_ONLY',
      'Question sets are immutable and written only by the question generator',
    );
  };
  app.route({
    method: ['PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments/:assessmentId/question-sets',
    preHandler: guard('question.read'),
    handler: refuse,
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/question-sets/:setId',
    preHandler: guard('question.read'),
    handler: refuse,
  });
}
