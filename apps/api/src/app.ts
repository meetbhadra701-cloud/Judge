import type { Logger } from '@judge-copilot/shared';
import Fastify from 'fastify';
import { installErrorHandling } from './errors.js';
import {
  registerEventContextRoutes,
  registerUnavailableEventContextRoutes,
} from './event-context/routes.js';
import type { EventContextService } from './event-context/service.js';
import type { ApiApp } from './http.js';

export const SERVICE_NAME = 'judge-copilot-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export interface BuildAppOptions {
  logger: Logger;
  /** Null when no database is configured. */
  eventContext?: EventContextService | null;
}

/**
 * Builds the API without binding a port, so tests can exercise it in-process with `inject`.
 * `/health` is a liveness check that never touches the database or any external service.
 */
export function buildApp({ logger, eventContext = null }: BuildAppOptions): ApiApp {
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

  if (eventContext) {
    registerEventContextRoutes(app, eventContext);
  } else {
    registerUnavailableEventContextRoutes(app);
  }

  return app;
}

export type { ApiApp };
