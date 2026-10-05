import type { AuthVerifier } from '@judge-copilot/domain';
import type { JudgeDatabase } from '@judge-copilot/database';
import type { Logger } from '@judge-copilot/shared';
import Fastify from 'fastify';
import { ActorDirectory, actorOf, createGuard } from './auth.js';
import { installErrorHandling } from './errors.js';
import {
  registerEventContextRoutes,
  registerUnavailableEventContextRoutes,
} from './event-context/routes.js';
import type { EventContextService } from './event-context/service.js';
import type { ApiApp } from './http.js';
import { registerProjectRoutes, registerUnavailableProjectRoutes } from './projects/routes.js';
import type { ProjectService } from './projects/service.js';

export const SERVICE_NAME = 'judge-copilot-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export interface BuildAppOptions {
  logger: Logger;
  /** Null when no database is configured. */
  eventContext?: EventContextService | null;
  /** Null when no database is configured. */
  projects?: ProjectService | null;
  /** Database used to record authenticated actors (required whenever services are present). */
  db?: JudgeDatabase | null;
  /** Null when authentication is not configured: every protected route then answers 503. */
  verifier?: AuthVerifier | null;
}

/**
 * Builds the API without binding a port, so tests can exercise it in-process with `inject`.
 * `/health` is a liveness check that never touches the database or any external service.
 */
export function buildApp({
  logger,
  eventContext = null,
  projects = null,
  db = null,
  verifier = null,
}: BuildAppOptions): ApiApp {
  const app: ApiApp = Fastify({ loggerInstance: logger, bodyLimit: 1024 * 1024 });
  installErrorHandling(app);

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'service'],
            properties: {
              status: { type: 'string', const: 'ok' },
              service: { type: 'string', const: SERVICE_NAME },
            },
          },
        },
      },
    },
    (): HealthResponse => ({ status: 'ok', service: SERVICE_NAME }),
  );

  if (db && (eventContext || projects)) {
    const guard = createGuard({ verifier, directory: new ActorDirectory(db) });
    app.get('/me', { preHandler: guard('project.read') }, (request) => ({
      actor: actorOf(request),
    }));
    if (eventContext) registerEventContextRoutes(app, eventContext, guard);
    else registerUnavailableEventContextRoutes(app);
    if (projects) registerProjectRoutes(app, projects, guard);
    else registerUnavailableProjectRoutes(app);
  } else {
    registerUnavailableEventContextRoutes(app);
    registerUnavailableProjectRoutes(app);
  }

  return app;
}

export type { ApiApp };
