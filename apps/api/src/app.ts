import type { Logger } from '@judge-copilot/shared';
import Fastify from 'fastify';

export const SERVICE_NAME = 'judge-copilot-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

/**
 * Builds the API without binding a port, so tests can exercise it in-process with `inject`.
 * M0 exposes only a liveness check; it does not touch the database or any external service.
 */
export function buildApp({ logger }: { logger: Logger }) {
  const app = Fastify({ loggerInstance: logger });

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

  return app;
}

export type ApiApp = ReturnType<typeof buildApp>;
