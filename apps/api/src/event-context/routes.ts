import {
  BuildEventContextRequest,
  CreateContextVersionRequest,
  CreateEventRequest,
  EventSourceInput,
  UpdateEventContextRequest,
  Uuid,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import { actorOf, type Guard } from '../auth.js';
import { parseRequest, type ApiApp } from '../http.js';
import type { EventContextService } from './service.js';

const EventParams = z.object({ eventId: Uuid });
const VersionParams = z.object({ eventId: Uuid, versionId: Uuid });

/**
 * M1 Event Context Pack routes. Since M2 every route requires an authenticated actor: organizers
 * read and write, judges only read. Writes are audited with the actor's id.
 */
export function registerEventContextRoutes(
  app: ApiApp,
  service: EventContextService,
  guard: Guard,
): void {
  const read = { preHandler: guard('event_context.read') };
  const write = { preHandler: guard('event_context.write') };
  const as = (request: Parameters<typeof actorOf>[0]) => service.forActor(actorOf(request).id);

  app.get('/events', read, async () => ({ events: await service.listEvents() }));

  app.post('/events', write, async (request, reply) =>
    reply
      .code(201)
      .send(await as(request).createEvent(parseRequest(CreateEventRequest, request.body, 'body'))),
  );

  app.get('/events/:eventId', read, async (request) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    return service.getEvent(eventId);
  });

  app.get('/events/:eventId/context', read, async (request) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    return service.getLockedContext(eventId);
  });

  app.post('/events/:eventId/context-versions', write, async (request, reply) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    const body = parseRequest(CreateContextVersionRequest, request.body, 'body');
    return reply.code(201).send(await as(request).createContextVersion(eventId, body));
  });

  app.get('/events/:eventId/context-versions/:versionId', read, async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return service.getContextVersion(eventId, versionId);
  });

  app.patch('/events/:eventId/context-versions/:versionId', write, async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    const body = parseRequest(UpdateEventContextRequest, request.body, 'body');
    return as(request).editContext(eventId, versionId, body);
  });

  app.get('/events/:eventId/context-versions/:versionId/sources', read, async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return { sources: await service.listSources(eventId, versionId) };
  });

  app.post(
    '/events/:eventId/context-versions/:versionId/sources',
    write,
    async (request, reply) => {
      const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
      const body = parseRequest(EventSourceInput, request.body, 'body');
      return reply.code(201).send(await as(request).addSource(eventId, versionId, body));
    },
  );

  app.post('/events/:eventId/context-versions/:versionId/build', write, async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    const body = parseRequest(BuildEventContextRequest, request.body, 'body');
    return as(request).buildContext(eventId, versionId, {
      replaceHumanEdits: body.replaceHumanEdits,
    });
  });

  app.post('/events/:eventId/context-versions/:versionId/lock', write, async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return as(request).lockContext(eventId, versionId);
  });
}

/** Registered instead when no database is configured, so clients get a clear 503. */
export function registerUnavailableEventContextRoutes(app: ApiApp): void {
  for (const path of ['/events', '/events/*']) {
    app.all(path, (_request, reply) =>
      reply.code(503).send({
        error: {
          code: 'DATABASE_NOT_CONFIGURED',
          message: 'Event Context routes require DATABASE_URL',
        },
      }),
    );
  }
}
