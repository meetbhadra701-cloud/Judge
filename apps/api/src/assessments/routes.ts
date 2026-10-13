import { CreateAssessmentRequest, IdempotencyKey, Uuid } from '@judge-copilot/schemas';
import { z } from 'zod';
import { actorOf, type Guard } from '../auth.js';
import { parseRequest, RequestValidationError, type ApiApp } from '../http.js';
import { AssessmentApiError } from './errors.js';
import type { AssessmentService } from './service.js';

const ProjectParams = z.object({ projectId: Uuid });
const AssessmentParams = z.object({ projectId: Uuid, assessmentId: Uuid });
const RunParams = z.object({ projectId: Uuid, runId: Uuid });

function idempotencyKeyOf(headers: Record<string, unknown>): string {
  const raw = headers['idempotency-key'];
  const parsed = IdempotencyKey.safeParse(typeof raw === 'string' ? raw.trim() : undefined);
  if (!parsed.success) {
    throw new RequestValidationError('headers', [
      { path: 'idempotency-key', message: 'A UUID Idempotency-Key header is required' },
    ]);
  }
  // identifiers differing only by case are the same key
  return parsed.data.toLowerCase();
}

/**
 * M5 P6A assessment routes (design §10.2). Authenticated; `assessment.read` for the three GETs, `assessment.run` for the POST.
 * There is no route that edits, deletes, ranks or re-scores an assessment: every other method on these paths answers 405.
 * The POST only creates a pending run; the worker does the work, and with no approved offline provider it answers 503.
 */
export function registerAssessmentRoutes(
  app: ApiApp,
  service: AssessmentService,
  guard: Guard,
): void {
  const read = { preHandler: guard('assessment.read') };

  app.post(
    '/projects/:projectId/assessments',
    { preHandler: guard('assessment.run') },
    async (request, reply) => {
      const { projectId } = parseRequest(ProjectParams, request.params, 'params');
      const key = idempotencyKeyOf(request.headers);
      const body = parseRequest(CreateAssessmentRequest, request.body, 'body');
      const outcome = await service.request(projectId, actorOf(request).id, key, body);
      return reply.code(outcome.status).send(outcome.body);
    },
  );

  app.get('/projects/:projectId/assessments', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.list(projectId);
  });

  app.get('/projects/:projectId/assessments/:assessmentId', read, async (request) => {
    const { projectId, assessmentId } = parseRequest(AssessmentParams, request.params, 'params');
    return service.get(projectId, assessmentId);
  });

  app.get('/projects/:projectId/assessments/:assessmentId/unknowns', read, async (request) => {
    const { projectId, assessmentId } = parseRequest(AssessmentParams, request.params, 'params');
    return service.getUnknowns(projectId, assessmentId);
  });

  app.get('/projects/:projectId/assessment-runs/:runId', read, async (request) => {
    const { projectId, runId } = parseRequest(RunParams, request.params, 'params');
    return service.getRun(projectId, runId);
  });

  // Assessments are immutable AI estimates written only by trusted server code: explicit refusals, not silent 404s.
  const refuse = () => {
    throw new AssessmentApiError(
      'ASSESSMENT_READ_ONLY',
      'Assessments are immutable and written only by the assessment worker',
    );
  };
  app.route({
    method: ['PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments',
    preHandler: guard('assessment.read'),
    handler: refuse,
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments/:assessmentId',
    preHandler: guard('assessment.read'),
    handler: refuse,
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessments/:assessmentId/unknowns',
    preHandler: guard('assessment.read'),
    handler: refuse,
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessment-runs',
    preHandler: guard('assessment.read'),
    handler: refuse,
  });
  app.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/projects/:projectId/assessment-runs/:runId',
    preHandler: guard('assessment.read'),
    handler: refuse,
  });
}
