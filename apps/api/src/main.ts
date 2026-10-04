import { createLogger, handleShutdownSignals } from '@judge-copilot/shared';
import { buildApp, SERVICE_NAME } from './app.js';
import { loadApiEnv } from './env.js';

const env = loadApiEnv();
const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });
const app = buildApp({ logger });

handleShutdownSignals(
  async () => {
    await app.close();
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
}
