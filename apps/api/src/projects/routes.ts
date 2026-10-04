import { AddProjectSourceRequest, CreateProjectRequest, Uuid } from '@judge-copilot/schemas';
import { z } from 'zod';
import { actorOf, type Guard } from '../auth.js';
import { parseRequest, type ApiApp } from '../http.js';
import { SourceIngestionError } from './errors.js';
import type { ProjectService } from './service.js';

const EventParams = z.object({ eventId: Uuid });
const ProjectParams = z.object({ projectId: Uuid });
const SourceParams = z.object({ projectId: Uuid, sourceId: Uuid });
const SnapshotParams = z.object({ projectId: Uuid, snapshotId: Uuid });
const ArtifactParams = z.object({ projectId: Uuid, snapshotId: Uuid, artifactId: Uuid });

/**
 * M2 project and source-snapshot routes. Every route requires an authenticated actor. There is no
 * route that edits or deletes a source or snapshot: such attempts are answered explicitly, and
 * there are no score, evidence, analysis or AI routes.
 */
export function registerProjectRoutes(app: ApiApp, service: ProjectService, guard: Guard): void {
  app.post(
    '/events/:eventId/projects',
    { preHandler: guard('project.write') },
    async (request, reply) => {
      const { eventId } = parseRequest(EventParams, request.params, 'params');
      const body = parseRequest(CreateProjectRequest, request.body, 'body');
      return reply.code(201).send(await service.createProject(eventId, body, actorOf(request).id));
    },
  );

  app.get('/events/:eventId/projects', { preHandler: guard('project.read') }, async (request) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    return { projects: await service.listProjects(eventId) };
  });

  app.get('/projects/:projectId', { preHandler: guard('project.read') }, async (request) => {
    const { projectId } = parseRequest(ProjectParams, request.params, 'params');
    return service.getProject(projectId);
  });

  app.post(
    '/projects/:projectId/sources',
    { preHandler: guard('project.write') },
    async (request, reply) => {
      const { projectId } = parseRequest(ProjectParams, request.params, 'params');
      const body = parseRequest(AddProjectSourceRequest, request.body, 'body');
      return reply.code(201).send(await service.addSource(projectId, body, actorOf(request).id));
    },
  );

  app.get(
    '/projects/:projectId/sources',
    { preHandler: guard('project.read') },
    async (request) => {
      const { projectId } = parseRequest(ProjectParams, request.params, 'params');
      return { sources: await service.listSources(projectId) };
    },
  );

  app.post(
    '/projects/:projectId/sources/:sourceId/captures',
    { preHandler: guard('source.capture') },
    async (request, reply) => {
      const { projectId, sourceId } = parseRequest(SourceParams, request.params, 'params');
      return reply
        .code(202)
        .send(await service.requestCapture(projectId, sourceId, actorOf(request).id));
    },
  );

  app.post(
    '/projects/:projectId/captures',
    { preHandler: guard('source.capture') },
    async (request, reply) => {
      const { projectId } = parseRequest(ProjectParams, request.params, 'params');
      return reply.code(202).send(await service.requestAllCaptures(projectId, actorOf(request).id));
    },
  );

  app.get(
    '/projects/:projectId/snapshots',
    { preHandler: guard('project.read') },
    async (request) => {
      const { projectId } = parseRequest(ProjectParams, request.params, 'params');
      return { snapshots: await service.listSnapshots(projectId) };
    },
  );

  app.get(
    '/projects/:projectId/snapshots/:snapshotId',
    { preHandler: guard('project.read') },
    async (request) => {
      const { projectId, snapshotId } = parseRequest(SnapshotParams, request.params, 'params');
      return service.getSnapshot(projectId, snapshotId);
    },
  );

  app.get(
    '/projects/:projectId/snapshots/:snapshotId/artifacts/:artifactId',
    { preHandler: guard('project.read') },
    async (request) => {
      const { projectId, snapshotId, artifactId } = parseRequest(
        ArtifactParams,
        request.params,
        'params',
      );
      return service.getArtifact(projectId, snapshotId, artifactId);
    },
  );

  // Snapshots and declarations are immutable: explicit refusals instead of silent 404s.
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    app.route({
      method,
      url: '/projects/:projectId/snapshots/:snapshotId',
      preHandler: guard('project.read'),
      handler: () => {
        throw new SourceIngestionError(
          'SNAPSHOT_IMMUTABLE',
          'Snapshots are immutable; request a new capture instead',
        );
      },
    });
    app.route({
      method,
      url: '/projects/:projectId/sources/:sourceId',
      preHandler: guard('project.read'),
      handler: () => {
        throw new SourceIngestionError(
          'SOURCE_IMMUTABLE',
          'Source declarations are immutable; declare a new source instead',
        );
      },
    });
  }
}

/** Registered instead when no database is configured. */
export function registerUnavailableProjectRoutes(app: ApiApp): void {
  app.all('/projects/*', (_request, reply) =>
    reply.code(503).send({
      error: { code: 'DATABASE_NOT_CONFIGURED', message: 'DATABASE_URL is not configured' },
    }),
  );
}
