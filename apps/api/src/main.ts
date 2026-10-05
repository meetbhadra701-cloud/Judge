import { createDevVerifier, createJwtVerifier } from '@judge-copilot/auth';
import { createReplayExtractor } from '@judge-copilot/context';
import { createDatabase } from '@judge-copilot/database';
import { createLogger, handleShutdownSignals } from '@judge-copilot/shared';
import { buildApp, SERVICE_NAME } from './app.js';
import { loadApiEnv } from './env.js';
import { EventContextService } from './event-context/service.js';
import { ProjectService } from './projects/service.js';
import { loadReplayRecordings } from './replay.js';

const env = loadApiEnv();
const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });

// No connection is opened until the first query.
const database = env.DATABASE_URL ? createDatabase(env.DATABASE_URL) : null;
if (!database) {
  logger.warn('DATABASE_URL is not set; Event Context routes will respond 503');
}

const extractor =
  env.EVENT_CONTEXT_EXTRACTOR === 'replay' && env.EVENT_CONTEXT_REPLAY_DIR
    ? createReplayExtractor(await loadReplayRecordings(env.EVENT_CONTEXT_REPLAY_DIR))
    : null;
if (extractor) {
  logger.warn({ extractor: extractor.name }, 'development replay extractor enabled');
}

const verifier =
  env.AUTH_MODE === 'jwt' && env.AUTH_JWT_ISSUER && env.AUTH_JWT_AUDIENCE && env.AUTH_JWKS_URL
    ? createJwtVerifier({
        issuer: env.AUTH_JWT_ISSUER,
        audience: env.AUTH_JWT_AUDIENCE,
        jwksUrl: env.AUTH_JWKS_URL,
        rolesClaim: env.AUTH_JWT_ROLES_CLAIM,
      })
    : env.AUTH_MODE === 'dev'
      ? createDevVerifier({ nodeEnv: env.NODE_ENV })
      : null;
if (env.AUTH_MODE === 'dev') {
  logger.warn('development authentication enabled (synthetic dev-organizer/dev-judge actors)');
} else if (!verifier && database) {
  logger.warn('AUTH_MODE is not configured; protected routes will respond 503');
}

const app = buildApp({
  logger,
  db: database?.db ?? null,
  verifier,
  eventContext: database ? new EventContextService({ db: database.db, extractor }) : null,
  projects: database ? new ProjectService({ db: database.db }) : null,
});

handleShutdownSignals(
  async () => {
    await app.close();
    await database?.close();
    logger.info('api stopped');
  },
  { logger },
);

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  logger.fatal({ err: error }, 'api failed to start');
  process.exitCode = 1;
  await app.close();
  await database?.close();
}
