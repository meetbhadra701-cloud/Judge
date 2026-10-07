import {
  EVIDENCE_GRAPH_LIMITS,
  EvidenceKind,
  EvidenceOrigin,
  GraphNodeType,
  PageQuery,
  Uuid,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import type { Guard } from '../auth.js';
import { parseRequest, type ApiApp } from '../http.js';
import { EvidenceGraphApiError } from './errors.js';
import type { EvidenceGraphService } from './service.js';

const ProjectParams = z.object({ projectId: Uuid });
const ClaimParams = z.object({ projectId: Uuid, claimId: Uuid });
const EvidenceParams = z.object({ projectId: Uuid, evidenceId: Uuid });

const ClaimsQuery = PageQuery.extend({
  /** `true`: only claims that nothing supersedes. */
  current: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
const EvidenceQuery = PageQuery.extend({
  kind: EvidenceKind.optional(),
  origin: EvidenceOrigin.optional(),
});
const NeighborsQuery = z.object({
  type: GraphNodeType,
  id: Uuid,
  depth: z.coerce.number().int().min(0).max(EVIDENCE_GRAPH_LIMITS.traversalMaxDepth).default(1),
});

/**
 * M3 evidence graph routes: authenticated, READ-ONLY. There is deliberately no route that creates,
 * edits, deletes, scores, assesses, analyzes or ranks anything: the graph is written only by
 * trusted server code, and every non-GET method on these paths answers 405.
 */
export function registerEvidenceGraphRoutes(
  app: ApiApp,
  service: EvidenceGraphService,
  guard: Guard,
): void {
  const read = { preHandler: guard('evidence.read') };

  app.get('/projects/:projectId/evidence-graph', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.summary(projectId);
  });

  app.get('/projects/:projectId/evidence-graph/neighbors', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    const query = parseRequest(NeighborsQuery, request.query, 'query');
    return service.neighbors(projectId, { type: query.type, id: query.id }, query.depth);
  });

  app.get('/projects/:projectId/claims', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.listClaims(projectId, parseRequest(ClaimsQuery, request.query, 'query'));
  });

  app.get('/projects/:projectId/claims/:claimId', read, async (request) => {
    const { projectId, claimId } = parseRequest(ClaimParams, request.params, 'params');
    return service.getClaim(projectId, claimId);
  });

  app.get('/projects/:projectId/evidence', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.listEvidence(projectId, parseRequest(EvidenceQuery, request.query, 'query'));
  });

  app.get('/projects/:projectId/evidence/:evidenceId', read, async (request) => {
    const { projectId, evidenceId } = parseRequest(EvidenceParams, request.params, 'params');
    return service.getEvidence(projectId, evidenceId);
  });

  app.get('/projects/:projectId/unknowns', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.listUnknowns(projectId, parseRequest(PageQuery, request.query, 'query'));
  });

  app.get('/projects/:projectId/contradictions', read, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.listContradictions(projectId, parseRequest(PageQuery, request.query, 'query'));
  });

  // The graph is append-only history written by trusted code: explicit refusals, not silent 404s.
  for (const url of [
    '/projects/:projectId/evidence-graph',
    '/projects/:projectId/claims',
    '/projects/:projectId/claims/:claimId',
    '/projects/:projectId/evidence',
    '/projects/:projectId/evidence/:evidenceId',
    '/projects/:projectId/unknowns',
    '/projects/:projectId/contradictions',
  ]) {
    app.route({
      method: ['POST', 'PUT', 'PATCH', 'DELETE'],
      url,
      preHandler: guard('evidence.read'),
      handler: () => {
        throw new EvidenceGraphApiError(
          'GRAPH_READ_ONLY',
          'The evidence graph is read-only and immutable; it is written only by trusted server code',
        );
      },
    });
  }
}
