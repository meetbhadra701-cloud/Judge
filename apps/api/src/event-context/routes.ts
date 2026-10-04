import {
  CreateContextVersionRequest,
  CreateEventRequest,
  EventSourceInput,
  UpdateEventContextRequest,
  Uuid,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import { parseRequest, type ApiApp } from '../http.js';
import type { EventContextService } from './service.js';

const EventParams = z.object({ eventId: Uuid });
const VersionParams = z.object({ eventId: Uuid, versionId: Uuid });

/** M1 Event Context Pack routes. No authentication exists yet; the API binds to loopback by default. */
export function registerEventContextRoutes(app: ApiApp, service: EventContextService): void {
  app.get('/events', async () => ({ events: await service.listEvents() }));

  app.post('/events', async (request, reply) =>
    reply
      .code(201)
      .send(await service.createEvent(parseRequest(CreateEventRequest, request.body, 'body'))),
  );

  app.get('/events/:eventId', async (request) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    return service.getEvent(eventId);
  });

  app.get('/events/:eventId/context', async (request) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    return service.getLockedContext(eventId);
  });

  app.post('/events/:eventId/context-versions', async (request, reply) => {
    const { eventId } = parseRequest(EventParams, request.params, 'params');
    const body = parseRequest(CreateContextVersionRequest, request.body, 'body');
    return reply.code(201).send(await service.createContextVersion(eventId, body));
  });

  app.get('/events/:eventId/context-versions/:versionId', async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return service.getContextVersion(eventId, versionId);
  });

  app.patch('/events/:eventId/context-versions/:versionId', async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    const body = parseRequest(UpdateEventContextRequest, request.body, 'body');
    return service.editContext(eventId, versionId, body);
  });

  app.get('/events/:eventId/context-versions/:versionId/sources', async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return { sources: await service.listSources(eventId, versionId) };
  });

  app.post('/events/:eventId/context-versions/:versionId/sources', async (request, reply) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    const body = parseRequest(EventSourceInput, request.body, 'body');
    return reply.code(201).send(await service.addSource(eventId, versionId, body));
  });

  app.post('/events/:eventId/context-versions/:versionId/build', async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return service.buildContext(eventId, versionId);
  });

  app.post('/events/:eventId/context-versions/:versionId/lock', async (request) => {
    const { eventId, versionId } = parseRequest(VersionParams, request.params, 'params');
    return service.lockContext(eventId, versionId);
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
